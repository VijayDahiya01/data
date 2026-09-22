# Oolix — Privacy-Safe Partner Media Activation

Implementation of **Oolix MVP Master Functional, Technical & Implementation
Specification v5** (`docs/`). Part III (§64+) and Part IV (§89+) of that
document are the canonical implementation contract; where earlier sections
disagree, Part IV wins, then Part III.

## The one rule everything else serves

> Oolix is the control plane. Data Partners remain the customer-data owners.

A Buyer can acquire qualified demand through partner-owned websites and apps
**without any Data Partner handing its customer database to Oolix or to the
Buyer**. Concretely, in this codebase:

- The central database has **no** `customers`, `audience_members`,
  `segment_members`, or cross-partner identity table, and **no column anywhere
  stores a `partner_user_id`** (§54, §73). `apps/api-gateway/prisma/schema.prisma`
  states this at the top; treat a migration that violates it as a design defect.
- Segment membership is resolved **inside the Partner**, by the Partner Agent,
  against the Partner's own store (§12, §45).
- Attribution uses an **opaque** 32-byte random token. It encodes nothing; only
  `SHA-256(token)` is stored centrally (§71, §90).
- Nothing serves and nothing uploads without a **signed, partner-bound,
  time-bounded manifest** (§11.2, §75).

## Repository layout

```
apps/
  api-gateway/     Oolix Cloud control plane (NestJS). /v1 user API, /agent/v1 Agent API.
  worker/          Queue consumers, aggregation, schedulers (§55).
  web-portal/      One role-aware web app for every persona (§34).
  mock-partner/    Runnable synthetic Data Partner (§91).
packages/
  contracts/       Canonical enums, states, error registry, money (§66, §76, §77, §89).
  db/              Canonical schema, migrations, seed and Prisma client (§73, §95, §96).
  manifest-schema/ Canonical JSON + ES256 manifest signing/verification (§75).
  auth-rbac/       Principals, RBAC scoping, OIDC, Agent workload auth (§66, §92).
  observability/   Structured logging, PII redaction, metrics and alerts (§78).
  sdk-web/         @oolix/ad-sdk-web — render, timeout, fallback, click (§68).
partner-agent/     Go. Runs INSIDE the Data Partner. Local ad decisions (§45, §69).
infra/             docker-compose dependencies: Keycloak realm, LocalStack, mock partner DB.
implementation_examples/  OpenAPI, k8s starter, agent config, seed data (Appendix A).
docs/              The v5 specification.
```

`services/*` from §61 are implemented as **modules inside `apps/api-gateway`**,
following §61's own guidance: _"Start as a modular monolith… Do not create
dozens of microservices before traffic and team size justify them."_

## Prerequisites

| Tool             | Version                  | Notes                              |
| ---------------- | ------------------------ | ---------------------------------- |
| Node.js          | 24.19.0                  | pinned in `.nvmrc`                 |
| pnpm             | 10.20.0                  | `corepack enable`                  |
| Go               | 1.27.0                   | Partner Agent (§64 requires 1.24+) |
| Docker + Compose | Engine 29.x / Compose v5 | dependencies only                  |

## Quickstart

```bash
pnpm install
cp .env.example .env

pnpm infra:up          # starts dependencies and waits until they are ready
pnpm db:migrate
pnpm db:seed

pnpm dev:api           # http://localhost:4000
pnpm dev:web           # http://localhost:3000
pnpm dev:worker
pnpm dev:mock-partner  # http://localhost:4001
```

Partner Agent (separate toolchain, runs as if inside the Partner):

```bash
cp partner-agent/config.example.yaml partner-agent/config.local.yaml
pnpm agent:run         # http://localhost:8082/healthz
```

Verify the §91 fixtures end to end:

- <http://localhost:4001/?user=U123> — eligible; an approved ad renders
- <http://localhost:4001/?user=U456> — not in any segment; house fallback renders

### Local endpoints

