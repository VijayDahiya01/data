# MVP go-live checklist

Spec v5 §87 · assessed 2026-08-24

Since the previous assessment the **v6 Audience Builder change spec** has been
implemented: a Buyer now describes an audience from the Oolix attribute
taxonomy, Oolix matches it against Data Partner capability metadata, and the
selected Partners' Agents evaluate the rules and materialize the matching
members locally. That changes what several items below are guarding.

The privacy items get **stronger**, not weaker: Oolix now stores audience rules
and capability metadata, and still holds no customer record, no Partner local
field name and no exact reach count (v6 §17). `pnpm verify:v6` and
`pnpm verify:v6:serving` assert both halves against a running stack.

Two items below are re-scoped by v6 and are called out where they appear:
"live-tested segment" now also means a **published capability set plus a working
local attribute mapping**, and the synthetic campaign should be run on the
audience path, not only the prebuilt-segment one.

§87 lists what must be true before real user traffic reaches this system. This
document works through every item and says plainly which are **done**, which are
**blocked on facts that do not exist yet** (a chosen cloud, a signed Partner, a
legal review), and which are **open work**.

Nothing here is marked done unless something in the repository proves it and can
be re-run. Where an item depends on a decision nobody has made, that is recorded
as a decision — not as a task somebody forgot.

**Status key** — ✅ done and verifiable · 🟡 partly done, gap named · ⬜ open ·
🔒 blocked on an external fact

---

## 87.1 Technical

### 🔒 Production/staging environments separated; backups and PITR enabled

No cloud account or environment exists yet. This is the first thing to do once a
hosting decision is made, and it is a prerequisite for most of the rest of this
section.

What is ready for it: `docker-compose.yml` defines the full dependency set
(PostgreSQL 16, Redis 7, LocalStack for S3/SQS, Keycloak 26.5, and a separate
Partner-side PostgreSQL), and `.env.example` enumerates every variable the
services validate at boot (§65.1). `loadConfig()` fails closed on a missing or
malformed value rather than starting half-configured.

**Decide:** cloud provider and region. §81 governs Indian data residency, so
region selection is a compliance decision, not a latency one.

### 🟡 All secrets in secret managers; no seed credentials or dev IdP users in production

Done:

- `.env` and every `.env.*` except the example are git-ignored.
- `.keys/` and `*.keyfile.json` are git-ignored. These hold the **private** ES256
  keys for manifest signing (§75) and Agent access tokens (§92.3). Anyone
  holding the manifest key can forge an activation manifest that a Partner Agent
  will accept as genuine, so this is the single most sensitive artifact in the
  repository.
- `pnpm db:seed --env=production` refuses, verified by a test that runs the real
  command (`oolix/packages/db/prisma/seed/seed-guard.spec.ts`).
- No credential appears in the implementation pack; `pnpm verify:pack` scans for
  private keys and AWS key ids on every CI run.
- The Kubernetes starter uses `REPLACE_ME` placeholders and reads the connector
  DSN from a Secret, with a note that the real value belongs in the Partner's
  own secret manager.

Open:

- Secrets are read from environment variables at boot. A managed secret store
  (AWS Secrets Manager, Vault) has not been wired in, because which one depends
  on the hosting decision above.

**Corrected 2026-09-09.** This item previously read as though "no dev IdP users
in production" was handled. It was not. `oolix/infra/keycloak/oolix-realm.json` is
imported into production unchanged and shipped **thirteen development
identities with the password `password`**, one of which (`demo@example.test`)
holds OOLIX_ADMIN plus every Partner role — alongside a literal OIDC client
secret, `sslRequired: none`, and the password grant enabled.

All of it is fixed: `oolix/infra/keycloak/render-realm.mjs` substitutes every
environment-dependent setting, refuses to render without a client secret, and
refuses to seed identities into a realm that requires TLS. The users live in
`dev-users.json` and are merged only on an explicit `KC_SEED_USERS=true`.
Verified against a running production stack — the password grant now answers
"Client not allowed for direct access grants" for the demo account, and the old
published secret returns 401. Guarded by 11 tests in
`shared/contracts/src/realm.test.ts`.

Key **rotation** is done and exercised: `pnpm keys:list`, `keys:rotate`,
`keys:retire`.

`pnpm preflight --env-file .env.prod` refuses a deployment carrying placeholder
or reused secrets, seeded identities, or the password grant.

### 🟡 OIDC/MFA/RBAC and organization isolation penetration-tested at least at application level

Done, and continuously re-verified:

