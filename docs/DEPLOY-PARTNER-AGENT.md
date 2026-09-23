# Deploying the Partner Agent

**This document is for the Data Partner's engineers, not for Oolix.** The
Agent runs inside your infrastructure, on hosts Oolix never touches and holds
no credential to. Roughly **1 hour** once the prerequisites exist.

It covers **where to run it** and **what to give it**.
`partner/pack/INTEGRATION-GUIDE.md` covers **how to configure it** —
the attribute view, the mappings, the placements — and the two are meant to be
read together, this one first.

## What you are actually deploying

One small Go binary, distributed as a container image. It:

- answers ad decisions for your own pages, from your own data, in under 100ms
- evaluates Oolix audience rules **locally** and returns a reach *range*
- never sends a customer identifier anywhere

The whole point of the architecture is that your customer database stays yours.
If a deployment choice here would send customer records to Oolix, it is the
wrong choice — the product claim depends on this boundary, not on a promise.

## The trust boundary, stated plainly

| | |
| --- | --- |
| **Inbound from Oolix** | **None.** Open nothing. If your security team asks what to allow from Oolix, the answer is nothing |
| **Outbound to Oolix** | HTTPS to the Oolix API only, for config sync, manifests and aggregate counts |
| **Who calls the Agent** | **Your backend**, over your private network. §12 requires this — never the browser |
| **What leaves** | Counts and aggregates. No customer identifier, no field name of yours, no exact reach |

That third row is the one most often got wrong. `listen_addr` defaults to
`0.0.0.0:8082` and is a **private** listener. Putting it behind a public load
balancer would expose an endpoint that takes a customer identifier as input.

---

## What you must provide

### 1. A read-only database role — the important one

The Agent reads a restricted view of your own data. The role behind its DSN
must be **read-only** and scoped to exactly the objects the integration guide
defines, and nothing else.

```sql
CREATE ROLE oolix_agent_ro LOGIN PASSWORD '...';
GRANT CONNECT ON DATABASE audience TO oolix_agent_ro;
GRANT USAGE ON SCHEMA public TO oolix_agent_ro;
GRANT SELECT ON oolix_attribute_view TO oolix_agent_ro;
-- and nothing else. No CREATE, no writes outside the Agent's own tables.
```

A superuser DSN here hands a third party's binary the keys to your entire
database. The shipped Kubernetes manifest says the same thing in a comment, and
`pnpm verify:pack` was run against a real database to confirm the limits hold:
reads work, writes to Agent-owned tables work, `CREATE TABLE` is refused.

### 2. Redis — required if you run more than one replica

`state.mode` defaults to `embedded`, which keeps counters in the process.

**With more than one replica, embedded state silently multiplies every
frequency cap.** Two replicas each keep their own counters, so a cap of 2/day
becomes 4/day — in your favour commercially, which is exactly why nobody
notices, and a breach of what you promised your own customers.

So: one replica may use `embedded`. Two or more **must** use
`mode: "redis"` with a Redis you provide. §76.1 requires this state be shared
across replicas and never mixed with control-plane data.

### 3. Compute

Small. The shipped manifest requests `250m` CPU / `128Mi` memory and limits at
`1` CPU / `512Mi`. The decision path's latency is dominated by *your* database,
not by the Agent — which is why Oolix does not publish a latency figure for it
and the Agent instruments it instead, as a histogram bucketed around the §103
100ms budget, for you to collect.

---

## Where to run it on AWS

Three shapes, in increasing order of effort. All are fine; pick what your team
already operates.

### A. ECS Fargate — least to operate

| | |
| --- | --- |
| Task | 0.25 vCPU / 0.5 GB is enough |
| Image | `ghcr.io/<oolix-org>/partner-agent:<sha>` — pin the SHA, never `latest` |
| Networking | Private subnets. **No** public IP. A NAT gateway or VPC endpoint for outbound HTTPS |
| Secrets | `PARTNER_AUDIENCE_DSN` from Secrets Manager, injected as an environment variable |
| Service discovery | Cloud Map, so your backend reaches it by name |
| Scaling | 2 tasks + ElastiCache for state, or 1 task with embedded state |

The Agent keeps its identity keypair on disk (`private_key_path`). On Fargate
that means either an EFS mount, or re-registering on each task start. **Prefer
EFS** — re-registration churns Agent identities in the Oolix registry and makes
the audit trail harder to read.

### B. EC2 with Docker — closest to the reference

```sh
docker run -d --name oolix-agent --restart unless-stopped \
  -p 127.0.0.1:8082:8082 \
  -v /srv/oolix-agent:/state \
  -e PARTNER_AUDIENCE_DSN='postgres://oolix_agent_ro:...@db:5432/audience?sslmode=require' \
  ghcr.io/<oolix-org>/partner-agent:<sha> \
  --config /state/config.yaml
```

The `127.0.0.1:` prefix matters. Without it Docker publishes 8082 past your
security group to the internet, and that port takes a customer identifier as
input.

### C. EKS — use the shipped manifest

`partner/pack/k8s-partner-agent.yaml` is a working starter:
`replicas: 2`, `state.mode: redis`, resource requests and limits, the DSN from
a Secret, and comments explaining each decision. Replace
`REPLACE_WITH_REGISTRY` and `REPLACE_WITH_VERSION`, and prefer an image digest
(`@sha256:...`) over a tag.