| Service               | URL                                                                  |
| --------------------- | -------------------------------------------------------------------- |
| Web portal            | <http://localhost:3000>                                              |
| API                   | <http://localhost:4000> (`/healthz`, `/readyz`)                      |
| Partner Agent         | <http://localhost:8082> (`/healthz`, `/readyz`) — see the note below |
| Mock Partner          | <http://localhost:4001>                                              |
| Keycloak              | <http://localhost:8081> (admin / admin)                              |
| Postgres (Oolix)      | `localhost:5432` — oolix / oolix                                     |
| Postgres (Partner)    | `localhost:5433` — partner / partner                                 |
| Redis (Oolix)         | `localhost:6379`                                                     |
| Redis (Partner-local) | `localhost:6380` — frequency and pacing state (§76.1)                |
| LocalStack            | <http://localhost:4566> — S3 + SQS                                   |

The two Postgres instances and two Redis instances are **deliberately
separate**. `partner-postgres` stands in for the Data Partner's restricted
audience view (§7.1) and Oolix holds no credential to it; `partner-redis` holds
partner-local frequency and pacing state, which §76.1 requires be shared across
Agent replicas and never mixed with control-plane data.

### Using the portal

`pnpm dev:web` serves the portal at <http://localhost:3000>. Sign in with any
seeded address and the password `password` — identity is delegated to the local
Keycloak realm, so Oolix never sees a password (§64).

