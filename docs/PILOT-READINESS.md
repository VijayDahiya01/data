# Pilot readiness — what stands between here and a live Partner

First assessed 2026-09-02, worked through 2026-09-03. Every claim below was
checked against the code and, where it could be, performed rather than
described.

**Where we are.** All nine verification phases pass (328 checks), 32 portal e2e
tests pass, and the v6 change spec is fully implemented. Since the first
assessment: the whole stack runs over HTTPS from built images, secrets can come
from files instead of the environment, signing keys rotate and retire through
an operator CLI, backups have been taken and **restored after deliberately
destroying both databases and every key**, a release has been rolled back,
metrics and alert rules exist on both sides of the Partner boundary, a load
baseline is measured, and 31 adversarial probes run against a live instance.

**What is left is procurement and paperwork, not engineering:** a host, a
managed database, a managed Redis, a bucket and three DNS names; Meta App
Review and Google Data Manager access for the external channels; and the
counterparty work at the bottom of this document, which takes longer than any
of it.

**Scope decisions taken:** the pilot will not carry large data volumes, so the
500M-scale work is deferred. Meta and Google activation IS in scope and has
been built (item 13); it cannot be exercised until the platform credentials
exist.

**Last full verification: 2026-09-09.** 10 phases / 341 checks, 32 portal e2e
against a production build, 26 integration, 86 API unit, **178 Go**, 36
adversarial probes, OpenAPI valid with no warnings. Typecheck, lint and format
clean. `pnpm preflight` gates a deployment before a Partner is behind it.

**What is left needs a credit card, an application form, or a signature.**
`docs/EXTERNAL-DEPENDENCIES.md` covers all four — what each involves, what it
costs, how long it takes, and which one is actually on the critical path (only
the host is; Meta and Google are optional for a first pilot).

**Deploying it:** `docs/DEPLOY-DIGITALOCEAN.md` is a step-by-step runbook for
a first DigitalOcean deployment (~$128/month, ~90 minutes).
`docs/DEPLOYMENT-HANDBOOK.md` covers both sides — exact
versions, ports, what the Partner provides, and the failures that look like
something else.

**Status at a glance**

| # | Item | Status |
| ---: | --- | --- |
| 1 | Container images | done, built and scanned in CI, pushed by SHA |
| 2 | Deployment target | everything but the host itself |
| 3 | HTTPS end to end | done, verified with the chain validated |
| 4 | Real secret management | done, file secrets + key rotation and retirement |
| 5 | Backups and restore | done, and drilled destructively |
| 6 | Sargable attribute mappings | done |
| 7 | Partner pack verified | done, five defects found and fixed |
| 8 | Integration guide | done |
| 9 | Monitoring and alerts | done, both sides of the boundary |
| 10 | Migration and release rollback | done, and drilled |
| 11 | Load baseline | done |
| 12 | Application security review | automated part done; an engagement still needed |
| 13 | Meta and Google activation | built; blocked on platform credentials |

---

## The production stack, actually booted — 2026-09-14

Until now "the images build and run together" was asserted by the Dockerfiles,
not proven. It is now proven.

All three images built from the committed tree and tagged with the commit SHA
(`9f192d3`), then the whole stack brought up from `compose.prod.yml`:

| | |
| --- | --- |
| `api-gateway` | 766 MB, runs as `node` |
| `worker` | 720 MB, runs as `node` |
| `web-portal` | 322 MB, runs as `node` |

Signing keys provisioned by the real image, migrations ran to completion and
exited 0, and every service reported healthy. Served over HTTPS through Caddy:

```
https://api.oolix.localhost/healthz                       200
https://app.oolix.localhost/login                         200
https://auth.oolix.localhost/realms/oolix/.well-known/…   200
```

**The hardening was then checked inside the running stack**, not in the file
that produces it: the imported realm carries **0 users**, `sslRequired:
external`, the password grant **off**, and a client secret that is not the
published literal.

### Alert routing was still a hand-edit, and is not any more

