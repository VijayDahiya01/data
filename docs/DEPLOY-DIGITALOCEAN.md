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

### Keycloak needs its own database

Keycloak will not share a schema with the application. On the Postgres
instance: **Users & Databases → Add database → `keycloak`**.

Forgetting this produces a crash loop on a missing database *after* everything
else has come up healthy — which reads as an identity problem rather than a
missing `CREATE DATABASE`.

### Note the connection details

DO gives you a host, **port 25060** (not 5432), a user, a password, and
`sslmode=require`. You need three strings from this, and two of them are not
interchangeable:

```
DATABASE_URL=postgresql://doadmin:PASS@HOST:25060/defaultdb?sslmode=require
KEYCLOAK_JDBC_URL=jdbc:postgresql://HOST:25060/keycloak?sslmode=require
REDIS_URL=rediss://default:PASS@VALKEY_HOST:<port DO shows you>
```

**`KEYCLOAK_JDBC_URL` is a JDBC string and `DATABASE_URL` is not.** Giving
Keycloak the `postgresql://` form fails at start-up with a driver error that
never mentions the format. It is the single most common way this deployment
goes wrong.

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
then Networking → Domains → add three **A** records to the droplet's IP:

```
api     →  <droplet-ip>
app     →  <droplet-ip>
auth    →  <droplet-ip>
```

Verify before continuing — Let's Encrypt will fail if these do not resolve:

```sh
dig +short api.yourdomain.com app.yourdomain.com auth.yourdomain.com
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

```sh
cp .env.prod.example .env.prod
chmod 600 .env.prod
for i in 1 2 3 4; do openssl rand -base64 32; done   # one per secret, never reused
nano .env.prod
```

```ini
APP_ENV=production
# An IMMUTABLE tag. `latest` and `dev` move, so rolling back to one rolls back
# to nothing. Use the commit SHA you checked out.
IMAGE_TAG=<commit-sha>

# --- managed services -------------------------------------------------------
DATABASE_URL=postgresql://doadmin:PASS@HOST:25060/defaultdb?sslmode=require
KEYCLOAK_JDBC_URL=jdbc:postgresql://HOST:25060/keycloak?sslmode=require
REDIS_URL=rediss://default:PASS@VALKEY_HOST:<port DO shows you>
POSTGRES_USER=doadmin
POSTGRES_PASSWORD=<the managed Postgres password>

# --- identity ---------------------------------------------------------------
KEYCLOAK_ADMIN=oolix-admin
KEYCLOAK_ADMIN_PASSWORD=<generated>
OIDC_CLIENT_ID=oolix-web
OIDC_CLIENT_SECRET=<generated>
PORTAL_SESSION_SECRET=<generated>
KC_SSL_REQUIRED=external
KC_DIRECT_GRANTS=false
KC_SEED_USERS=false

# --- public addresses -------------------------------------------------------
API_PUBLIC_URL=https://api.yourdomain.com
WEB_PUBLIC_URL=https://app.yourdomain.com
KEYCLOAK_PUBLIC_URL=https://auth.yourdomain.com
API_HOST=api.yourdomain.com
APP_HOST=app.yourdomain.com
AUTH_HOST=auth.yourdomain.com
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

The three public URLs must match the DNS names **exactly**. An OIDC issuer is
compared as a string: if the browser reaches Keycloak by one name and the
portal's server side by another, every token is rejected as invalid while
everything looks correct.

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
reused secrets, seeded development identities, the password grant, non-HTTPS or
localhost URLs, `TLS_MODE=internal`, a moving `IMAGE_TAG`, placeholder alert
webhooks, and a local `BACKUP_DEST`.

**Fix everything it reports before continuing.** Each check exists because that
mistake is silent in production.

---

## Step 10 — Deploy

```sh
# Build the three images (~10 minutes on first run)
docker compose -f infra/docker/compose.prod.yml \
               -f infra/docker/compose.managed.yml \
               --env-file .env.prod build

# Signing keys — ONCE. Back these up immediately (step 11).
docker compose -f infra/docker/compose.prod.yml \
               -f infra/docker/compose.managed.yml \
               --env-file .env.prod --profile init run --rm keys

# Up
docker compose -f infra/docker/compose.prod.yml \
               -f infra/docker/compose.managed.yml \
               --env-file .env.prod --profile monitoring up -d
```

The managed overlay removes the bundled Postgres and Redis. Without it you run
databases on the droplet, which works but gives up the backups, failover and
patching you are paying DigitalOcean for.

Certificates take 30–60 seconds on first start. Then:

