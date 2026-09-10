# Deploying a pilot

What to provision, in what order, and what has to be true before a Partner
connects. Sizing comes from the measurements in `docs/LOAD-BASELINE.md`, not
from guesswork.

## What to provision

| | What | Why this size |
| --- | --- | --- |
| Compute | One host, 4 vCPU / 8 GB | Runs all three services plus Keycloak and the TLS terminator. The measured ceiling is ~700 req/s on a laptop; a pilot is orders of magnitude below that |
| PostgreSQL | Managed, 2 vCPU / 4 GB, 50 GB | The database is the cost: `/readyz` costs 2.7× the throughput of `/healthz` purely by touching it |
| Redis | Managed, 1 GB | Rate limits, idempotency, and multi-replica frequency state (§76.1) |
| Object storage | S3-compatible bucket | Creative assets |
| DNS | Three names: `api.`, `app.`, `auth.` | An OIDC issuer is compared as a string; see `docs/HTTPS-DRILL.md` |
| Backup storage | Off the deployment host | A backup on the same disk survives only the failures that do not matter |

**Managed rather than self-run, for one reason:** somebody else does the
backups, the failover and the patching, and a pilot team has capacity to do
none of the three well.

```sh
docker compose -f infra/docker/compose.prod.yml \
               -f infra/docker/compose.managed.yml \
               --env-file .env.prod up -d
```

The overlay removes the bundled Postgres and Redis and requires `DATABASE_URL`,
`REDIS_URL` and — separately — `KEYCLOAK_JDBC_URL`. Keycloak needs a JDBC
string, which is not the same as `DATABASE_URL`; giving it the `postgres://`
form fails at start-up with a driver error that never mentions the format.

## Network rules

- **Inbound:** 80 and 443 to the host. Nothing else, from anywhere.
- **Outbound:** the database, Redis, object storage, and Let's Encrypt.
- **From Partners:** nothing. A Partner Agent makes outbound HTTPS to the API
  and Oolix never connects back. If someone asks what to open inbound for
  Oolix, the answer is nothing, and that is a selling point rather than an
  inconvenience.
- The API, portal and Keycloak publish no host ports; they are reachable only
  through the TLS terminator.

## First deployment, in order

1. **DNS** for the three names, pointing at the host.
2. **`.env.prod`** from `.env.prod.example`. Every `REQUIRED` value filled, and
   every secret from a real generator. Prefer the `_FILE` form so nothing
   sensitive sits in the environment (see `docs/PILOT-READINESS.md` item 4).
3. **Signing keys, once:**
   ```sh
   docker compose ... --profile init run --rm keys
   ```
   Back up that volume before anything else touches the system. Every manifest
   an Agent caches is signed with it, and the API will refuse to start rather
   than silently mint a replacement.
4. **Start.** The migration runs to completion before the applications start;
   a failed migration stops the deployment rather than leaving a replica
   serving against a half-migrated schema.
5. **Verify over HTTPS** — the four checks in `docs/HTTPS-DRILL.md`, especially
   that Keycloak reports an `https://` issuer.
6. **Monitoring:** `--profile monitoring`, and **replace the placeholder
   webhooks in `infra/monitoring/alertmanager.yml`**. Until you do, every alert
   fires into nothing.
7. **Backups:** schedule `infra/backup/backup.sh` to off-host storage, then
   **restore one** into a scratch environment. A backup nobody has restored is
   a hypothesis.

## Every deployment after that

1. Back up first, and note the migration named in `manifest.txt`.
2. Deploy an **immutable tag** — a commit SHA, never `latest`. CI already
   pushes `ghcr.io/<repo>/<service>:<sha>`. `latest` moves, so rolling back to
   it rolls back to nothing.
3. If it goes wrong: schema unchanged → change `IMAGE_TAG` back and `up -d`;
   schema changed → restore. `migrate deploy` is forward-only.

See `docs/BACKUP-AND-ROLLBACK.md`.

## Before the first Partner connects

- [ ] HTTPS verified end to end, with the chain actually validated
- [ ] Signing keys provisioned **and their backup restored once**
- [ ] Alert webhooks replaced and one alert seen to arrive
- [ ] `node scripts/pen-probe.mjs --base https://api.<domain>` passes
- [ ] The three Partner roles named, and different people (§66.2)
- [ ] A synthetic campaign run end to end on the real deployment

The last one is the only real test. Everything above is preparation for it.

## Not covered here

**Multiple replicas.** The compose file runs one of each. Two API replicas need
the migration step to stay separate (it already is), and two Keycloak replicas
need the `--cache=local` decision revisited. Two Partner Agent replicas require
Redis-backed frequency state (§76.1) — in-process memory silently multiplies a
Partner's frequency cap by the replica count.

**Zero-downtime deploys.** A pilot can take a few seconds of downtime, and
pretending otherwise adds machinery that has to be maintained before it is
needed.