`pnpm preflight` blocked this deployment on it, correctly. The two webhook URLs
were literals inside `infra/monitoring/alertmanager.yml` with a comment asking
somebody to replace them — the most forgettable kind of deployment step,
because every other setting comes from `.env.prod`.

It also fails in the worst direction: every rule still evaluates, every alert
still fires, and all of them go to a hostname that does not resolve. The stack
stays green and nobody is told, and you find out during the incident the
alerting existed to catch.

They are now `ALERT_WEBHOOK_DEFAULT` and `ALERT_WEBHOOK_ONCALL`, substituted at
deploy time by `infra/monitoring/render-alertmanager.mjs`, which **refuses** to
render an unset value, an example placeholder, a non-HTTP URL, or `localhost`
— which inside a container is Alertmanager itself. Verified all four refusals
plus the success path, and the rendered file that Alertmanager actually loaded
carries the real URLs. Webhook tokens are never logged; only hosts.

---

## The MFA requirement could never be met — 2026-09-22

Found by asking the narrow question "can a Partner admin actually sign in to a
production deployment?", which no test and no drill had asked.

They could not. Neither could a Partner security admin, a campaign approver,
finance, a Buyer admin or an Oolix admin — **six of the nine roles**.
`auth.guard.ts` requires MFA evidence in the token for exactly those roles, and
only when `APP_ENV` is `production`. Every suite and every verification phase
runs at a lower `APP_ENV`, so the branch had never once executed.

Measured against the running realm rather than assumed: Keycloak 26.5 emits
**no `amr` claim at all**, and `acr` is the Level of Authentication — `"1"`
unless the realm both maps a name to a level and runs a browser flow that
records reaching it. The realm had no `otpPolicy`, no `acr.loa.map`, no
authentication flows, and `CONFIGURE_TOTP` was not a default action. So the
login would have succeeded and every subsequent request answered `AUTH_001`,
which reads like a permissions bug rather than a missing realm setting.

This is the same shape as the realm defects found on 2026-09-09: a file that is
correct in development and wrong only once the deployment is real.

**Fixed.** The realm binds a step-up browser flow whose OTP subflow is
conditional on the level the map calls `mfa`, and the portal's authorization
request asks for that level. Both halves are required — a realm cannot record a
level the login never requested. Verified against the API running with
`APP_ENV=production`: `acr_values=mfa` gives `acr: "mfa"` and **200**, omitting
it gives `acr: "basic"` and **401 `AUTH_001`**. The role works and the guard is
still enforcing.

Two Keycloak behaviours that cost a cycle each and are now pinned by tests:
declaring `requiredActions` in a realm import **replaces** the list, so
declaring only `CONFIGURE_TOTP` silently unregisters `UPDATE_PASSWORD` — which
is how an operator hands out a temporary password when creating the first
accounts; and `default.acr.values` on a client is rejected at import, so the
request parameter is the only way to ask for the level.

**Consequences to plan around.** MFA now applies to every account, not only the
six roles, because Keycloak cannot know Oolix roles. Each person enrols an
authenticator at first sign-in — budget a minute each and have the phone in the
room. And `pnpm preflight` now refuses any `APP_ENV` but `production`: the
local `.env.prod` in this repository said `staging`, which would have deployed
with Content-Security-Policy and HSTS off as well as MFA unenforced, while
every other check passed.

**The portal e2e suite passes: 32 tests, against a production portal build.**
The ten suites that each carried their own copy of `signIn` now share one that
answers the second factor.

It failed the first time, and the reason is worth keeping. The realm sets
`otpPolicyCodeReusable: false` -- correctly; a reusable code gives up much of
what a second factor is for -- and Keycloak enforces it by remembering the
30-second step a code came from and refusing that step again. The suites sign
the same user in repeatedly and seconds apart, so the helper kept replaying a
code Keycloak had already spent. Keycloak said "Invalid authenticator code",
the sign-in stalled, and the test failed on a timeout waiting for the portal --
pointing at the portal, which was fine. Eight failed, sixteen passed, and the
sixteen were the tell: the secret and the arithmetic were right or nothing
would have passed at all.