- Authentication is a **global** guard with `@Public()` opt-out, so a forgotten
  decorator fails closed rather than open.
- Roles are read from the database for the active organization, never from a
  token claim (§4.2). An IdP misconfiguration therefore cannot become a
  privilege escalation inside Oolix.
- MFA is required for the roles §66 names, checked on the request path — and,
  since 2026-09-22, actually satisfiable. See the correction below.
- Organization scoping is enforced server-side on every endpoint. `pnpm verify`
  asserts the negative cases directly: a Partner cannot mint a Buyer's CRM key,
  a Buyer cannot see another Buyer's campaign, and a Partner's report never
  names another Partner.
- §66.2 separation of duties: the user who created a Partner request cannot
  approve it, even within one organization.
- Rate limiting is enforced globally (§86 budgets, §94 mechanics), including the
  5/min/IP signup budget, with per-organization overrides configurable in Redis
  without a deploy.

**Cross-tenant isolation is now probed from OUTSIDE the application.**
`pnpm probe:authed` — 16 checks driven with real tokens and real identifiers
pulled from the database, asking not what a stranger can reach but what someone
can reach holding a perfectly good token for a *different* organization. All
refused, including the two that would be outright theft: Partner B **approving**
Partner A's request, and Partner B **revoking** Partner A's Agent. The
integration suite asserts the same isolation using the application's own
helpers, which shares assumptions with the code under test; this does not.

Open:

- **No third-party penetration test has been performed.** The assertions above
  are our own; §87 asks for an independent one. 52 automated probes catch
  regressions, not business-logic abuse.
- `trustProxy` is set to `true` unconditionally, and this now matters **more**
  than when it was first noted. Behind a load balancer that strips inbound
  `X-Forwarded-For` it is correct, but if the API were exposed directly a client
  could spoof that header and evade the IP-scoped limiter described below — a
  guard that did not exist when this line was written, and which credential
  stuffing would otherwise hit. **Confirm the edge strips it, or narrow
  `trustProxy` to the balancer's CIDR, before exposing anything publicly.**

**Corrected 2026-09-22. The MFA requirement could never be met, and that
locked six of the nine roles out of any production deployment.**

`auth.guard.ts` refuses `PARTNER_ADMIN`, `PARTNER_SECURITY_ADMIN`,
`PARTNER_CAMPAIGN_APPROVER`, `FINANCE`, `BUYER_ADMIN` and `OOLIX_ADMIN` unless
the access token carries `acr` in {`mfa`, `aal2`, `aal3`} or an `amr`
containing `otp`/`mfa`/`hwk`/`swk` — and only when `APP_ENV` is exactly
`production`. Every test and every verification run uses a lower `APP_ENV`, so
that branch had never executed. Nothing anywhere checked that a real token
could satisfy it.

It could not. Measured against the running realm: Keycloak 26.5 emits **no
`amr` claim at all**, and `acr` is the Level of Authentication, which stays
`"1"` unless the realm both maps a name to a level and runs a browser flow that
records reaching it. The realm had no `otpPolicy`, no `acr.loa.map`, no
authentication flows and `CONFIGURE_TOTP` disabled as a default action. A
production deployment would therefore have signed a Partner admin in
successfully and then answered `AUTH_001` to every request — which reads like a
permissions bug, not a missing realm setting.

**Fixed and verified end to end.** The realm now binds a step-up browser flow
whose OTP subflow is conditional on the level `acr.loa.map` calls `mfa`, and
the portal's authorization request asks for that level (`acr_values`) — a realm
alone cannot do it, because Keycloak records a level only when the login
requests one. Against the API running with `APP_ENV=production`:

| Login | `acr` | API |
| --- | --- | --- |
| with `acr_values=mfa` | `mfa` | **200** |
| without | `basic` | **401 `AUTH_001`** |

So the role works and the guard is still enforcing, rather than having been
loosened to make the error go away. Thirteen tests pin it: seven in
`shared/contracts/src/realm.test.ts` on realm-to-guard agreement (including
that the OTP subflow's level and the map's `mfa` level are the same number —
disagree and the OTP step silently never runs), and six in
`oolix/packages/auth-rbac/src/rbac.test.ts` on `mfaSatisfied`, which had none.

Two consequences worth knowing. MFA now applies to **every** account, not only
the six roles: Keycloak cannot know Oolix roles, so realm-level MFA is
all-or-nothing and the safe direction is on. And `pnpm preflight` now refuses
any `APP_ENV` but `production`, because `staging` leaves Content-Security-Policy
and HSTS off as well as MFA, while every other check still passes green.

