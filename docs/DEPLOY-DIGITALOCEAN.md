# Deploying to DigitalOcean

A first deployment, start to finish. Roughly **90 minutes**, most of it waiting
for managed databases to provision.

Everything here is specific to DigitalOcean. `docs/DEPLOYMENT-HANDBOOK.md` has
the provider-neutral version and the Partner side.

---

## What you will create

| | What | Monthly |
| --- | --- | --- |
| Droplet | Basic, **4 vCPU / 8 GB**, Ubuntu 24.04 | ~$48 |
| Managed PostgreSQL 16 | 1 node, **2 vCPU / 4 GB** | ~$60 |
| Managed Valkey (Redis) | 1 node, **1 GB** | ~$15 |
| Spaces | 1 bucket, 250 GB | $5 |
| Cloud Firewall | | free |
| **Total** | | **~$128/month** |

**Choose region `BLR1` (Bangalore).** The spec prices in INR and targets `IN`
geographies, so if real Indian customers are involved, India's DPDP Act governs
where the database physically sits. Every resource below must be in the same
region — cross-region traffic is slow, billed, and leaves the private network.

---

## Step 1 — Droplet

Create → Droplets → **Ubuntu 24.04 (LTS)**, Basic, Regular SSD, 4 vCPU / 8 GB,
region **BLR1**, SSH key authentication (not password).

```sh
ssh root@<droplet-ip>

# Docker Engine + Compose v2
curl -fsSL https://get.docker.com | sh
docker compose version        # expect v2.x

# A non-root user to run the stack
adduser --disabled-password --gecos "" oolix
usermod -aG docker oolix

# Swap. An 8 GB droplet building three Node images will otherwise OOM
# mid-build, and the error points at the compiler rather than at memory.
fallocate -l 4G /swapfile && chmod 600 /swapfile
mkswap /swapfile && swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
```

---

## Step 2 — Managed databases

**PostgreSQL:** Create → Databases → PostgreSQL **16**, BLR1, 2 vCPU / 4 GB.