Fixed in the helper rather than the realm: it tracks which step each account
has spent a code from, waits past the boundary rather than replaying, and
retries on refusal. The suite costs 10.3 minutes now against 2.6 before, almost
all of it waiting for step boundaries.

This is also the case for having collapsed the ten copies. One helper meant one
fix; ten would have meant ten, and whichever was missed would fail
intermittently depending on how fast the machine ran that day.

---

## Found while preparing for a LIVE pilot — 2026-09-09

Six defects that every test suite passed over, because none of them is wrong in
development. Each was found by asking "what would this configuration do with a
real Partner behind it".

### The realm file published a working admin account
`infra/keycloak/oolix-realm.json` is imported into production unchanged, and it
carried:

- `"secret": "local-only-secret"` — the portal's OIDC client secret, in a
  checked-in file. An operator who set a strong one in `.env.prod` instead just
  broke sign-in with a mismatch, because Keycloak's copy still said otherwise.
- **Thirteen development identities with the password `password`**, one of
  which (`demo@example.test`) holds OOLIX_ADMIN plus every Partner role. A
  published, full-access account on every deployment.
- `"sslRequired": "none"` — Keycloak accepting plain HTTP.
- `directAccessGrantsEnabled: true` — the password grant, which bypasses the
  browser sign-in entirely and with it any step-up authentication ever added.
- No password policy at all.

**Fixed.** Every environment-dependent setting is now a placeholder filled in
by `infra/keycloak/render-realm.mjs`, which also validates the result and
refuses to seed identities into a realm that requires TLS. The users live in
`dev-users.json` and are merged only on an explicit `KC_SEED_USERS=true`, so
forgetting a flag yields no accounts rather than thirteen known ones. Nine
tests in `packages/contracts/src/realm.test.ts` keep it that way. Verified both
ways against a running Keycloak.

### The Partner Agent image was never published
CI built three images and not the one that runs inside a Data Partner's
infrastructure. Its own Dockerfile says "built by Oolix"; the shipped
Kubernetes manifest pointed at `REPLACE_WITH_REGISTRY`. A Partner would have
had to build our software from source, unscanned, with a Go toolchain.

**Fixed.** `partner-agent` is in the CI image matrix, so it is built, Trivy
scanned and pushed by SHA like the rest. Verified locally: 25.7 MB, runs as
65532, no shell in the image.

### Backups were documented, not scheduled
Nothing ran `backup.sh`. For a pilot holding a Partner's approvals and
financial records, "somebody remembers" is not a backup strategy.

**Fixed.** A `backup` service in the production compose, on by default, every
24 hours. It reaches Postgres over the network rather than through the Docker
socket — mounting that into a long-lived service hands it root on the host.
It refuses to write a backup it knows is useless: an empty dump is an error,
and so is a missing signing-key archive, because a backup without the keys
restores a system that cannot serve. Both refusals tested.

### Nothing checked a deployment before it went live
The Alertmanager config shipped `http://example.invalid` webhooks with a
`# REPLACE` comment. A stack with those is healthy, green, and completely
silent.

**Fixed.** `pnpm preflight` reads a specific deployment's `.env` and refuses:
placeholder or reused secrets, seeded identities, the password grant, non-HTTPS
or localhost URLs, `TLS_MODE=internal`, a moving `IMAGE_TAG`, placeholder alert
webhooks, and a `BACKUP_DEST` that never leaves the host. Tested in both
directions — 12 blocking findings against a deliberately bad deployment, clean
against a good one.

### The money paths on the Agent had no unit tests
`eventbuffer`, `state` and `attribution` carry the numbers a Partner is paid
on, the frequency cap a Partner promised their own customer, and the token that
links an ad to a lead. All three had zero unit tests. They are exercised
end to end by the verify phases, but nothing pinned the failure modes that are
silent in both directions — a dropped batch under-pays, a duplicated one
over-pays, a lost token means inventory served and never billable.

**26 tests added.** The properties now pinned: a failed upload keeps its
counters and retries under the SAME batch id (a new one would double-count
delivery); a pending batch is never overwritten by a fresh drain; draining
counters does not reset the frequency cap; the customer identifier is never a
stored key and is salted per activation so the same person is not correlatable
across campaigns; a raw click token is never stored or uploaded, only its
hash; and none of it loses anything under concurrency.