**Corrected 2026-09-10.** This item used to say rate limiting runs only *after*
authentication and that unauthenticated flood protection was the edge's
responsibility. That is no longer true: `IpRateLimitGuard` is registered
**before** `AuthGuard` (`app.module.ts`) and consumes an `anonymousIp` budget,
which is exactly why the probe suite's own flood test gets a 429 while
anonymous. It was added because credential stuffing and plain 401 floods were
previously unlimited. Edge rate limiting is still worth having as defence in
depth — but the application is no longer relying on it.

### 🟡 Agent registration, key rotation and emergency revocation tested

Done:

- Registration (§92.2) is exercised on every `pnpm verify` run, including the
  single-use bootstrap token: reuse is rejected, expiry is enforced, and
  `used_at` is set in the same transaction that creates the Agent.
- A JWK containing a private `d` parameter is rejected at registration.
- Emergency revocation (§69.3) is tested and takes effect **immediately**, not
  at token expiry: Agent status is re-read on every call. The Agent observes
  `401` on its next control sync and reports `identity_valid: false` on
  `/readyz`, which drops it out of the Partner's load balancer instead of
  leaving it serving for the rest of the 15-minute grace window.
- The contract is documented for Partners in
  `partner/pack/agent-auth.md`.

Open:

- **Key rotation has not been drilled.** The key store supports multiple keys
  with an active kid, and Agents fetch the JWKS, but nobody has rotated a
  manifest signing key while Agents were live and confirmed that in-flight
  manifests still verify. Do this before go-live; it is the rehearsal that
  matters most, because getting it wrong takes every Partner offline at once.

### ✅ Manifest tamper/expiry tests pass

`oolix/packages/manifest-schema` covers signature verification, `typ`, issuer,
audience, `kid` and time bounds, and `pnpm verify` exercises the full path
through a live Agent: a manifest signed for another audience is rejected, an
expired manifest stops serving, and a revoked activation is dropped on the next
control sync.

CI runs the manifest suite in its own job, because §80 keeps N-1 compatibility
during a rollout and a breaking schema change must be a deliberate act.

### ✅ Partner Agent outage and Oolix outage simulations confirm safe NO_AD behavior

Both directions are covered, and the customer-facing half is covered in a real
browser:

