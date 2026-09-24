# Deployment handbook

Two deployments, on two sides of a boundary that is the point of the product.

**Oolix** runs the control plane — the portal, the API, the database of
approvals and settlements. **The Data Partner** runs the Agent, inside their own
infrastructure, next to a database Oolix has no credential for.

Nothing about that is decorative. Oolix never connects inbound to a Partner, and
the Partner's customer identifiers never leave their network. If someone asks
what firewall rule to open for Oolix to reach them, the answer is none, and it
is worth saying out loud because it is usually the objection that ends.

> Every version below is what the repository actually pins today, not a
> recommendation. Where a version matters, the reason is given.

---

# Part 1 — Oolix side

## 1.1 What to buy

| | Spec | Why this |
| --- | --- | --- |
| Compute | 1 host, **4 vCPU / 8 GB** | Runs API, portal, worker, Keycloak, TLS terminator. Measured ceiling ~700 req/s; a pilot is far below it |
| PostgreSQL | Managed, **2 vCPU / 4 GB, 50 GB** | The database is the cost centre — `/readyz` costs 2.7× `/healthz` purely by touching it |
| Redis | Managed, **1 GB** | Rate limits, idempotency, multi-replica frequency state |
| Object storage | S3-compatible bucket | Creative assets |
| DNS | **Three names** | `api.` `app.` `auth.` on one domain |
| Backup target | Anything **not** this host | NFS, object storage, another region |

Roughly **$120–160/month** on DigitalOcean or Linode; **$250–350** on AWS or GCP
for equivalent managed tiers.

**Pick the region before you provision.** The spec prices in INR and targets
`IN` geographies. If real Indian customers are involved, India's DPDP Act
governs where the database sits, and moving a database between regions later is
a migration rather than a setting.

## 1.2 Exact versions

Pinned in `docker-compose.yml`, `oolix/infra/docker/compose.prod.yml`, `.nvmrc` and
`package.json`. Do not drift from these without testing.

| Component | Version | Notes |
| --- | --- | --- |
| **Node** | **24.19.0** | `engines` enforces `>=24.19.0 <25`. Only needed on the build machine — the containers carry their own |
| **pnpm** | **10.20.0** | `packageManager` field; use `corepack enable` |
| **PostgreSQL** | **16.10** | Both the app database and Keycloak's |
| **Redis** | **7.4** | `--appendonly yes` |
| **Keycloak** | **26.5** | Runs `start`, not `start-dev` — production mode refuses insecure defaults, which is the point |
| **Caddy** | **2.10** | TLS terminator, automatic certificates |
| **Prometheus** | **v3.7.3** | Optional, opt-in profile |
| **Alertmanager** | **v0.28.1** | Optional, and useless until the webhooks are real |
| **Docker Engine** | 24+ with Compose v2 | |

**Only Node and pnpm are needed on the host**, and only to build. If you build
elsewhere and pull images, the server needs nothing but Docker.

## 1.3 Ports

Published to the internet: **80 and 443 only.**

| Port | Service | Exposure |
| --- | --- | --- |
| 443 / 80 | Caddy | Public. 80 redirects and answers ACME |
| 4000 | API | Internal only |
| 3000 | Portal | Internal only |
| 8081 | Keycloak | Internal only |
| 4100 | Worker metrics | Internal only |

The API, portal and Keycloak publish **no host ports**. They are reachable only
through the terminator. This is deliberate: an internal service on a public port
is the most common way a hardened stack turns out not to be.

**Outbound** from the host: the database, Redis, object storage, and Let's
Encrypt. **Inbound from Partners: nothing.**

## 1.4 Deploy

```sh
# 1. Build machine only
corepack enable && corepack prepare pnpm@10.20.0 --activate
pnpm install --frozen-lockfile

# 2. Configuration
cp .env.prod.example .env.prod
openssl rand -base64 32        # once per secret, never reused

# 3. The gate. It refuses what a deployment does not notice.
pnpm preflight --env-file .env.prod

# 4. Signing keys — ONCE, and back them up immediately
docker compose -f oolix/infra/docker/compose.prod.yml --env-file .env.prod \
  --profile init run --rm keys

# 5. Up
docker compose -f oolix/infra/docker/compose.prod.yml --env-file .env.prod up -d
```