Two packages remain without unit tests, deliberately: `connector` needs a real
Postgres and is exercised by every verify phase, and `controlsync` is driven
end to end by phases 3, 4 and v6-serving.

One test of mine was wrong before the code was: a nanosecond frequency window
"failed" only because `time.Now()` on Windows is coarse enough that two calls
return the same instant. Rewritten to use a real elapsed interval.

### A comment promised a safeguard that did not exist
`state.go` claimed config validation refuses embedded mode with multiple
replicas. There is no replica count in the config, and a process cannot know
how many copies of itself are running. Someone trusting that comment could have
switched to embedded state and silently multiplied a Partner's frequency cap.
Corrected to say what is actually enforced and where.

---

## P0 · Nothing can be piloted without these

### 1. Container images for Oolix Cloud
**Status: DONE.** `infra/docker/Dockerfile.{api-gateway,web-portal,worker}`,
each built and verified running against the live stack:

| Image | Size | Verified |
| --- | --- | --- |
| api-gateway | 765MB | healthy, served a real query |
| web-portal | 322MB | healthy, login page rendered |
| worker | 720MB | stays up, schedulers running |

Four defects surfaced only by running them: the worker exited with status 0 when
no queue was configured (silently stopping the monitors), the API healthcheck
probed `PORT` where the service reads `API_PORT`, `prisma generate` needed a
build-time `DATABASE_URL`, and portal secrets were being set with `ENV`, which
persists into image metadata.

Outstanding: the API and worker images carry ~190MB of Prisma CLI and
TypeScript. pnpm's modern deploy fails against a shared lockfile and legacy mode
copies the whole store; bundling is the real fix. Documented in the Dockerfile.

CI already builds all three on every push, scans them with Trivy (HIGH and
CRITICAL, `exit-code: 1`) and pushes to `ghcr.io/<repo>/<service>:<sha>` from
`main`. The SHA tag is what makes a rollback possible: `latest` moves, so
rolling back to it rolls back to nothing.

### 2. A deployment target
**Status: everything but the host itself — 2026-09-03.**

`infra/docker/compose.prod.yml` now runs the whole stack the way a pilot will:
TLS termination in front, no application publishing a host port, migrations as
their own gated step, Keycloak in production mode with its realm rendered per
deployment, signing keys on a persistent volume provisioned by an explicit
one-time step, and an opt-in monitoring profile.

`infra/docker/compose.managed.yml` is the overlay for a real host: it removes
the bundled Postgres and Redis and requires managed `DATABASE_URL`, `REDIS_URL`
and a separate `KEYCLOAK_JDBC_URL` — separate because Keycloak needs a JDBC
string, and handing it the `postgres://` form fails with a driver error that
never mentions the format. Validated.

`docs/DEPLOYMENT.md` carries the sizing (derived from the load baseline, not
guessed), the network rules, the first-deployment order and the checklist that
has to pass before a Partner connects.

**What genuinely remains is a purchase, not an engineering task:** a host, a
managed database, a managed Redis, a bucket, and three DNS names. The stack has
been run end to end from these files, over HTTPS, with a backup taken and
restored and a release rolled back — on one machine rather than a rented one.


### 3. HTTPS end to end
**Status: DONE — 2026-09-03.** `infra/caddy/Caddyfile` terminates TLS in front
of the whole stack; the API, portal and Keycloak publish no host ports at all.
One variable, `TLS_MODE`, covers both a local certificate authority and real
Let's Encrypt certificates, because both are valid `tls` arguments — so the
drill and the deployment cannot drift apart.

Verified with the chain actually validated, never `curl -k`:

| Check | Result |
| --- | --- |
| `api/healthz`, manifest JWKS | 200 |
| portal `/login` | 200 |
| Keycloak realm discovery | 200 |
| authorize with the real `redirect_uri` | 302, not "Invalid parameter" |
| issuer Keycloak reports | `https://auth…/realms/oolix` |
| plain HTTP | 308 to HTTPS |
| HSTS, `X-Frame-Options: DENY` | present |