---

## The steps

### 1. Pull the image

```sh
docker pull ghcr.io/<oolix-org>/partner-agent:<sha>
docker image inspect ghcr.io/<oolix-org>/partner-agent:<sha> --format '{{.Size}}'
```

~25 MB, runs as uid 65532, and contains no shell. Oolix builds and Trivy-scans
it in CI and pushes it by commit SHA, so you are not building a third party's
software from source, unscanned, to run next to your customer database.

### 2. Register an identity

The Agent generates its own keypair **inside your infrastructure** and
registers the public half. Oolix never sees the private key:

```sh
docker run --rm -v /srv/oolix-agent:/state \
  -e OOLIX_BOOTSTRAP_TOKEN='<one-time token>' \
  ghcr.io/<oolix-org>/partner-agent:<sha> \
  --register --config /state/config.yaml
```

The token is read from `OOLIX_BOOTSTRAP_TOKEN`, not a flag — a flag would put
it in the process list and the shell history. Your **Partner security admin**
mints it in the Oolix portal under *Integrations → Register a new Agent*; §92
makes that deliberately a different role from the commercial admin. It is
single-use and expires in 15 minutes.

Registration is its own mode rather than something start-up does when it finds
no key, and that is a safety property worth understanding: if the state volume
were lost, an Agent that self-registered would quietly mint a second identity
while the first still showed as live in your console. Instead it refuses and
waits for a human.

### 3. Configure

Copy `partner/agent/config.example.yaml` and work through
`INTEGRATION-GUIDE.md`. The fields that decide whether it works at all:

| Field | Gets wrong how |
| --- | --- |
| `oolix.api_base_url` | Must be the **exact** string Oolix publishes as its public URL — it is signed as the assertion audience. Reaching the same API by another address fails with `Client assertion verification failed`, which does not hint at the cause |
| `connector.dsn` | The read-only role from above |
| `mapping` | Singular. The parser reads `mapping:`; a `mappings:` block is skipped, audience evaluation switches itself off, and the Agent logs one INFO line and reports healthy |
| `state.mode` | `redis` if replicas > 1. See above |

Config parsing is strict: an unknown key stops the Agent and names it, rather
than being silently skipped.

### 4. Point your backend at it

Your backend calls the Agent; the browser never does.

```
POST http://oolix-agent.internal:8082/private/v1/ad-decision
{ "partner_user_id": "<your own identifier>", "placement_id": "<the placement KEY>" }
```

`placement_id` carries the placement **key**, not a UUID. A UUID there returns
`NO_ELIGIBLE_CAMPAIGN`, which is indistinguishable from having no campaigns.

Clicks go to the same listener, `POST /private/v1/click`, carrying the
`click_token` the decision returned. The token is opaque — 32 random bytes
encoding nothing — and only its SHA-256 is ever stored centrally. It is what
ties an ad to a lead, so a lost token means inventory you served and cannot
bill for.

The full route list, all on the private listener:

```
POST /private/v1/ad-decision    your backend, per impression
POST /private/v1/click          your backend, per click
GET  /healthz                   liveness
GET  /readyz                    touches your database and the sync state
GET  /version
GET  /metrics                   Prometheus exposition, for you to scrape
```

### 5. Prove it

```sh
curl -s localhost:8082/healthz
curl -s localhost:8082/readyz        # touches your database
curl -s localhost:8082/metrics | head
```

Then a real decision, per `INTEGRATION-GUIDE.md` §8. A `SHOW` with a
`click_token` means the whole chain works.

---

## Monitoring — yours, not ours

The Agent exposes `/metrics` in Prometheus format: decisions by outcome and
reason, a duration histogram around the 100ms budget, budget breaches, and
control-sync failure count and age.

**Only you can collect these.** The Agent runs inside your infrastructure and
Oolix deliberately cannot reach it; asking you to open a hole for us would
contradict the whole design. `oolix/infra/monitoring/` has alert rules you can adapt.
Two are worth having from day one:

- **control-sync age** — if config stops syncing, the Agent serves a stale
  world until `stale_grace` expires, then stops serving
- **decision latency p95** against 100ms — breaches mean your database, not the
  Agent

No metric carries a per-person label, and there is a test on each side
asserting that. A label is exactly where an identifier ends up by accident, and
monitoring data outlives and outtravels every other copy.

---

## When no ad appears

`INTEGRATION-GUIDE.md` has the full table. The deployment-shaped causes:

| Symptom | Cause |
| --- | --- |
| `SEGMENT_SOURCE_ERROR`, `duration_ms` just over 100 | Database latency, not the Agent. Check the connection pool and the view's indexes |
| `Unknown or revoked agent` | The identity was revoked, or two Agents share one identity |
| `Client assertion verification failed` | `api_base_url` is not the exact published URL |
| Healthy, serving nobody, one INFO line at start-up | `mappings:` instead of `mapping:` |
| Frequency caps exceeded quietly | Multiple replicas with `state.mode: embedded` |
| `NO_ELIGIBLE_CAMPAIGN` for everything | `placement_id` was given a UUID instead of the placement key |

## What you keep

Worth restating, because it is the reason for every constraint above: no
customer record, no identifier and no field name of yours reaches Oolix. The
central database has no `customers` table, no `audience_members` table and no
column anywhere that stores a `partner_user_id`. Membership is resolved here,
by this binary, against your data.
