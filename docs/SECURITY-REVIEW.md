# Application security review

Run 2026-09-03 against a live instance. `scripts/pen-probe.mjs` — 31 probes,
all passing after one fix.

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