Six defects had to be fixed to get there, five of which failed silently or
pointed somewhere else entirely — the migration step that had never run, a
missing Prisma config, Keycloak's database never being created, a realm whose
`frontendUrl` overrode the hostname and issued tokens no API would accept, a
cluster-cache restart loop, and volume ownership on the signing keys. The full
account is in `docs/HTTPS-DRILL.md`.

### 4. Real secret management
**Status: DONE — 2026-09-03.**

**Secrets out of the environment.** Any variable can now be supplied as a file
— `DATABASE_URL_FILE=/run/secrets/database_url` — which is the convention
Docker secrets, Kubernetes secret volumes and the managed secret-store sidecars
all already speak. The value is read at start-up and the pointer removed, so
the secret never appears where `docker inspect`, `/proc/1/environ`, a crash
reporter and every child process would otherwise see it. A missing file is
refused rather than defaulted; a variable and its `_FILE` form set to different
values is refused rather than resolved by a precedence rule nobody remembers.
Eight tests in `packages/runtime-config`.

**Key rotation, with an operator entry point.** `rotate()` already existed and
nothing called it: the key signing every activation manifest had never been
changed and had no documented way to change. There is now `pnpm keys:init`,
`keys:list`, `keys:rotate` and `keys:retire`, rotation and retirement being
deliberately separate steps a day apart per §75's overlap. Seven tests cover
the refusals — never the active key, never inside the window, never the last
key standing.

Two defects surfaced doing it:

- **The key store resolved paths against the working directory.** The API runs
  with its own package as cwd and an operator's shell sits at the repository
  root, so the same configured path named two different files. Both existed. A
  key rotated from the root was written to a file the service had never opened,
  so the rotation appeared to succeed and changed nothing. Paths now anchor to
  the workspace.
- **A missing key file was silently replaced with a new key.** In development
  that is a convenience; in production it invalidates every manifest an Agent
  has cached, while the service reports itself healthy. Outside development the
  API now refuses to start, and provisioning is an explicit step.

### 5. Backups and restore, proven
**Status: DONE — 2026-09-03.** `infra/backup/backup.sh` and `restore.sh`, and
the restore has been performed, not just written.

The backup captures both databases **and the signing keys**. The keys are the
part that gets forgotten and the part that cannot be regenerated: every
manifest a Partner Agent has cached was signed by the manifest key, so losing
it makes every Agent reject every manifest it holds — and a database restore
does not fix that, while nothing anywhere reports the cause.

The drill: a backup was taken, then **both databases were dropped and every
signing key deleted**, then restored.

| Check | Outcome |
| --- | --- |
| API health | healthy |
| Marker row written before the backup | present |
| Manifest signing key | same `kid` as before |
| Manifest JWKS over HTTPS | 200 |
| Keycloak realm | 200 |

One defect surfaced only by doing it: the key archive is `0600`, so the
unprivileged service account could not read it and the restore failed **after**
the databases were already back. Fixed.

Still to do, and deliberately not guessed at here: a schedule, and off-host
storage. A backup on the same disk as the database survives only the failures
that do not matter. See `docs/BACKUP-AND-ROLLBACK.md`.

---

## P1 · Needed before a Partner integrates

### 6. Make the attribute mappings sargable
**Status: DONE — 2026-09-08.** The compiler had supported the indexable form
all along (`column:` + `derive:`, compiled to a range over the raw column) and
the integration guide already taught it. Only the shipped configuration was
never updated — and that file is what every Partner copies.

Fixed in all four places it appeared: `config.example.yaml`,
`config.local.yaml`, `scripts/provision-agent.mjs`, and the guide. Four derived
attributes were affected: `age`, `purchase_recency_days`,
`booking_recency_days` and `active_user_days`.

Guarded by tests that read the shipped example rather than a fixture: any
mapping whose expression wraps a column in a function must also declare the raw
column, and any declared derivation must be one the compiler implements. A typo
there used to be silent — an unrecognised derivation falls back to the
unindexable expression, which is correct and 76x slower.