Keycloak then asks for a **one-time code**: the realm requires a second factor
for everyone (§4.2, §82), because the API refuses the privileged roles without
it. The seeded identities all carry the same development authenticator secret,
`oolix-dev-totp-secret`, so you can add it once to any TOTP app (choose "enter
a setup key") and it works for every one of them. The e2e suites compute the
code themselves — see `e2e/lib/auth.ts`.

That secret never reaches a deployment: these identities are merged in only
when `KC_SEED_USERS` is exactly `true`, and `render-realm.mjs` refuses to seed
them at all into a realm that requires TLS.

What you can do end to end, in a browser:

| As                              | You can                                                                                                                                                                    |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `demo@example.test`             | **Everything.** One login, four organizations — switch between Buyer, Data Partner, Network sponsor and Oolix admin from the sidebar. No second account, no re-login (§34) |
| `buyer.admin@example.test`      | Build an audience from the attribute taxonomy, see which Data Partners can evaluate it, then run §9's ten-step campaign through approval, delivery and outcomes            |
| `partner.approver@example.test` | Review a request against §41's checklist and approve, request a change, reject or extend                                                                                   |
| `partner.admin@example.test`    | Publish audience **capabilities** (which attributes you can evaluate — never your field names), publish prebuilt segments, manage placements, kill switches and payouts    |
| `partner.security@example.test` | Register and revoke Partner Agents (§92) — deliberately a different role from the commercial admin                                                                         |
| `finance@example.test`          | Approve and settle payouts, raise and resolve disputes (§83.1)                                                                                                             |
| `oolix.admin@example.test`      | Platform operations — aggregates and Agent health only (§98)                                                                                                               |

`pnpm test:e2e:portal` drives all of that in Chromium — 20 tests covering the
full build-and-approve journey, segment publishing, and a sweep of every screen
for all four personas. It is the fastest way to confirm the portal still works.

**Where audiences are actually built.** Not in Oolix — and after the v6 change
spec, not by browsing anyone's segments either.

A Buyer describes who they want to reach using the Oolix attribute taxonomy
(Buyer → **Audiences**). Oolix compares those rules to each Data Partner's
published **capabilities** — which standardized attributes they can answer
questions about — and shows who matches. The rules then travel to the matching
Partners' Agents, which evaluate them against their own data and return a reach
**range**. Nothing about people comes back: §8.2 has no field that could carry a
count, and a cohort under the publishable minimum returns no range at all.

On approval the Agent compiles the rules into a Partner-local membership index
(§11) and the ad decision becomes one indexed lookup (§12). The members never
leave the Partner's database, and the translation from `payment_method` to
whatever that Partner actually stores lives in the Agent's own config file —
§17 keeps Partner local field names out of Oolix entirely.

The v5 path still works: a Partner with an existing CDP audience publishes it
under Partner → **Prebuilt segments**, and a campaign targets either an Audience
Group or a segment, never both (§19).

The access token never reaches the browser: every API call is made by the Next
server, and the session cookie is sealed and `httpOnly` (§82). A test asserts
it.

### Seed identities

Local Keycloak users, all with password `password` (§65, §95):

`buyer.admin@` · `buyer.operator@` · `partner.admin@` · `partner.security@` ·
`partner.approver@` · `partner.finance@` · `network.admin@` · `finance@` · `analyst@` ·
`oolix.admin@` — all `@example.test`.

> §95: seeding refuses to run against production. Local seed credentials must
> never exist in shared, staging or production environments.

### If the Agent will not start

`pnpm agent:provision` probes for a bindable port and writes it into
`partner-agent/config.local.yaml`; the verification scripts read it back, so the
Agent is not always on 8082.

This exists because Windows reserves TCP ranges dynamically for Hyper-V and
WSL2, and the reservation moves. On this machine 8082-8281 became reserved
mid-session and the Agent failed to bind with

```
bind: An attempt was made to access a socket in a way forbidden by its access permissions
```

which reads like a permissions problem but means the port is reserved. Check
with:

```powershell
netsh int ipv4 show excludedportrange protocol=tcp
```

To pin a port permanently instead (needs an elevated shell):

```powershell
net stop winnat
netsh int ipv4 add excludedportrange protocol=tcp startport=8082 numberofports=1 store=persistent
net start winnat
```

## Windows / WSL2 notes

This repo was bootstrapped on Windows with **Docker Engine inside WSL2 Ubuntu**
rather than Docker Desktop. Two consequences:

1. `docker` on the Windows PATH is a shim (`%USERPROFILE%\bin\docker.cmd`) that
   forwards into WSL. If you install Docker Desktop later, its `docker.exe`
   takes precedence from the System PATH — delete the shim to avoid ambiguity.
2. WSL shuts its VM down when no client is attached, which would restart every
   container mid-session. `pnpm infra:up` holds a keepalive client open and
   `~/.wslconfig` raises `vmIdleTimeout`. `wsl --shutdown` still stops
   everything deliberately.

`pnpm infra:up` detects all of this and no-ops on Linux, macOS and Docker
Desktop.

## Common commands

```bash
pnpm test              # all tests
pnpm test:unit         # unit only -- no infrastructure needed
pnpm test:integration  # API against real Postgres/Redis/LocalStack
pnpm test:e2e          # browser smoke: the page survives an Agent outage (§43)
pnpm test:e2e:portal   # portal: sign in, build a campaign, approve it (§40, §41)
pnpm typecheck
pnpm lint
pnpm format

pnpm openapi:validate  # lint the canonical contract (§86)
pnpm verify:pack       # implementation pack drift (Appendix A)

pnpm db:studio         # browse the control-plane database
pnpm infra:wait        # block until every dependency is genuinely ready
pnpm infra:down        # stop dependencies
pnpm infra:reset       # stop, DESTROY volumes, start fresh

pnpm agent:build       # build the Go Partner Agent
pnpm agent:test

pnpm verify            # end-to-end phase verifications against a running stack
pnpm verify:phase1     # Partner supply -> READY_FOR_CAMPAIGNS
pnpm verify:phase2     # catalogue, campaign builder, multi-Partner draft
pnpm verify:phase3     # approval workflow, signed manifests, control sync
pnpm verify:phase4     # Partner Agent serving, no central user ID
pnpm verify:phase5     # attribution, CRM lead events, reporting, reconciliation
pnpm verify:phase6     # multi-Partner independence, idempotency, kill switches
pnpm verify:phase7     # §102 settlement arithmetic, disputes, reproducibility
```

### Running the Partner Agent locally

```bash
pnpm agent:provision   # §92 registration: mints a bootstrap token, generates
                       # a P-256 keypair locally, writes config.local.yaml
pnpm agent:build
pnpm agent:run         # http://localhost:8082
```

`pnpm verify` runs all four phases and re-provisions the Agent partway through.
That is not a workaround: **phase 1 revokes Partner A's Agents on purpose**,
because §69.3 revocation is one of the things it verifies. An Agent whose
identity is revoked reports `identity_valid: false` from `/readyz` with
remediation text, rather than quietly serving stale config until its stale
grace expires.

### Re-creating the local Keycloak

Recreating the Keycloak container issues **new OIDC subject ids** for the same
emails. The API deliberately refuses to rebind an email to a different identity
(that check is a real defence against invitation hijacking), so seeded users
would be locked out. Re-run `pnpm db:seed` afterwards: in `development` and
`test` it resets the identity binding so the next login re-links cleanly.

## External channels are off by default

`FEATURE_META_ENABLED` and `FEATURE_GOOGLE_ENABLED` default to `false`.

Per §15, §16, §84 and §63, Meta and Google are **optional adapters behind
explicit eligibility gates**, not a dependency of the core MVP. A connector
cannot run unless its capability/eligibility state is `READY` (§30), and §84
requires re-verifying current provider documentation before enabling either.
The owned-media path must remain fully functional with both disabled.

## Build status against §85

| Phase | Deliverable                                                                             | State                               |
| ----- | --------------------------------------------------------------------------------------- | ----------------------------------- |
| 0     | Foundations: repo, CI, OIDC, org/RBAC, canonical migrations, audit, compose             | exit criteria met                   |
| 1     | Partner supply: profile/policy, segments, reach buckets, placements, Agent registration | exit criteria met                   |
| 2     | Catalogue + campaign builder, creative upload/versioning, budgets                       | exit criteria met                   |
| 3     | Approval + ES256 manifests + control sync                                               | exit criteria met                   |
| 4     | Owned web MVP: connector, membership, ad-decision, web SDK, NO_AD fallback              | exit criteria met                   |
| 5     | Attribution + reporting                                                                 | exit criteria met                   |
| 6     | Multi-partner hardening                                                                 | exit criteria met                   |
| 7     | Billing / payout                                                                        | exit criteria met                   |
| 8     | Mobile (first design Partner's stack only)                                              | blocked: no pilot Partner stack     |
| 9     | Meta pilot (feature-flagged)                                                            | blocked: needs an eligible account  |
| 10    | Google pilot (feature-flagged)                                                          | blocked: needs an eligible account  |
| —     | TEE / cross-partner                                                                     | explicitly out of scope (§28, §104) |

### Audience Builder change spec (v6)

`docs/Oolix_Audience_Builder_Data_Partner_Matching_Change_Spec_v6.docx` inverts
the Buyer flow: audience rules first, Partner matching second, local
materialization third. It is implemented and verified:

| §20 acceptance row | Verified by                                                               |
| ------------------ | ------------------------------------------------------------------------- |
| Audience Builder   | `pnpm verify:v6` — versioned audiences, >=4 rules, required/optional      |
| Capability match   | `pnpm verify:v6` — missing REQUIRED excludes; missing optional scores     |
| Privacy            | `pnpm verify:v6` — no customer rows, field names or exact counts in Oolix |
| Reach estimate     | `pnpm verify:v6:serving` — the Agent evaluates locally, returns a bucket  |
| Campaign link      | `pnpm verify:v6` — one audience version and rule hash, frozen             |
| Partner review     | `pnpm verify:v6:serving` — full rule set, field coverage, safe reach      |
| Materialization    | `pnpm verify:v6:serving` — compiled locally, runtime is a lookup          |
| Owned media        | `pnpm verify:v6:serving` — matching user sees an ad, others get NO_AD     |
| Multi-Partner      | `pnpm verify:v6` — two Partners, different capabilities, one audience     |
| Revocation         | `pnpm verify:v6:serving` — a Partner stop ends local serving              |

`pnpm verify` runs both after the seven phases.

"Exit criteria met" means `pnpm verify` asserts that phase's §85 exit criterion
against a running stack and passes. Phases 8-10 depend on facts that do not
exist yet -- a chosen pilot Partner's mobile stack, and real Meta/Google account
eligibility -- rather than on unwritten code. §84 is explicit that Google's Data
Manager path needs the exact eligible account model verified against current
provider documentation first.

**Before real traffic:** [`docs/GO-LIVE.md`](docs/GO-LIVE.md) works through §87
item by item and says which are done, which are open, and which are blocked on
decisions nobody has made yet.

## Specification

`docs/Oolix_MVP_Master_Functional_Technical_Implementation_Specification_v5.docx`
`docs/Oolix_Audience_Builder_Data_Partner_Matching_Change_Spec_v6.docx`

Citations without a prefix are v5. The v6 change spec is cited as `v6 §7`,
`v6 §11` and so on wherever it changes or adds behaviour.

Source files cite the sections they implement (`§75`, `§92.4`, …). When
changing behaviour, check the citation first — much of this code encodes a
privacy or commercial commitment rather than a preference.
