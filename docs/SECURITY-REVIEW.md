# Application security review

Run 2026-09-03 against a live instance. `scripts/pen-probe.mjs` — 31 probes,
all passing after one fix.

**2026-09-24: sign-in moved from Keycloak into Oolix itself, with no second
factor.** That departs from the specification in three places; the
[last section](#sign-in-moved-into-oolix--2026-09-24) records where, what
compensates, and what should happen before a pilot relies on it.

**This is not a penetration test by someone who does it for a living, and it
does not replace one.** It is the part that can be automated and repeated: the
checks that must never regress, sent from outside with no credentials and no
cooperation from the application. The existing test suite asserts the product
does what it should; these assert it *refuses* what it should.

```sh
node scripts/pen-probe.mjs --base http://127.0.0.1:4000
```

Only run it against an instance you are authorised to test — it sends
deliberately hostile requests. It exits non-zero on any critical or high
finding, so it can gate a release.

## What is checked

| Area | Probes | Why this one |
| --- | ---: | --- |
| Anonymous access to protected routes | 10 | The usual way an authorisation model develops a hole is a route added without its guard |
| Forged bearer tokens, including `alg:none` | 3 | The classic JWT bypass |
| Private key material in the published JWKS | 1 | One leaked `d` lets anyone sign a manifest every Agent will believe |
| Stack traces and internals in error bodies | 3 | Reconnaissance that makes the next attempt cheaper |
| SQL injection reaching a query | 4 | Prisma parameterises, but the codebase does contain raw SQL |
| CORS reflecting an arbitrary origin | 1 | Permissive ACAO plus credentials lets any site read a signed-in user's data |
| Unauthenticated flood control | 1 | See the finding below |
| Oversized request bodies | 1 | Memory pressure as a denial of service |
| Per-person identifiers in any response | 4 | The product's central claim |
| `TRACE` / `TRACK` | 2 | Cross-Site Tracing turns an HttpOnly cookie into a readable one |
| Framework and version disclosure | 1 | Free reconnaissance |

## The finding

**Unauthenticated traffic was not rate limited at all.** 150 anonymous requests
in a burst drew no `429` and no rate-limit headers whatsoever.

The cause was ordering, not omission. `AuthGuard` is registered before
`RateLimitGuard`, so a request that never authenticates is rejected before the
limiter ever runs. Every per-principal budget in §94 was working exactly as
designed and none of them applied, because an anonymous caller has no
principal. Credential stuffing against the token endpoint, or simply flooding
the connection pool with 401s, was unbounded.

Reordering the two guards would have traded one problem for another: the
limiter needs the principal to apply per-user and per-organization budgets, so
running it first would collapse §94 to a per-IP rule for everybody.

The fix is a coarse outer bound instead — `IpRateLimitGuard`, registered
*before* authentication, limiting by client IP at 600 requests per minute. The
per-principal limits are untouched and remain the real policy. The new bound is
deliberately generous: it is a flood guard, not a quota, and it has to sit well
above what a legitimate office behind one NAT address would use.

Verified both directions:

- 700 anonymous requests → exactly **600 × 401, 100 × 429**
- 200 requests to `/healthz` → **200 × 200**, still exempt, because an
  orchestrator polling liveness from every node must never be throttled out of
  rotation

It honours `trustProxy`, so behind the TLS terminator the bucket is keyed to
the real client rather than the proxy's own address — without that, the whole
deployment would share one bucket.

## A probe that could not fail

The first version of the flood probe sent 150 requests and reported a pass —
not because anything was limited, but because it never reached the bound. It
now sends 700, above the documented 600.

The `TRACE`/`TRACK` probes had the mirror-image problem: `fetch` refuses to
send those methods at all, so they reported a failure that described the probe
rather than the server. They now use a raw socket. A test that cannot pass is
as useless as one that cannot fail, and both train people to ignore the report.

## What this does not cover

**Cross-organization access (IDOR).** Now covered — `pnpm probe:authed`,
16 probes, run from OUTSIDE the application with real tokens and real
identifiers pulled from the database.

The question it asks is the realistic breach: not what a stranger can reach,
but what somebody can reach who holds a perfectly good token for a *different*
organization. A real Buyer, a real Partner, or a stolen session, walking
sideways.

| Attempt | Result |
| --- | --- |
| Partner B reads Partner A's segment | refused |
| Partner B claims Partner A's org id in a header | refused |
| Partner B reads, or **approves**, Partner A's request | refused |
| Partner B revokes Partner A's Agent | refused |
| A Buyer lists Partner segments or policies | refused |
| A Buyer mints a Partner Agent bootstrap token | refused |
| A Buyer switches context to a Partner they do not belong to | refused |
| A Partner reads or edits the Buyer's campaign | refused |
| A Partner reads the Buyer's invoices | refused |
| A campaign approver mints a token or edits policy (§66) | refused |
| Any authenticated surface returns a customer identifier | none found |

The integration suite asserts the same isolation from inside the application
with its own helpers, which shares assumptions with the code under test. This
does not.

One probe of mine was wrong first: it flagged the caller's own email address in
`/v1/me/context` as a per-person leak. That is the signed-in operator's own
account, which the portal needs to show who is signed in; §54/§73 is about the
Data Partner's *customers*. Narrowed, because a false finding trains people to
ignore the report.

**Everything a real engagement brings**: business-logic abuse, the approval
workflow as an adversary would use it, session fixation, the portal's client
side, dependency and supply-chain review, and the deployment itself. A pilot
carrying a real Partner's approvals should have one before it carries a second.

## Sign-in moved into Oolix — 2026-09-24

Keycloak is gone. The API now handles sign-up, sign-in, sessions, email
confirmation, invitations and password reset itself, and there is no second
factor. The product owner decided this before the first demo, to run one
service instead of two: no identity server, no second database, no admin
console and no `auth.` hostname to operate. The last Keycloak version is tagged
`keycloak-final`.

### Where this departs from the specification

| Spec | What it asks | What Oolix does now |
| --- | --- | --- |
| §64 | Identity delegated to an OIDC provider, so Oolix never sees a password | The API receives passwords and checks them against its own hashes, and signs its own tokens |
| §4.2, §82 | A second factor for PARTNER_ADMIN, PARTNER_SECURITY_ADMIN, PARTNER_CAMPAIGN_APPROVER, FINANCE, BUYER_ADMIN and OOLIX_ADMIN | Nobody has one. A stolen password is a stolen account |
| §87 | Sign-in and MFA penetration tested before real traffic | The in-house sign-in has had the automated review below and nothing more |

These were accepted knowingly, for a demo. **Before a pilot carries a real
Partner's approvals:** add a second factor (an authenticator app, at least for
the roles above) and have the sign-in flow independently tested.