### 7. Verify the Partner pack actually works
**Status: done — 2026-09-02.** Run the way a Partner would, using only the
files in `implementation_examples/`: image built from the pack Dockerfile,
schema created in a database that is not ours, connector user granted and its
limits confirmed (reads work, writes to Agent-owned tables work, `CREATE TABLE`
refused), Agent registered from behind a network boundary, control config
synced, audience materialized locally, and an ad decision served with a click
token:

```
{"decision":"SHOW","activation_id":"aa461f66-…","creative":{…},"click_token":"hSabq7…"}
```

It did not work first time. Five defects blocked it, four of which would have
hit every Partner and none of which any test caught:

1. **The Agent could not register at all.** The documented protocol existed and
   the endpoint existed; the only implementation was an Oolix Node script that
   the pack never shipped. Added `--register` to the Agent itself, which also
   makes the privacy claim true rather than merely stated — the keypair is now
   generated by the binary running inside the Partner's infrastructure.
2. **The guide's mapping key was `mappings:`; the parser reads `mapping:`.**
   The key was silently skipped, audience evaluation switched itself off, and
   the Agent logged one INFO line and reported healthy. A Partner following the
   guide exactly would have gone live matching nobody, with nothing to show
   them why.
3. **`column:`/`derive:` could not be represented in config at all.** The
   indexable query path — the one measured 12x faster, with its own passing
   tests — was unreachable from a real deployment. `main.go` also dropped both
   fields when building the compiler's mapping, so it would have stayed
   unreachable even after the config struct was fixed.
4. **The guide's shorthand form (`payment_method: pay_mode`) was not a shape
   the parser accepted.** Now it is.
5. **`placement_id` in the decision request carries the placement KEY.** A UUID
   there returns `NO_ELIGIBLE_CAMPAIGN`, which is indistinguishable from having
   no campaigns.

Three changes make this class of failure loud instead of silent:

- Config parsing is now strict — an unknown key stops the Agent and names it,
  rather than being skipped.
- An `attribute_table` set with no `mapping` is refused at start-up, and so is
  half a derived mapping (`column` without `derive`).
- `TestTheGuideExampleParses` parses the integration guide's own YAML block
  with the same strict decoder the Agent uses. Documentation and parser can no
  longer drift apart without a test failing.

One environment-specific finding, not a defect: the Agent's `api_base_url` must
be the exact string Oolix publishes as its own public URL, because it is signed
as the assertion audience. Reaching the same API by another address fails with
`Client assertion verification failed`, which does not hint at the cause. Now
documented in the guide.

### 8. An integration guide a Partner engineer can follow alone
**Status: done.** `implementation_examples/INTEGRATION-GUIDE.md` walks from
"we agreed to do this" to "an ad is serving", with a check after each step and
a table of every reason an ad does not appear. `partner-schema.sql` ships the
Partner-side tables, which the pack had been missing entirely.

Its correctness is no longer a matter of review: item 7 above was executed by
following it, and the four defects that found are fixed in the guide rather
than worked around in the test.

### 9. Monitoring and alert routes
**Status: DONE — 2026-09-03.** Two collection points, because they belong to
different people: `/metrics` on the Oolix API, and `/metrics` on the Partner
Agent. The Agent runs inside the Partner's infrastructure and Oolix
deliberately cannot reach it, so decision latency and the NO_AD reason mix are
numbers only the Partner can collect — asking them to open a hole for Oolix
would contradict the architecture.

Oolix side: agent heartbeat age and config age **per agent** (an average across
Partners hides the one outage that matters), agents by status, agents that
registered and never checked in, activations and partner requests by status,
and the age of the longest-waiting approval. Not exposed publicly — the
exposition names Partner organisations and Agent ids, so the TLS terminator
returns 404 for it.

Agent side: decisions by outcome and reason, a duration histogram bucketed
around the §103 100ms budget, budget breaches, and control-sync failure count
and age.

`infra/monitoring/` carries the scrape config, 7 alert rules and the
Alertmanager routing, all three validated with `promtool`/`amtool`. The
thresholds are the same numbers the worker already enforces rather than new
ones, so a rule cannot disagree with the code. Collector runs behind a
`--profile monitoring` opt-in.