- **Agent down** — the Partner page still renders its own content and the ad
  slot degrades to house content. Asserted by the Playwright suite, which runs
  against an Agent address that is deliberately not listening, so the failure
  path is the default path (§43: "ad placement failure cannot block
  checkout/booking/login").
- **Agent slow** — the decision is abandoned at the timeout and the page does
  not wait.
- **Oolix down** — the Agent keeps serving cached manifests inside `stale_grace`
  (§75) and then stops starting anything new. An Oolix outage does not become a
  Partner outage.
- **Connector cold or unreachable** — the lookup fails closed to `NO_AD` rather
  than guessing eligibility.

### 🟡 Monitoring dashboards and alert routes configured

Structured logging (§78.1) and the metric names (§78.2) exist, URL redaction is
enforced so a token or PII never reaches a log line, and the worker raises the
staleness and expiry conditions §78.2 names — including the escalation from a
config-staleness warning at 5 minutes to critical at 15.

**Since this was written**, the stack itself exists:
`oolix/infra/monitoring/prometheus.yml` and `alerts.yml` (7 rules), with
`alertmanager.yml` for routing, all wired into `compose.prod.yml`.

Open:

- The Alertmanager receivers are still `http://example.invalid` placeholders.
  A stack with those is healthy, green, and **completely silent** — which is why
  `pnpm preflight` treats them as a blocking failure rather than a warning.
- Who is on call is a person, not a config value.

**Decide:** where alerts go, and who answers them.

### 🟡 Queue DLQ/re-drive runbook tested

The queue envelope, retry policy and DLQ behaviour (§74) are implemented against
LocalStack SQS and covered by the phase verifications. There is **no written
re-drive runbook** and no drill against real SQS.

### ✅ Database migration rollback/forward-fix procedure tested

Prisma migrations are authoritative (§96) and CI applies them to a disposable
database on every run, so "the migration applies cleanly" is continuously
proven.

**Decided and written down** in `docs/BACKUP-AND-ROLLBACK.md`, which opens with
the decision table. The distinction matters because reaching for the wrong one
makes things worse: a release rollback is a tag change and is only safe if the
release did **not** migrate the schema. `migrate deploy` is forward-only and
Prisma has no down migrations, so if the bad release migrated, the route back is
a restore. That is why a backup is taken immediately before every deployment
rather than nightly only.

### 🟡 Performance/load baseline recorded; local ad decision p95 ≤ 100 ms

The budgets are implemented and enforced rather than merely documented:

- The connector separates the §103 **objective** (p95 ≤ 30 ms, logged when
  exceeded) from the **hard deadline** (50 ms, fails closed). Using a p95 as a
  per-request timeout would fail the slowest 5% by construction, including the
  first query on a cold pool.
- The pool is warmed at startup, after an earlier failure where the first
  decision paid connection setup inside the deadline and failed closed.
- The whole decision budget is 100 ms; the SDK gives up at 150 ms.

Open: **no load test has been run**, and §87 asks for the baseline to be
recorded "in design Partner environment" — which means the pilot Partner's
hardware and their data volumes, not a laptop. Blocked on a pilot Partner.

### ✅ Data redaction/logging scan passes

- No `partner_user_id` column exists anywhere in the schema, and the Agent never
  echoes one back in a decision response.
- URLs are redacted before logging (§53, §82) — a click token in a path never
  reaches a log line.
- The Agent redacts the fields §69.1 lists, at every level.
- Automated: an integration test asserts the schema contains none of §73's
  forbidden tables and no `partner_user_id`; a unit test asserts the same
  against `schema.prisma` in the fast gate; and an error-envelope test asserts
  that no error response leaks a stack trace, an internal path or a customer
  identifier.

### 🔒 Restore drill completed

Requires a real database with PITR. Blocked on the hosting decision.

### ✅ Release rollback documented

**Drilled 2026-09-03:** the stack was deployed on tag `rel-002`, rolled back to
`rel-001`, and came back healthy on the older tag. Documented in
`docs/BACKUP-AND-ROLLBACK.md` → "Rolling back a release".

Recorded from that drill: `IMAGE_TAG=dev` **cannot** be rolled back to, because
the tag moves — "the previous image" no longer exists by the time it is needed.
Releases need an immutable tag, a commit SHA or a build number. `pnpm preflight`
now refuses a deployment pinned to `latest`, `dev` or `main`.

§80's staged-rollout and N-1 compatibility rules for the Agent still need the
cloud-service equivalent once a real deploy pipeline exists.

---

## 87.2 Business / Partner

Every item in this section depends on facts that only exist once real
counterparties are involved. None of them can be closed from inside this
repository, and none should be marked done by an engineer.

### 🔒 At least 1 verified Buyer and 2 Data Partners onboarded

The seed creates one Buyer and two Data Partners as **synthetic** fixtures
(§95), which is what makes cross-Partner isolation testable. Real onboarding is
a commercial process.

### 🔒 Each Partner has one live-tested segment and placement

The mechanism is complete and verified end to end against fixtures. §37 makes
readiness **derived** rather than declared: a Partner cannot be marked ready
while its Agent has never checked in, which is exactly the failure this item
guards against.

**v6 adds a second thing to live-test.** A Partner on the audience path also
needs a published capability set (v6 §5.1) and a local attribute mapping in
their Agent config (v6 §5.2) whose `mapping_version` matches what they
published. A Partner with a segment but no capabilities is invisible to the
Audience Builder — they will not appear in any Buyer's Partner matches, and
nothing in the product will tell them why. Check both before go-live.

### 🔒 Partner commercial terms, approval SLA, lead definition and payout basis agreed

All four are modelled and enforced — payout basis is computed from verified
outcomes only (§50: never from unverified clicks), the approval SLA runs per
Partner with one 7-day extension (§101), and a campaign with an outcome
objective cannot be submitted without a lead definition (§40.8). The *agreement*
is a contract, not code.

### 🔒 Synthetic/test campaign completed before real user traffic

**Run it on the audience path.** `pnpm verify:v6:serving` does exactly this
against fixtures: audience → match → local estimate → link → approve →
materialize → serve → revoke. A go-live rehearsal that only exercises a prebuilt
segment leaves the entire v6 path — local rule compilation and materialization —
untested against that Partner's real schema.

`pnpm verify` completes exactly this, end to end, against fixtures: create,
approve, serve, click, qualify, settle. Repeating it inside a real Partner's
environment with their own segment is the actual gate.

### 🔒 Privacy/legal review completed for launch jurisdiction

§81 anchors this to India's DPDP framework. The architecture is designed to make
the review straightforward — Oolix holds no customer database, consent is
checked Partner-side and fails closed, purposes are explicit and versioned
rather than a permanent boolean, and retention is bounded — but a review is a
review.

### ✅ Meta/Google remain disabled unless eligibility proof is complete

`FEATURE_META_ENABLED` and `FEATURE_GOOGLE_ENABLED` default to `false`, and the
gate is enforced in more than one place: an external channel activation stays
`PENDING_CHANNEL_CHECK` with **no manifest** even after Partner approval, so
approval alone can never enable an upload (§15, §16, §84).

The seed deliberately lists `META` among one segment's allowed channels
specifically so this gate is exercised rather than assumed. Listing a channel
does not make it usable.

§85 places these in phases 9 and 10, after a real Partner and Buyer exist, and
§84 is explicit that Google's Data Manager API path needs the exact eligible
account model verified against current provider documentation first.

### 🔒 Support owner and escalation contacts defined

Not defined. Needs people, not code — and it is the other half of the alert
routing above: a page with nobody on the end of it is the same as no page.

---

## Summary

**Last reconciled against the code: 2026-09-10.** Five items in this checklist
had drifted — three were marked open after the work had been done, one implied
dev IdP users were handled while the realm was shipping thirteen of them, and
one described rate limiting the application no longer does. A launch checklist
that is wrong in the optimistic direction is worse than no checklist, so it is
worth re-reading against the code before each attempt rather than trusting it.


| Section                | ✅  | 🟡  | ⬜  | 🔒  |
| ---------------------- | --- | --- | --- | --- |
| 87.1 Technical         | 5   | 6   | 0   | 2   |
| 87.2 Business/Partner  | 1   | 0   | 0   | 6   |

### Portal

Added after the §87 assessment above and worth recording here, because two of
its findings were real defects rather than missing screens:

- The campaign builder (§40 steps 1–9), the Partner approval centre (§41), the
  catalogue (§39), Partner supply, activations and payouts are all clickable.
  `pnpm test:e2e:portal` drives a Buyer through building and submitting a
  campaign, a Partner through approving it, and back to the Buyer to see the
  per-Partner result.
- The access token never reaches the browser. Every API call is made by the
  Next server and the session cookie is sealed with AES-256-GCM and `httpOnly`,
  which a test asserts against `document.cookie`, `localStorage` and the
  rendered HTML (§82).
- **Two API defects surfaced by building the UI.** `campaign.service.ts` and
  `approval.service.ts` were emitting the Prisma enum spelling of a reach
  bucket (`HUNDRED_K_250K`) instead of §72's canonical value (`100K_250K`) — a
  Partner was shown the database spelling while deciding whether to accept a
  campaign, and a strict generated client would have rejected the response.
  Separately, `Brand` existed in the schema and was required by every campaign,
  but had **no API at all**, so §36 step 4 and §40.2 were unreachable. Both are
  fixed and covered by tests.

Screens that exist in the navigation but are not built — reports, billing,
leads, connections, network, admin, and the Partner integrations and policies
views — say so explicitly and name the endpoints that already work, rather than
rendering blank.

**What is genuinely finished:** the privacy and security invariants that are
hard to retrofit — no customer data centrally, opaque attribution, signed and
bounded manifests, immediate Agent revocation, fail-closed ad decisions,
append-only financial corrections, and enforced rate limits. These are the ones
that would be expensive to add later, and each is covered by a test that runs on
every commit.

**The largest remaining technical gaps**, in the order they should be closed:

1. Choose a hosting environment. Eight items are blocked behind it.
2. Drill manifest key rotation with live Agents. Nothing else fails so widely if
   it is wrong.
3. Commission an independent penetration test of RBAC and organization
   isolation.
4. Confirm the edge strips inbound `X-Forwarded-For`, and add an unauthenticated
   rate limit there.
5. Record a load baseline in the pilot Partner's environment.

**Do not go live** while any 87.2 item is open. They are not engineering tasks,
and every one of them protects somebody who did not agree to be in this system.

---

## Re-running the evidence

```bash
pnpm lint && pnpm typecheck && pnpm test:unit   # static gates and unit tests
pnpm test:integration                            # API integration suite
pnpm test:e2e                                    # browser smoke (§43)
pnpm verify:pack                                 # implementation pack drift
pnpm verify                                      # §85 phase exit criteria, 0-7
cd partner-agent && go test ./...                # Partner Agent
```

`pnpm verify` needs the local stack (`pnpm infra:up`), a running API
(`pnpm dev:api`) and a provisioned Agent (`pnpm agent:provision`). Everything
else runs from a clean checkout.