### What compensates

| Threat | Control | Where |
| --- | --- | --- |
| A stolen password database | scrypt (N=2^15, r=8, p=3, 16-byte salt); parameters stored in each hash, so raising them re-hashes at the next sign-in | `packages/auth-rbac/src/password.ts` |
| Weak or leaked passwords | 12–128 characters, no composition rules (NIST 800-63B); refused if built from the email address, too repetitive, one of 1,197 common passwords, or found in a breach by Have I Been Pwned's k-anonymity API — only 5 characters of a SHA-1 leave the server. That last check allows the password if the service is unreachable | `password.ts`, `modules/auth/password-breach.service.ts` |
| Online guessing | 10 consecutive failures lock the account for 15 minutes and email its owner; per address, 10 sign-ins, 5 sign-ups, 5 reset requests and 10 link uses a minute | `modules/auth/auth.service.ts`, `RATE_LIMITS` |
| Finding out who has an account | Unknown address and wrong password get the same answer after the same scrypt work (a decoy hash); sign-up and "forgot password" answer identically either way and email the owner instead; "confirm your email first" is said only after the correct password | `auth.service.ts` |
| Forged tokens | ES256 only (algorithm pinned, so `alg:none` and HS256 key confusion fail); issuer and audience checked; a key of its own (`user-session`), rotated with the same tool as the others; a token issued before the last password change is refused | `packages/auth-rbac/src/user-auth.ts`, `common/auth/auth.guard.ts` |
| Stolen sessions | Access tokens last 10 minutes. Refresh tokens are 256-bit, stored only as SHA-256, and replaced on every use; presenting a spent one more than 30 seconds later ends the whole sign-in for both holders. A sign-in ends after 8 hours whatever happens. Resetting or changing a password ends every sign-in; signing out ends it at the server, and each access token dies with its sign-in on its next use, not when it expires | `modules/auth/sessions.service.ts` |
| Tokens in the browser | None. The portal keeps them in a sealed, httpOnly, SameSite=Lax cookie; forms are server actions, which check the Origin | `web-portal/src/lib/session.ts`, `proxy.ts` |
| Emailed links | 256-bit, stored hashed, bound to one purpose, single-use, short-lived (confirm 24 h, reset 30 min, invitation 7 days). Opening a link spends nothing — a button does, so a mail scanner that follows links cannot use them up — and those pages send no Referer | `modules/auth/auth-tokens.service.ts`, portal pages |
| Logs | No password, token or link is logged; the email transport logs the template and status only | `modules/auth/email/email.service.ts` |
| The first administrator | `create-admin` refuses once one exists, and emails the invitation rather than printing it | `api-gateway/src/cli/create-admin.ts` |

### Known limits

- **Per-address limits trust Caddy's `X-Forwarded-For`.** Anything placed in
  front of Caddy must be listed in its `trusted_proxies`, or every visitor
  shares one address and one budget (`oolix/infra/caddy/Caddyfile`).
- **The breach check fails open,** by design: an outage at Have I Been Pwned
  must not stop people signing up.

### How it was checked — 2026-09-24

| What | Result |
| --- | --- |
| Unit: passwords and sign-in tokens (`auth-rbac`) | 24 tests: hashing, the policy, and every forgery above refused |
| Integration, real Postgres 16 and Redis (`test/auth.int-spec.ts`) | 12 scenarios: sign-up to organization, duplicate sign-up, unconfirmed sign-in, lockout, uniform failures, `no-store`, disabled account, refresh rotation and replay, sign-out recalling the access token, reset ending every session, invitations |
| `pnpm probe` (anonymous, 8 of them new) | 44/44: a failed sign-in names neither half, forged links and refresh tokens are refused as input, the sign-in limit bites |
| `pnpm probe:authed` (7 new) | 20/20: `alg:none`, HS256 keyed with a published key, an attacker's key under the real `kid`, a key embedded in the header and a swapped subject are all refused, while a control token passes; an access token dies at sign-out |
| A browser, end to end | Sign up, confirm, sign in, create an organization, sign out, reset the password — and a session ended from another device lands on "your session ended" instead of looping |
| `pnpm audit --prod` | Clean, after raising fastify to 5.12.1 |

Two defects surfaced on the way and are fixed: a refused-but-unexpired session
bounced between the page and the sign-in form until the access token expired,
and responses carrying tokens could be cached (now `Cache-Control: no-store`).