Four tests on the API exposition and five on the Agent's, including one on each
side asserting no per-person label can appear — a label is exactly where an
identifier ends up by accident, and monitoring data outlives and outtravels
every other copy.

One defect found on the way: returning the exposition from the controller sent
it through the JSON response envelope, which produced a 500 on the scrape
endpoint alone. It would have gone unnoticed until the first alert failed to
fire.

Still open: queue lag has nothing to measure until a queue is configured
(`SQS_DOMAIN_EVENTS_URL` is optional and scheduler-only is a valid deployment),
and the Alertmanager receivers are placeholder webhooks that **must be replaced
before real traffic**. See `docs/MONITORING.md`.

---

## P2 · Needed before the pilot is trusted

### 10. Migration rollback and release rollback
**Status: DONE — 2026-09-03.** Documented in `docs/BACKUP-AND-ROLLBACK.md` and
drilled: the stack was deployed on tag `rel-002`, then rolled back to
`rel-001`, coming back healthy on the older tag.

The distinction that matters is written down plainly, because reaching for the
wrong one makes things worse: a release rollback is a tag change and is only
safe if the release did not migrate the schema. Prisma's `migrate deploy` is
forward-only, so there is no down migration to run — if the bad release
migrated, the route back is the restore in item 5. That is why a backup is
taken immediately before every deployment rather than nightly only.

Also recorded: `IMAGE_TAG=dev` cannot be rolled back to, because the tag moves.
Releases need immutable tags — a commit SHA or a build number — so that
"the previous image" still exists when it is needed.


### 11. Load baseline
**Status: DONE — 2026-09-03.** `scripts/load-baseline.mjs`, no dependency to
install, percentiles from every sample rather than a running average.

| Endpoint | Conc. | req/s | p50 | p95 | p99 |
| --- | ---: | ---: | ---: | ---: | ---: |
| API `/healthz` | 20 | 1,866 | 7.9 ms | 24.7 ms | 41.1 ms |
| API `/readyz` (database) | 20 | 684 | 23.7 ms | 54.9 ms | 102.9 ms |
| API `/metrics` | 10 | 316 | 30.2 ms | 44.0 ms | 53.4 ms |
| Portal `/login` (production build) | 20 | 335 | 57.5 ms | 82.2 ms | 92.4 ms |

Zero failures throughout. Hundreds of requests per second is orders of
magnitude beyond what a pilot needs, so the constraint will be correctness and
operations, not throughput. The database is the cost: `/healthz` and `/readyz`
differ only by touching Postgres, and that is 2.7× the throughput and 2× the
p95.

One trap worth recording: the same portal page measured **10.6 req/s at p50
803ms** under `next dev`, against **335 req/s at 57.5ms** from the production
image — a 30× difference from on-demand compilation alone. Never baseline a
development build.

Not measured: the Agent's decision path, because its latency is dominated by
the Partner's own database and a number taken on this laptop would describe
this laptop. The Agent now instruments it instead (histogram, breach counter),
collected by the Partner. Also not measured: soak behaviour, and write paths.
See `docs/LOAD-BASELINE.md`.


### 12. Penetration test at application level
**Status: DONE for what can be automated — 2026-09-03.**
`scripts/pen-probe.mjs`: 31 adversarial probes run against a live instance from
outside, with no credentials. All pass. It exits non-zero on any critical or
high finding, so it can gate a release.

Covered: anonymous access to protected routes, forged tokens including
`alg:none`, private key material in the published JWKS, stack traces in error
bodies, SQL injection, CORS origin reflection, unauthenticated flood control,
oversized bodies, per-person identifiers in any response, `TRACE`/`TRACK`, and
framework disclosure.

**One real finding, fixed.** Unauthenticated traffic was not rate limited at
all — 150 anonymous requests drew no `429` and no rate-limit headers. The cause
was guard ordering: `AuthGuard` runs before `RateLimitGuard`, so a caller who
never authenticates is rejected before the limiter runs, and every §94 budget
was correct and inapplicable. Reordering would have collapsed §94 to a per-IP
rule for everyone, so the fix is a coarse outer bound instead —
`IpRateLimitGuard` at 600/minute per client IP, before authentication, with the
per-principal limits untouched. Verified: 700 anonymous requests give exactly
600 × 401 and 100 × 429, while 200 requests to `/healthz` stay exempt.