Use the managed overlays for whatever is managed. The database should be;
Redis may be:

```sh
docker compose -f oolix/infra/docker/compose.prod.yml \
               -f oolix/infra/docker/compose.managed-postgres.yml \
               -f oolix/infra/docker/compose.managed-redis.yml \
               --env-file .env.prod up -d
```

`compose.managed-postgres.yml` removes the bundled Postgres and requires
`DATABASE_URL` and — separately — `KEYCLOAK_JDBC_URL`. **Keycloak needs a JDBC
string, which is not the same as `DATABASE_URL`.** Give it the `postgres://`
form and it fails at start-up with a driver error that never mentions the
format. `compose.managed-redis.yml` removes the bundled Redis and requires
`REDIS_URL`; leave it out to keep Redis on the host, and when it is used it
must come second.

## 1.5 The three that will bite you

**`IMAGE_TAG` must be immutable.** A commit SHA or a build number, never
`latest` or `dev`. A moving tag means "the previous image" no longer exists at
the moment you need it. `pnpm preflight` refuses the moving ones.

**The three public URLs must agree exactly.** An OIDC issuer is compared as a
string. If the browser reaches Keycloak by one name and the portal's server side
by another, every token is rejected as invalid while everything looks correct.
See `docs/HTTPS-DRILL.md`.

**Back up the signing keys the moment you create them.** Whoever holds the
manifest key can forge an activation a Partner Agent will accept as genuine —
it is the most sensitive artifact in the system. Lose it instead and every
cached manifest is rejected, and no database restore fixes that. The scheduled
backup refuses to write a backup that is missing them.

## 1.6 Backups

On by default — the `backup` service, every 24 hours. It reaches Postgres over
the network rather than through the Docker socket, because mounting that socket
into a long-lived service hands it root on the host.

**`BACKUP_DEST` must leave this host.** A backup beside the database survives
only the failures that do not matter. `pnpm preflight` refuses a local path.

Rehearse one restore before a Partner's data is in it. `docs/BACKUP-AND-ROLLBACK.md`
has the procedure and the decision table for when to roll back a release versus
when to restore.

---

# Part 2 — Partner side

This is what you send a Data Partner. `partner/pack/INTEGRATION-GUIDE.md`
is the version written for them; this is the summary.

## 2.1 What the Partner provides

| | What | Why |
| --- | --- | --- |
| Compute | 1–2 vCPU / 1 GB, or a Kubernetes namespace | The Agent is ~25 MB and does very little work per request |
| A database view | **Pre-computed** segment membership | Never a join against live booking or order tables |
| Redis | Only if running **more than one replica** | §76.1 — see below, it costs them their promise to a customer |
| Outbound HTTPS | To the Oolix API | Nothing inbound. Oolix never connects to them |

**Only `postgres_view` is implemented** as a connector today. A Partner on MySQL,
BigQuery or Snowflake needs either a Postgres-compatible view or a connector
that does not exist yet — establish this before promising a date.

## 2.2 Exact versions

| Component | Version | Notes |
| --- | --- | --- |
| **Agent image** | published by Oolix | ~25 MB, distroless, runs as uid 65532, **no shell inside** |
| Go | **1.27** | Only if they build it themselves, which they should not need to |
| PostgreSQL | any modern version | The Partner's own; Oolix never connects to it |
| Redis | **7.4** | Partner-local. Must never share a datastore with Oolix |
| Kubernetes | any | `partner/pack/k8s-partner-agent.yaml` is a working starting point |

Pin the image by version or digest. A moving tag means the binary they audited
is not necessarily the one running.

## 2.3 Ports

| Port | What | Exposure |
| --- | --- | --- |
| **8082** | Private ad-decision API | **Partner's internal network only** |