**Valkey:** Create → Databases → Valkey (DO's Redis), BLR1, 1 GB.

Both take ~5 minutes. While they provision:

### Lock them to the droplet

On each database: **Settings → Trusted Sources → add your Droplet.** Until you
do this the database is reachable from anywhere with the password, and DO will
warn you about it on the dashboard rather than blocking it.

### Note the connection details

DO gives you a host, **port 25060** (not 5432), a user, a password, and
`sslmode=require`. You need two strings from this:

```
DATABASE_URL=postgresql://doadmin:PASS@HOST:25060/defaultdb?sslmode=require
REDIS_URL=rediss://default:PASS@VALKEY_HOST:<port DO shows you>
```

Note `rediss://` — two s's, meaning TLS. DO's Valkey requires it and will
refuse a plain `redis://`. Copy the port from the dashboard rather than
assuming 6379; DO assigns a non-standard one. Valkey uses a Let's Encrypt
certificate, so unlike some providers you do not need to download a CA bundle.

---

## Step 3 — Spaces bucket

Create → Spaces Object Storage → BLR1, name it `oolix-creatives`.

Then **API → Spaces Keys → Generate New Key**. You get an access key and a
secret shown **once**.

---

## Step 4 — DNS

Point your domain's nameservers at DigitalOcean (`ns1/ns2/ns3.digitalocean.com`),
then Networking → Domains → add two **A** records to the droplet's IP:

```
api     →  <droplet-ip>
app     →  <droplet-ip>
```

Verify before continuing — Let's Encrypt will fail if these do not resolve:

```sh
dig +short api.yourdomain.com app.yourdomain.com
```

---

## Step 5 — Firewall

Networking → Firewalls → Create.

**Inbound — exactly three rules:**

| Type | Port | Source |
| --- | --- | --- |
| SSH | 22 | **your IP only** |
| HTTP | 80 | All IPv4 / IPv6 |
| HTTPS | 443 | All IPv4 / IPv6 |

**Outbound:** leave the defaults (all traffic).

Port 80 is not optional — Let's Encrypt validates over it, and Caddy redirects
it to 443.

**Nothing inbound is needed for Partners.** A Partner Agent makes outbound
HTTPS to your API and Oolix never connects back. If a Partner's security team
asks what to open for you, the answer is nothing.

---

## Step 6 — Get the code onto the droplet

```sh
su - oolix
git clone <your-repo-url> oolix && cd oolix
git checkout <commit-sha>          # pin it; see IMAGE_TAG below
```

No Node or pnpm needed on the droplet — the Dockerfiles build inside Docker.

---

## Step 7 — Configuration

Sign-up confirmations, invitations and password resets are emailed through
**Brevo**, and the API will not start without it. At brevo.com: sign up, then
**Senders, Domains & Dedicated IPs → Domains → Add a domain** and add the DNS
records it shows (its code, DKIM, DMARC) in Networking → Domains — that is what
keeps these emails out of spam. Then **SMTP & API → API Keys → Generate a new
API key**: it starts `xkeysib-`. (The SMTP tab's `xsmtpsib-` key does not work.)

```sh
cp .env.prod.example .env.prod
chmod 600 .env.prod
openssl rand -base64 32        # the portal session secret
nano .env.prod
```

```ini
APP_ENV=production
# An IMMUTABLE tag. `latest` and `dev` move, so rolling back to one rolls back
# to nothing. Use the commit SHA you checked out.
IMAGE_TAG=<commit-sha>

# --- managed services -------------------------------------------------------
DATABASE_URL=postgresql://doadmin:PASS@HOST:25060/defaultdb?sslmode=require
REDIS_URL=rediss://default:PASS@VALKEY_HOST:<port DO shows you>
POSTGRES_USER=doadmin
POSTGRES_PASSWORD=<the managed Postgres password>
# The backup runs pg_dump, which needs the host and port on their own. And the
# database it dumps must be the one DATABASE_URL uses -- on DigitalOcean that
# is `defaultdb`, not `oolix`.
POSTGRES_HOST=HOST
POSTGRES_PORT=25060
POSTGRES_DB=defaultdb

# --- sign-in and email ------------------------------------------------------
PORTAL_SESSION_SECRET=<generated>
EMAIL_PROVIDER=brevo
BREVO_API_KEY=xkeysib-...
# A sender on the domain Brevo verified.
EMAIL_FROM=Oolix <no-reply@yourdomain.com>

# --- public addresses -------------------------------------------------------
API_PUBLIC_URL=https://api.yourdomain.com
WEB_PUBLIC_URL=https://app.yourdomain.com
API_HOST=api.yourdomain.com
APP_HOST=app.yourdomain.com
# An EMAIL, not "internal". This is what switches Caddy to real Let's Encrypt
# certificates; "internal" issues from a local CA that browsers distrust and
# Partner Agents refuse.
TLS_MODE=ops@yourdomain.com

# --- object storage ---------------------------------------------------------
AWS_REGION=blr1
AWS_ENDPOINT_URL=https://blr1.digitaloceanspaces.com
AWS_ACCESS_KEY_ID=<Spaces key>
AWS_SECRET_ACCESS_KEY=<Spaces secret>
S3_CREATIVE_BUCKET=oolix-creatives
CDN_PUBLIC_BASE_URL=https://oolix-creatives.blr1.cdn.digitaloceanspaces.com

# --- alerting ---------------------------------------------------------------
# Real URLs. The renderer refuses a placeholder, because an alert that fires
# into a hostname that does not resolve leaves the dashboard green while
# nobody is told.
ALERT_WEBHOOK_DEFAULT=https://hooks.slack.com/services/...
ALERT_WEBHOOK_ONCALL=https://events.pagerduty.com/v2/enqueue

# --- backups ----------------------------------------------------------------
# Must leave this droplet. See step 8.
BACKUP_DEST=/mnt/oolix-backups

# --- external channels ------------------------------------------------------
FEATURE_META_ENABLED=false
FEATURE_GOOGLE_ENABLED=false
```

The public URLs must match the DNS names **exactly**. Every emailed link is
built from `WEB_PUBLIC_URL`, so a typo sends each confirmation, invitation and
reset somewhere that does not exist while the stack looks healthy.

---

## Step 8 — Backups off the droplet

`BACKUP_DEST` must not be the droplet's own disk. A backup beside the database
survives only the failures that do not matter, and `pnpm preflight` refuses a
local path.

Mount the Spaces bucket:

```sh
sudo apt-get install -y s3fs
echo "<SPACES_KEY>:<SPACES_SECRET>" | sudo tee /etc/passwd-s3fs
sudo chmod 600 /etc/passwd-s3fs
sudo mkdir -p /mnt/oolix-backups
sudo s3fs oolix-backups /mnt/oolix-backups \
  -o url=https://blr1.digitaloceanspaces.com -o use_path_request_style \
  -o allow_other -o uid=$(id -u oolix) -o gid=$(id -g oolix)

echo 'oolix-backups /mnt/oolix-backups fuse.s3fs _netdev,allow_other,url=https://blr1.digitaloceanspaces.com,use_path_request_style 0 0' \
  | sudo tee -a /etc/fstab
```

Create the `oolix-backups` bucket first, separate from creatives.

DO's managed Postgres also takes its own daily backups with point-in-time
recovery — keep both. Theirs protects the database; the stack's scheduled
backup also captures the **manifest signing keys**, which no database backup
contains and without which every cached manifest a Partner Agent holds is
rejected.

---

## Step 9 — The gate

```sh
docker run --rm -v "$PWD:/w" -w /w node:24-alpine node scripts/preflight.mjs --env-file .env.prod
```

Run it from a container so the droplet needs no Node. It refuses placeholder or
reused secrets, an email setup that cannot deliver, non-HTTPS, localhost or
mismatched URLs, `TLS_MODE=internal`, a moving `IMAGE_TAG`, placeholder alert
webhooks, and a local `BACKUP_DEST`.

**Fix everything it reports before continuing.** Each check exists because that
mistake is silent in production.

---

## Step 10 — Deploy

```sh
# Build the three images (~10 minutes on first run)
docker compose -f oolix/infra/docker/compose.prod.yml \
               -f oolix/infra/docker/compose.managed-postgres.yml \
               -f oolix/infra/docker/compose.managed-redis.yml \
               --env-file .env.prod build

# Signing keys — manifests, Agent tokens and sign-ins. Back these up
# immediately (step 11). Idempotent: an existing key is never replaced.
docker compose -f oolix/infra/docker/compose.prod.yml \
               -f oolix/infra/docker/compose.managed-postgres.yml \
               -f oolix/infra/docker/compose.managed-redis.yml \
               --env-file .env.prod --profile init run --rm keys

# Up
docker compose -f oolix/infra/docker/compose.prod.yml \
               -f oolix/infra/docker/compose.managed-postgres.yml \
               -f oolix/infra/docker/compose.managed-redis.yml \
               --env-file .env.prod --profile monitoring up -d
```

The two managed overlays remove the bundled Postgres and Redis, and the Redis
one has to come second. Without them you run both on the droplet, which works
but gives up the backups, failover and patching you are paying DigitalOcean
for.

Certificates take 30–60 seconds on first start. Then:

```sh
curl -s https://api.yourdomain.com/healthz
curl -s https://api.yourdomain.com/readyz      # touches the database
curl -sI https://app.yourdomain.com/login
```

`/readyz` returning `{"status":"ready","checks":{"database":true}}` is the one
that proves the managed database connection works.

---

## Step 11 — Immediately after

**Back up the signing keys.** Whoever holds the manifest key can forge an
activation that a Partner Agent accepts as genuine; losing it means every
cached manifest is rejected and no database restore fixes that.

```sh
docker run --rm -v oolix-prod_api-keys:/k -v /mnt/oolix-backups:/b \
  alpine tar czf /b/signing-keys-$(date +%F).tar.gz -C /k .
```

**Create the first administrator.** A new deployment has no accounts at all.
This creates the Oolix operations organisation, makes one person its
administrator and emails them an invitation; the link sets their password:

```sh
docker compose -f oolix/infra/docker/compose.prod.yml \
               -f oolix/infra/docker/compose.managed-postgres.yml \
               -f oolix/infra/docker/compose.managed-redis.yml \
               --env-file .env.prod \
  run --rm api node dist/cli/create-admin.js --email you@yourdomain.com --name "Your Name"
```

It refuses once an administrator exists; the next ones are invited from the
portal's **Team** page. Everyone else signs up at `https://app.yourdomain.com/signup`
or is invited by their own organisation's admin, and a new organisation waits
for that administrator to verify it.

There is no second factor — `docs/SECURITY-REVIEW.md` records that decision and
what compensates for it.

**Rehearse one restore**, before a Partner's data exists. A backup nobody has
restored is a hypothesis. See `docs/BACKUP-AND-ROLLBACK.md`.

---

## Updating later

```sh
git fetch && git checkout <new-sha>
sed -i "s/^IMAGE_TAG=.*/IMAGE_TAG=<new-sha>/" .env.prod
docker compose -f oolix/infra/docker/compose.prod.yml -f oolix/infra/docker/compose.managed-postgres.yml \
  -f oolix/infra/docker/compose.managed-redis.yml --env-file .env.prod build
docker compose -f oolix/infra/docker/compose.prod.yml -f oolix/infra/docker/compose.managed-postgres.yml \
  -f oolix/infra/docker/compose.managed-redis.yml --env-file .env.prod --profile init run --rm keys
docker compose -f oolix/infra/docker/compose.prod.yml -f oolix/infra/docker/compose.managed-postgres.yml \
  -f oolix/infra/docker/compose.managed-redis.yml --env-file .env.prod up -d
```

The `keys` line adds any signing key a newer release needs and leaves existing
ones alone. Migrations run as their own step and must exit 0 before the apps
start.

**Upgrading from a release that still ran Keycloak** (before 24 September
2026): run preflight first — it lists the Keycloak settings to delete and the
email settings to add — then the lines above. `up -d --remove-orphans` stops the
old Keycloak container. Accounts carry over without passwords, so each person
uses **Forgot your password?** once.

**Rolling back is a tag change — and only safe if the release did not migrate
the schema.** Prisma's `migrate deploy` is forward-only; there are no down
migrations. If the bad release migrated, the route back is a restore. That is
why a backup is taken immediately before every deployment rather than nightly
only.

---

## When it goes wrong

| Symptom | Cause |
| --- | --- |
| The API will not start: `No user-session signing key` | The `keys` step has not run since the release that added the sign-in key |
| The API will not start: `EMAIL_PROVIDER`, `BREVO_API_KEY` or `EMAIL_FROM` | Outside local development a real sender is required — step 7 |
| Sign-up says "check your email" and nothing arrives | Spam folder first. Then the API log's `email_send_failed` line: status 401 is the wrong key (an SMTP key, perhaps), 400 an unverified sender |
| Everything passes preflight but CSP and HSTS headers are absent | `APP_ENV` is not the exact string `production` |
| Certificates never issue | DNS not resolving yet, or port 80 closed in the firewall |
| Database connection refused | The droplet is not in the database's Trusted Sources |
| Database connects locally but not from the droplet | Missing `?sslmode=require`, or port 5432 instead of 25060 |
| Build killed with no error | Out of memory — the swap file in step 1 |
| Alerts never arrive | Placeholder webhooks. The renderer refuses these, so the stack would not have started |

Logs: `docker compose -f oolix/infra/docker/compose.prod.yml -f oolix/infra/docker/compose.managed-postgres.yml -f oolix/infra/docker/compose.managed-redis.yml --env-file .env.prod logs -f <service>`

---

## What this does not cover

- **A managed secret store.** Secrets are read from `.env.prod` at boot.
  Any variable also accepts a `_FILE` form pointing at a path, which is how you
  would wire in DO's secrets or a Vault sidecar later.
- **More than one droplet.** The measured baseline says a pilot does not need
  it. Revisit with real traffic rather than in advance.
- **Meta and Google.** Flag-gated off and not needed for owned media. See
  `docs/EXTERNAL-DEPENDENCIES.md`.