```sh
curl -s https://api.yourdomain.com/healthz
curl -s https://api.yourdomain.com/readyz      # touches the database
curl -sI https://app.yourdomain.com/login
curl -s https://auth.yourdomain.com/realms/oolix/.well-known/openid-configuration | head -c 100
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

**Create the first admin.** The realm ships with **no users** — deliberately;
it used to ship thirteen with the password `password`. Create your first
account in the Keycloak admin console at `https://auth.yourdomain.com/admin`
using `KEYCLOAK_ADMIN` / `KEYCLOAK_ADMIN_PASSWORD`, in the **oolix** realm (not
master).

Set a **temporary** password, which attaches the `UPDATE_PASSWORD` required
action so the person chooses their own on first sign-in and you never know it.

**Every account enrols an authenticator on first sign-in.** The realm requires
a second factor (§4.2, §82): after the password, Keycloak shows a QR code for
Google Authenticator, FreeOTP, Microsoft Authenticator or any TOTP app, and the
account is not usable until it is scanned. This is not optional and cannot be
skipped per-user — Keycloak cannot know which Oolix role an account will hold,
so the requirement is realm-wide.

Budget a minute per person for this at the start of a demo, and have the phone
that will scan it in the room. An account that has enrolled on one device
cannot sign in from another without it.

**Prove a privileged role can actually use it**, from your laptop rather than
the droplet — it drives a real browser:

```sh
pnpm verify:mfa \
  --api https://api.yourdomain.com \
  --keycloak https://auth.yourdomain.com \
  --portal https://app.yourdomain.com \
  --user first.admin@yourdomain.com --password '<the temporary password>' \
  --client-secret "$OIDC_CLIENT_SECRET"
```

It signs in twice: once asking for MFA, once not. The first must reach the API
and the second must be refused. Run it against a **freshly created** account —
it walks the enrolment page and prints the secret it enrolled, so keep that
output if the account is one you intend to keep using.

This is worth the two minutes because the failure it catches is invisible from
outside: sign-in succeeds, health is green, and every API call the person makes
answers `AUTH_001`.

**Rehearse one restore**, before a Partner's data exists. A backup nobody has
restored is a hypothesis. See `docs/BACKUP-AND-ROLLBACK.md`.

---

## Updating later

```sh
git fetch && git checkout <new-sha>
sed -i "s/^IMAGE_TAG=.*/IMAGE_TAG=<new-sha>/" .env.prod
docker compose -f infra/docker/compose.prod.yml -f infra/docker/compose.managed.yml \
  --env-file .env.prod build
docker compose -f infra/docker/compose.prod.yml -f infra/docker/compose.managed.yml \
  --env-file .env.prod up -d
```

Migrations run as their own step and must exit 0 before the apps start.

**Rolling back is a tag change — and only safe if the release did not migrate
the schema.** Prisma's `migrate deploy` is forward-only; there are no down
migrations. If the bad release migrated, the route back is a restore. That is
why a backup is taken immediately before every deployment rather than nightly
only.

---

## When it goes wrong

| Symptom | Cause |
| --- | --- |
| Keycloak crash-loops with a driver error | `KEYCLOAK_JDBC_URL` was given the `postgresql://` form |
| Keycloak crash-loops on a missing database | The `keycloak` database was never created (step 2) |
| Every API call 401, everything looks fine | The three public URLs disagree with DNS. An OIDC issuer is a string |
| Sign-in succeeds, then every call 401 `AUTH_001` | The token reached the API without MFA evidence. Either `acr_values` is missing from the authorization request, or the realm was imported without the `oolix-browser` flow. `pnpm --filter @oolix/contracts test:unit` checks both |
| Everything passes preflight but CSP and HSTS headers are absent | `APP_ENV` is not the exact string `production`. `staging` also stops enforcing MFA |
| Certificates never issue | DNS not resolving yet, or port 80 closed in the firewall |
| Database connection refused | The droplet is not in the database's Trusted Sources |
| Database connects locally but not from the droplet | Missing `?sslmode=require`, or port 5432 instead of 25060 |
| Build killed with no error | Out of memory — the swap file in step 1 |
| Alerts never arrive | Placeholder webhooks. The renderer refuses these, so the stack would not have started |

Logs: `docker compose -f infra/docker/compose.prod.yml -f infra/docker/compose.managed.yml --env-file .env.prod logs -f <service>`

---

## What this does not cover

- **A managed secret store.** Secrets are read from `.env.prod` at boot.
  Any variable also accepts a `_FILE` form pointing at a path, which is how you
  would wire in DO's secrets or a Vault sidecar later.
- **More than one droplet.** The measured baseline says a pilot does not need
  it. Revisit with real traffic rather than in advance.
- **Meta and Google.** Flag-gated off and not needed for owned media. See
  `docs/EXTERNAL-DEPENDENCIES.md`.