Two of the probes were themselves wrong at first — one that could not fail (a
burst below the limit) and two that could not pass (`fetch` refuses to send
`TRACE`). Both fixed; both were reporting on the probe rather than the server.

**Still needed before the pilot carries a second Partner:** an engagement by
someone who does this for a living. Business-logic abuse, the approval workflow
as an adversary would use it, cross-organization access with two real sessions,
the portal's client side, and dependency review are all outside what these
probes can reach. See `docs/SECURITY-REVIEW.md`.

---

### 13. Meta and Google external activation
**Status: BUILT AND VERIFIED END TO END — 2026-09-09. Blocked on platform
credentials, not on code.**

Previously modelled and gated but entirely unimplemented: no adapter, no API
client, and a `PENDING_CHANNEL_CHECK` state nothing ever cleared.

**Oolix side.** A Channel Eligibility Service implementing §47.5 / §48.4, with
default-deny throughout — an unknown provider, an absent capability flag or a
missing policy all block, and the verdict builder refuses an empty check list
so a refactor that drops the checks fails closed. Connection management refuses
to store credentials at all (§17). An Agent-facing status endpoint records the
resource id and counts, rejecting a report for another Partner's activation or
for one that never cleared eligibility.

**Agent side.** Per-platform normalization and SHA-256 hashing — Meta wants
bare digits, Google wants E.164, and one shared normalizer would be wrong for
one of them. A Meta Custom Audiences adapter and a Google **Data Manager API**
adapter (§48.2 forbids the old Ads API for new work). Google refuses to upload
without explicit granted consent; the zero value is "unspecified" and fails,
because hardcoding `CONSENT_GRANTED` would assert a lawful basis nobody
checked. A bulk export restricted to one activation's fresh materialization and
to the fields the Partner explicitly mapped. A sync loop where a kill switch,
revocation or end date triggers **removal from the platform**, not merely a
skip.

**Verified against a live stack** — `pnpm verify:channels`, now part of
`pnpm verify`. It adapts to the deployment: with the flag off it proves §84's
refusal, with it on it walks the whole gate. Both states pass.

| Verified | |
| --- | --- |
| A connection carrying an access token | refused (§17) |
| A credential hidden among capability flags | refused |
| Connection status | derived, never accepted from the caller |
| An unconfirmed capability | BLOCKS — activation FAILED |
| A blocked activation | no manifest signed, no resource row |
| A blocked activation | no longer servable by the Agent (§75) |
| Once the platform confirms | READY, manifest signed **after** the verdict |
| Disconnect | capabilities cleared, cannot be inherited on reconnect |
| A revoked connection | can no longer pass eligibility |
| The channel tables | no column for a credential or an identifier |

**What is not done, and cannot be here:** Meta App Review for
`ads_management`, Google Data Manager access and a developer token, and
verification against the live API documentation (§48.2 requires this
explicitly). Until those exist, "it works" means it matches the documented
contract and passes against a faithful fake. Plus the account-topology decision
and a privacy/legal review for the path on which customer data leaves the
Partner boundary. See `docs/EXTERNAL-CHANNELS.md`.

---

## Explicitly out of scope for the pilot


### The remaining scale work
Batched materialization, bounded revocation lists, and expired-member cleanup.
All three are slow burns rather than walls, and none bite at pilot volumes.
See the scale audit for measurements.

---

## Blocked on counterparties, not on engineering

Seven §87 items cannot be closed by writing code:

- A verified Buyer and two Data Partners onboarded
- Each Partner with a live-tested capability set and placement
- Commercial terms, approval SLA, lead definition and payout basis agreed
- A synthetic campaign completed before real traffic
- Privacy and legal review for the launch jurisdiction

These need signatures. They should start in parallel with P0, because they take
longer than the engineering does.
