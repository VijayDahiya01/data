# Deploying the Partner Agent

**This document is for the Data Partner's engineers, not for Oolix.** The
Agent runs inside your infrastructure, on hosts Oolix never touches and holds
no credential to.

There are two ways to run it:

- **[Partner Connect](#the-quick-way-partner-connect)** — recommended. One
  Compose file and a setup page on your own server. About **15 minutes**, and
  nothing is created in your database.
- **[Your own configuration](#the-advanced-way-your-own-configuration)** — for
  teams that want to build Oolix's tables in their own database and configure
  the Agent by hand. Roughly **1 hour** once the prerequisites exist, with
  `partner/pack/INTEGRATION-GUIDE.md` alongside.

Both end the same way: your backend calls the Agent on port `8082`, and you
define your ad slots in the portal.

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

## The quick way: Partner Connect

Nothing to create in your database, no mapping file to write and no SQL job to
schedule. A setup page on your own server does the work, and the Agent keeps
its own cleaned copy of your customer table up to date by itself.

**You need**

- One Linux server inside your network with Docker and Docker Compose. 2 vCPU,
  4 GB of memory and 20 GB of disk are enough for a few million customers.
- Outbound HTTPS from that server to the Oolix API. Nothing inbound.
- A **read-only** login to the database that holds your customer list:
  PostgreSQL, MySQL or MariaDB, Microsoft SQL Server, or MongoDB. No database
  access? CSV or Excel exports work too.

### 1. Start it

On that server:

```sh
mkdir oolix-agent && cd oolix-agent
curl -fsSLo docker-compose.yml https://<oolix-api>/agent/v1/compose
docker compose up -d
```

The portal shows this command with your Oolix address filled in, under **Data
Partner → Integrations → Connect your data**. The file starts the Agent and a
small PostgreSQL of its own (the _local store_). Nothing in it needs editing,
and you can read it first: it is
[`partner/pack/docker-compose.partner.yml`](../partner/pack/docker-compose.partner.yml)
with two values filled in, the Oolix address and the Agent image.

### 2. Open the setup page

```sh
docker compose logs agent | grep setup_password
```

Then open `http://localhost:8083` on that server. From your laptop, tunnel to
it first — `ssh -L 8083:localhost:8083 you@that-server` — and open the same
address. The page listens on the server itself only, because it takes a
database login. To choose the password yourself, set `OOLIX_SETUP_PASSWORD`
(12 characters or more) before `docker compose up`.

### 3. Follow the page

1. **Connect to Oolix.** Paste a one-time code from the same portal page. It
   works once and expires after 15 minutes.
2. **Connect your database.** Give it a read-only login; the page shows the
   statements that create one on each kind of database. Inside Docker,
   `localhost` is the Agent itself — use the database server's address, or
   `host.docker.internal` for a database on the same machine.
3. **Choose the customer table** — the one with a row per customer.
4. **Check the matches.** The page matches your columns to Oolix's standard
   attributes (a date of birth becomes age, `sex` becomes gender, `City`
   becomes city…) and shows, on a sample of your own rows, exactly how each
   value will be stored: `14/04/1992`, `14-04-1993` and `1992-04-13T18:30:00Z`
   all become 14 April 1992; `Bombay` becomes `MUMBAI`; `M`, `1` and `male`
   become `MALE`. Whether `03/04/1990` is 3 April or March 4 is settled from
   the rest of the column when it can be, and asked when it cannot. Values it
   cannot place are listed for you to answer, never guessed.
5. **Orders and bookings** (optional). If you keep a table with one row per
   order, or per booking, pick it: the Agent works out per customer when they
   last bought, how many orders in the last 90 days, what they buy most and
   how they pay, whether they shop online — and when they last booked and
   whether their latest trip was domestic or international. Nothing needs
   preparing: no totals, no summary table. The orders themselves are never
   kept, only those answers. Only the last two years are read.
6. **Consent and publish.** Choose the column that records agreement to
   marketing, then **Publish**.

The Agent then copies the table, tells Oolix which attributes it can answer,
and refreshes the copy every night at the hour you chose. Readiness in the
portal turns green once the Agent has checked in and published. After each
full refresh the portal's **Audience capabilities** page shows how complete
your data is — per attribute, the share of customers with a value — so you
can see what is worth fixing. Only those percentages reach Oolix, and only
you see them.

**Very large customer tables.** On the matches step you can name a
_changed-at_ column: a date-time your system sets whenever a customer row
changes. The nightly refresh then reads only the customers changed since the
last one, and a full refresh still runs once a week — the only kind that
notices customers deleted from your table. Use it only if withdrawing consent
also updates that column; otherwise a withdrawal would wait for the weekly
refresh. **Refresh now** on the setup page always refreshes in full.

### What is kept, and where

| | |
| --- | --- |
| **Your database** | Read once a night with the login you gave. Nothing is created or changed in it |
| **The local store, on your server** | Only the columns you mapped, cleaned, and only for **adults who agreed to marketing** — nobody else could be shown an ad, so nobody else's data is copied. Customer IDs are scrambled (HMAC-SHA256, with a key that never leaves the server). Your database password is stored encrypted |
| **Oolix** | The names of the attributes you can answer and, per campaign, a reach range. Never a name, contact detail, customer ID or any value from your database |

The setup page shows the same and has **Delete all copied data**: it empties
the local store, stops the nightly refresh and withdraws your attributes from
Oolix. Customers who withdraw consent, or leave your table, drop out of the
copy at the next refresh; **Refresh now** on the setup page does it at once.

### 4. Point your backend at it

Exactly as in [step 4 of the advanced way](#4-point-your-backend-at-it): your
backend calls port `8082` on that server with the customer ID it already
knows. The Agent scrambles it the same way before looking it up, so the raw ID
is never stored.

### Keeping it running

- **Upgrade:** `docker compose pull && docker compose up -d`. The copy, your
  choices and the Agent's identity live in Docker volumes and survive.
- **Nothing to back up** that cannot be rebuilt — the copy is rebuilt every
  night. Keep the `agent-state` volume to avoid registering again.
- **Logs:** `docker compose logs -f agent`. They never contain a customer ID
  or a value from your database.

---

## The advanced way: your own configuration

The rest of this document. Choose it if you would rather build the attribute
view in your own database and write the Agent's configuration yourself — see
`partner/pack/INTEGRATION-GUIDE.md` for how to configure it: the attribute
view, the mappings, the placements. The two are meant to be read together,
this one first.

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
| Image | `ghcr.io/vijaydahiya01/data/partner-agent:<sha>` — pin the SHA, never `latest` |
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
  ghcr.io/vijaydahiya01/data/partner-agent:<sha> \
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
docker pull ghcr.io/vijaydahiya01/data/partner-agent:<sha>
docker image inspect ghcr.io/vijaydahiya01/data/partner-agent:<sha> --format '{{.Size}}'
```

~25 MB, runs as uid 65532, and contains no shell. Oolix builds and Trivy-scans
it in CI and pushes it by commit SHA, so you are not building a third party's
software from source, unscanned, to run next to your customer database.

The path is `ghcr.io/<owner>/<repository>/partner-agent`, all lowercase —
registries reject capitals, which is why it does not match the repository's
own spelling. The package takes the repository's visibility: while the
repository is public, anyone can pull it without logging in. If the repository
is ever made private, a pull fails with `denied` until **Oolix** either makes
`partner-agent` public in its package settings on GitHub or issues you a
read-only token for `docker login ghcr.io`.

### 2. Register an identity

The Agent generates its own keypair **inside your infrastructure** and
registers the public half. Oolix never sees the private key:

```sh
docker run --rm -v /srv/oolix-agent:/state \
  -e OOLIX_BOOTSTRAP_TOKEN='<one-time token>' \
  ghcr.io/vijaydahiya01/data/partner-agent:<sha> \
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