**Their backend calls it, never a browser.** The request carries a customer
identifier; putting that endpoint where a browser can reach it would put the
identifier in a page, in browser history, and in referrer headers. That is the
one rule which, if broken, undoes the product's central claim.

## 2.4 The two settings that matter most

**`state.mode`.** `embedded` is **single replica only**. With three replicas
each keeps its own counters, so a frequency cap of 2/day silently becomes 6/day
— and the Partner has promised their customer something that is not happening.
Nothing in the Agent can detect this: a process cannot know how many copies of
itself are running. If `replicas > 1`, `state.mode` must be `redis`.

**`connector.membership_query`.** Must read **pre-computed** membership. A join
against live booking or order tables blows the 30 ms decision budget and puts
production load on the Partner's database on every page view.

## 2.5 Their environment

```
PARTNER_ORG_ID        the id Oolix issues at onboarding
PARTNER_AUDIENCE_DSN  their own database, from their own secret manager
```

Oolix never sees the second one. That is the design, not an oversight.

## 2.6 Onboarding order

1. Oolix creates the Partner organization and issues `PARTNER_ORG_ID`
2. Partner's **security admin** mints a bootstrap token in the portal (§66 —
   deliberately not the same role that approves campaigns)
3. Agent starts, registers, and generates its own keypair **inside** the
   Partner's infrastructure — which is why Oolix cannot impersonate it, and
   therefore why a signed report from an Agent means something
4. Partner publishes a segment and a placement
5. `/readyz` goes green; the Partner appears in the catalogue

---

# Part 3 — Checks

## Before the first Partner connects

```sh
pnpm preflight --env-file .env.prod   # blocks the silent mistakes
pnpm verify                            # 10 phases, 341 checks
pnpm probe                             # 36 anonymous probes
pnpm probe:authed                      # 16 cross-tenant probes
```

The last two are worth running against the real deployment, not only locally.
`probe:authed` needs the password grant, which production disables — run it
against staging.

## Health endpoints

| Endpoint | Meaning |
| --- | --- |
| `/healthz` | Process is alive. Checks **no** dependencies, so a database blip does not restart every replica instead of removing them from rotation |
| `/readyz` | Ready to serve. Touches the database, so it is the expensive one |
| `/metrics` | Prometheus exposition |

On the Agent, `/readyz` also reports config staleness — past the stale grace it
stops serving rather than guessing, because a stale config may already have been
revoked upstream.

## What "it works" looks like

- Portal sign-in redirects to Keycloak and back, once
- A Partner appears in the catalogue with a reach **bucket**, never a number
- An approved activation produces a signed manifest the Agent accepts
- The Agent answers `NO_AD` when its config is stale — that is success, not a bug

---

# Part 4 — Common failures

| Symptom | Cause |
| --- | --- |
| Every token rejected as invalid, everything looks fine | The three public URLs disagree. An OIDC issuer is a string |
| Keycloak fails at start with a driver error | It was given `DATABASE_URL` instead of `KEYCLOAK_JDBC_URL` |
| Keycloak: "Invalid client oolix-web: A redirect URI is not a valid URI" | A realm placeholder was not substituted. The renderer refuses this — check its logs |
| Sign-in works, then every API call is 401 | Keycloak was recreated and issued new subject ids. Correct refusal, not a bug |
| Agent serves `NO_AD` for everything | Config stale, kill switch set, or no manifest verified. Check the Agent's `/readyz` |
| Frequency cap is a multiple of what was agreed | `state.mode: embedded` with more than one replica |
| Alerts never fire | Alertmanager still on `example.invalid`. `pnpm preflight` blocks this |
| Backups "succeed" but restore nothing | Not possible here by design — an empty dump or missing signing keys is a hard failure |

---

# Part 5 — Not covered, deliberately

- **A managed secret store.** Secrets are read from the environment at boot.
  Which store to wire in depends on the host.
- **Meta and Google.** Flag-gated off, and not needed for a pilot on owned
  media. See `docs/EXTERNAL-DEPENDENCIES.md`.
- **Horizontal scaling past one host.** The measured baseline says a pilot does
  not need it. Revisit with real traffic, not in advance.
