# Deploying to AWS

A first deployment, start to finish. Roughly **2 hours**, most of it waiting
for RDS to provision.

Everything here is specific to AWS. `docs/DEPLOY-DIGITALOCEAN.md` is the same
walk on DigitalOcean, and `docs/DEPLOYMENT-HANDBOOK.md` is the
provider-neutral version. For the Data Partner's side of the boundary, see
`docs/DEPLOY-PARTNER-AGENT.md` — they deploy separately, into infrastructure
you never touch.

## Five AWS differences worth knowing first

| | |
| --- | --- |
| **Containers cannot reach the instance role by default** | IMDSv2 defaults to a hop limit of **1**, and a container on Docker's bridge network is one hop further out. The AWS SDK inside the API then finds no credentials and creative uploads fail. Set the hop limit to 2 — §D |
| **Public IPv4 is billed** | Roughly **$3.60/month** per address since February 2024, even while attached to a running instance |
| **RDS gives you one database, not two** | Keycloak will not share a schema. You create `keycloak` yourself, and it needs a **JDBC** URL, which is not the string `DATABASE_URL` holds |
| **ElastiCache is plaintext unless you say otherwise** | `rediss://` requires encryption-in-transit enabled at creation. It cannot be turned on later without replacing the cluster |
| **Nothing is reachable across VPCs** | RDS and ElastiCache are private by default, which is correct. The EC2 security group has to be allowed explicitly on each |

Choose region **`ap-south-1` (Mumbai)**. The spec prices in INR and targets
`IN` geographies, so if real Indian customers are involved the DPDP Act 2023
governs where the data physically sits. `ap-south-2` (Hyderabad) also exists.
Decide **before** provisioning — moving an RDS instance between regions later
is a migration, not a setting.

---

## What you will create

| | What | Approx / month |
| --- | --- | ---: |
| EC2 | `t3.large` — 2 vCPU / 8 GB, Ubuntu 24.04 | ~$60 |
| EBS | 40 GiB gp3 | ~$3.50 |
| RDS PostgreSQL 16 | `db.t4g.small`, 20 GiB gp3 | ~$25 |
| ElastiCache | `cache.t4g.micro`, encryption in transit | ~$12 |
| S3 | one bucket, creative assets | ~$1 |
| Elastic IP | one | ~$3.60 |
| Route 53 | one hosted zone | ~$0.50 |
| **Total** | | **~$105** |

**Verify against current AWS pricing — these move, and they differ by region.**
The measured load baseline (`docs/LOAD-BASELINE.md`) puts a pilot far below
what this handles; the sizing is driven by RAM during image builds, not by
traffic.

---

## Browser path — the AWS Console

### A. Elastic IP first

**EC2 → Network & Security → Elastic IPs → Allocate Elastic IP address**

Allocate in `ap-south-1`, and copy the address. Every DNS name below points
here, and because it never changes, TLS certificates are a one-time job.

### B. Security groups

Create two, in this order, because the second references the first.

**`oolix-app`** — the EC2 instance:

| Type | Port | Source |
| --- | --- | --- |
| SSH | 22 | **My IP**, never `0.0.0.0/0` |
| HTTP | 80 | Anywhere IPv4 + IPv6 |
| HTTPS | 443 | Anywhere IPv4 + IPv6 |

Port 80 is not optional — Let's Encrypt validates over it and Caddy redirects
it to 443.

**`oolix-data`** — RDS and ElastiCache:

| Type | Port | Source |
| --- | --- | --- |
| PostgreSQL | 5432 | **the `oolix-app` security group**, by id |
| Custom TCP | 6379 | **the `oolix-app` security group**, by id |

Source is the *group*, not a CIDR. The instance's private address can change;
the group membership cannot.

**Nothing inbound is needed for Data Partners.** Their Agent makes outbound
HTTPS to your API and Oolix never connects back. If a Partner's security team
asks what to open for you, the answer is nothing.

### C. RDS

**RDS → Create database → Standard create → PostgreSQL 16**

| Field | Value |
| --- | --- |
| Template | Dev/Test (Production adds Multi-AZ and cost) |
| Instance | `db.t4g.small` |
| Storage | 20 GiB gp3 |
| Public access | **No** |
| VPC security group | `oolix-data` |
| Initial database name | `oolix` |
| Backup retention | 7 days |

~10 minutes. Note the endpoint, the master username and the password.

**Then create Keycloak's database.** From the EC2 instance once it exists:

```sh
sudo apt install -y postgresql-client
psql "postgresql://USER:PASS@RDS_ENDPOINT:5432/oolix?sslmode=require" \
     -c 'CREATE DATABASE keycloak;'
```

Skipping this produces a Keycloak crash-loop on a missing database *after*
everything else has come up healthy, which reads as an identity problem rather
than a missing `CREATE DATABASE`.

### D. ElastiCache

**ElastiCache → Redis OSS / Valkey caches → Create**

| Field | Value |
| --- | --- |
| Design | Cluster mode **disabled** |
| Node type | `cache.t4g.micro`, 1 replica or none for a pilot |
| **Encryption in transit** | **Enabled** — this is the one that cannot be changed later |
| Security group | `oolix-data` |

If you enable an AUTH token, it goes in the URL:
`rediss://:TOKEN@endpoint:6379`. Without a token, `rediss://endpoint:6379`.

Note `rediss://` — two s's, meaning TLS. A plain `redis://` against an
encrypted cluster fails at connect with a timeout rather than a protocol error.

### E. S3 and the instance role

**S3 → Create bucket**, `ap-south-1`, name it `oolix-creatives-<something
unique>`, **Block Public Access ON** for all four settings. Creatives are
served through the API, not from a public bucket.

Create a second bucket, `oolix-backups-<unique>`, for §H.

**IAM → Roles → Create role**, trusted entity **AWS service → EC2**. Attach a
policy scoped to those two buckets rather than `AmazonS3FullAccess`:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
      "Resource": [
        "arn:aws:s3:::oolix-creatives-UNIQUE/*",
        "arn:aws:s3:::oolix-backups-UNIQUE/*"
      ]
    },
    { "Effect": "Allow", "Action": ["s3:ListBucket"],
      "Resource": ["arn:aws:s3:::oolix-creatives-UNIQUE",
                   "arn:aws:s3:::oolix-backups-UNIQUE"] }
  ]
}
```

Name it `oolix-app-role`.

**Why a role rather than keys.** `oolix/apps/api-gateway/src/modules/creative/creative.module.ts`
constructs the S3 client with a region and no explicit credentials, so the SDK
uses its default provider chain and finds the instance role by itself. Leaving
`AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` **unset** in `.env.prod` is
therefore both simpler and safer than pasting long-lived keys into a file.

### F. The instance

**EC2 → Launch instances**

| Section | Setting |
| --- | --- |
| Name | `oolix` |
| AMI | **Ubuntu Server 24.04 LTS**, 64-bit x86 |
| Instance type | **`t3.large`** — 2 vCPU / 8 GB |
| Key pair | Create one, download the `.pem` |
| Security group | **existing** → `oolix-app` |
| Storage | **40 GiB gp3** |
| Advanced → IAM instance profile | `oolix-app-role` |
| Advanced → Metadata response hop limit | **2** |

**That hop limit is the AWS-specific trap.** It defaults to 1. Docker's bridge
network puts every container one hop further from the metadata service, so at
the default the SDK inside the API container finds no credentials and creative
uploads fail with an authentication error naming no cause. It can also be set
afterwards:

```sh
aws ec2 modify-instance-metadata-options \
  --instance-id i-xxxxxxxx --http-put-response-hop-limit 2 --http-tokens required
```

Then **Elastic IPs → select yours → Actions → Associate** with this instance.

### G. DNS — three names

You need `api.`, `app.` and `auth.` on one domain, all pointing at the Elastic
IP.

**With a domain:** Route 53 → Hosted zones → your domain → three **A** records
to the Elastic IP.

**Without one, for a demo:** `sslip.io` resolves any name containing an IP
back to that IP, so `api.203-0-113-45.sslip.io` needs no registration at all.
Substitute your address with dashes. Verify before continuing, because Let's
Encrypt will fail if these do not resolve:

```sh
dig +short api.203-0-113-45.sslip.io
```

A real domain is better for anything a Partner will see, but sslip.io is
genuinely fine for a demo and removes registrar delay from the critical path.

### H. Backups off the instance

`BACKUP_DEST` must not be the instance's own disk — a backup beside the
database survives only the failures that do not matter, and `pnpm preflight`
refuses a local path. Mount the backups bucket:

```sh
sudo apt install -y s3fs
sudo mkdir -p /mnt/oolix-backups
# The instance role provides credentials; -o iam_role=auto uses it.
sudo s3fs oolix-backups-UNIQUE /mnt/oolix-backups \
  -o iam_role=auto -o url=https://s3.ap-south-1.amazonaws.com \
  -o endpoint=ap-south-1 -o allow_other -o uid=$(id -u ubuntu) -o gid=$(id -g ubuntu)

echo 'oolix-backups-UNIQUE /mnt/oolix-backups fuse.s3fs _netdev,allow_other,iam_role=auto,url=https://s3.ap-south-1.amazonaws.com,endpoint=ap-south-1 0 0' \
  | sudo tee -a /etc/fstab
```

RDS takes its own automated backups — keep both. RDS protects the database;
the stack's scheduled backup also captures the **manifest signing keys**, which
no database backup contains and without which every manifest a Partner Agent
has cached is rejected, with nothing anywhere reporting the cause.

---

## 1. Base packages

```sh
ssh -i your-key.pem ubuntu@<elastic-ip>

sudo apt update && sudo apt upgrade -y
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker ubuntu && newgrp docker
docker compose version          # expect v2.x
```

Ubuntu AMIs enable no host firewall — the **security group** is what enforces
the restriction, so there is no `ufw` step.

**Swap.** An 8 GB instance building three Node images will otherwise be OOM-killed
mid-build, and the error points at the compiler rather than at memory:

```sh
sudo fallocate -l 4G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

## 2. Code

```sh
sudo mkdir -p /srv && sudo chown ubuntu /srv && cd /srv
git clone https://github.com/VijayDahiya01/data.git oolix && cd oolix
git checkout <commit-sha>       # pin it; the same SHA goes in IMAGE_TAG
git rev-parse --short HEAD
```

No Node or pnpm on the instance — the Dockerfiles build inside Docker.

## 3. Configuration

```sh
cp .env.prod.example .env.prod
chmod 600 .env.prod
for i in 1 2 3 4; do openssl rand -base64 32; done   # one per secret, never reused
nano .env.prod
```

The template defaults to a real deployment and marks every REQUIRED value.
AWS-specific values:

```ini
APP_ENV=production
IMAGE_TAG=<the SHA you checked out>

DATABASE_URL=postgresql://USER:PASS@RDS_ENDPOINT:5432/oolix?sslmode=require
KEYCLOAK_JDBC_URL=jdbc:postgresql://RDS_ENDPOINT:5432/keycloak?sslmode=require
KEYCLOAK_DB_USER=<RDS master username>
KEYCLOAK_DB_PASSWORD=<RDS master password>
REDIS_URL=rediss://ELASTICACHE_ENDPOINT:6379

POSTGRES_USER=<RDS master username>
POSTGRES_PASSWORD=<RDS master password>

TLS_MODE=ops@yourdomain.com
API_HOST=api.yourdomain.com
APP_HOST=app.yourdomain.com
AUTH_HOST=auth.yourdomain.com
API_PUBLIC_URL=https://api.yourdomain.com
WEB_PUBLIC_URL=https://app.yourdomain.com
KEYCLOAK_PUBLIC_URL=https://auth.yourdomain.com

AWS_REGION=ap-south-1
# LEAVE EMPTY on real AWS. This exists for LocalStack and S3-compatible
# providers; setting it points the SDK away from AWS and uploads fail.
AWS_ENDPOINT_URL=
# LEAVE EMPTY. The instance role supplies credentials.
AWS_ACCESS_KEY_ID=
AWS_SECRET_ACCESS_KEY=
S3_CREATIVE_BUCKET=oolix-creatives-UNIQUE
CDN_PUBLIC_BASE_URL=https://api.yourdomain.com/creatives

BACKUP_DEST=/mnt/oolix-backups
```

**The three public URLs must match DNS exactly.** An OIDC issuer is compared as
a string: if the browser reaches Keycloak by one name and the portal's server
side by another, every token is rejected as invalid while everything looks
correct.

## 4. The gate

```sh
docker run --rm -v "$PWD:/w" -w /w node:24-alpine node scripts/preflight.mjs --env-file .env.prod
```

Run it from a container so the instance needs no Node. It refuses placeholder
or reused secrets, seeded development identities, the password grant, an
`APP_ENV` that is not `production`, non-HTTPS or localhost URLs,
`TLS_MODE=internal`, a moving `IMAGE_TAG`, placeholder alert webhooks and a
`BACKUP_DEST` that never leaves the host.

**Fix everything it reports.** Each check exists because that mistake is silent
in production.

## 5. Deploy

```sh
cd /srv/oolix
COMPOSE="-f oolix/infra/docker/compose.prod.yml -f oolix/infra/docker/compose.managed.yml --env-file .env.prod"

docker compose $COMPOSE build                       # ~10 minutes first time
docker compose $COMPOSE --profile init run --rm keys   # ONCE. Back these up.
docker compose $COMPOSE --profile monitoring up -d
```

The managed overlay removes the bundled Postgres and Redis. Six long-running
containers result — `caddy`, `api`, `portal`, `worker`, `keycloak`, `backup` —
plus `prometheus` and `alertmanager` with the monitoring profile. Only Caddy
publishes host ports; the applications publish none at all, so the security
group is not the only thing standing between them and the internet.

Certificates take 30–60 seconds on first start. Then:

```sh
curl -s https://api.yourdomain.com/healthz
curl -s https://api.yourdomain.com/readyz      # touches RDS
curl -sI https://app.yourdomain.com/login
curl -s https://auth.yourdomain.com/realms/oolix/.well-known/openid-configuration | head -c 120
```

`/readyz` returning `{"status":"ready","checks":{"database":true},...,"environment":"production"}`
proves both the RDS connection and that the production protections are on.

## 6. Immediately after

**Back up the signing keys.** Whoever holds the manifest key can forge an
activation a Partner Agent accepts as genuine; losing it makes every cached
manifest invalid, and no database restore fixes that.

```sh
docker run --rm -v oolix_api-keys:/k -v /mnt/oolix-backups:/b \
  alpine tar czf /b/signing-keys-$(date +%F).tar.gz -C /k .
```

**Create the first account.** The realm ships with **no users** — deliberately;
it used to ship thirteen with the password `password`. Keycloak admin console
at `https://auth.yourdomain.com/admin`, realm **oolix** (not master), using
`KEYCLOAK_ADMIN` / `KEYCLOAK_ADMIN_PASSWORD`. Set a **temporary** password so
the person chooses their own and you never know it.

**Every account enrols an authenticator at first sign-in.** The realm requires
a second factor (§4.2, §82) and Keycloak cannot know which Oolix role an
account will hold, so it is realm-wide. Budget a minute per person and have the
phone in the room.

**Prove a privileged role can actually use it**, from your laptop — it drives a
real browser:

```sh
pnpm verify:mfa \
  --api https://api.yourdomain.com \
  --keycloak https://auth.yourdomain.com \
  --portal https://app.yourdomain.com \
  --user first.admin@yourdomain.com --password '<temporary password>' \
  --client-secret "$OIDC_CLIENT_SECRET"
```

It signs in twice, once asking for MFA and once not; the first must reach the
API and the second must be refused. Worth the two minutes because the failure
it catches is invisible from outside — sign-in succeeds, health is green, and
every API call the person makes answers `AUTH_001`.

**Rehearse one restore**, before a Partner's data exists. See
`docs/BACKUP-AND-ROLLBACK.md`.

---

## Updating later

```sh
git fetch && git checkout <new-sha>
sed -i "s/^IMAGE_TAG=.*/IMAGE_TAG=<new-sha>/" .env.prod
docker compose $COMPOSE build && docker compose $COMPOSE up -d
```

Migrations run as their own step and must exit 0 before the apps start.
**Rolling back is a tag change, and only safe if the release did not migrate
the schema** — Prisma's `migrate deploy` is forward-only. If the bad release
migrated, the route back is a restore, which is why a backup is taken
immediately before every deployment rather than nightly only.

---

## When it goes wrong

| Symptom | Cause |
| --- | --- |
| Creative upload fails, credentials error, nothing else broken | IMDSv2 hop limit is 1. Containers cannot reach the instance role — §F |
| S3 calls fail against a nonexistent endpoint | `AWS_ENDPOINT_URL` is set. Leave it empty on real AWS |
| Keycloak crash-loops with a driver error | `KEYCLOAK_JDBC_URL` was given the `postgresql://` form |
| Keycloak crash-loops on a missing database | The `keycloak` database was never created — §C |
| Redis connect times out | ElastiCache has encryption in transit but the URL says `redis://`, or the reverse |
| Database connection refused | `oolix-data` does not allow the `oolix-app` security group |
| Every API call 401, everything looks fine | The three public URLs disagree with DNS. An OIDC issuer is a string |
| Sign-in succeeds, then every call 401 `AUTH_001` | MFA evidence missing. Run `pnpm verify:mfa` |
| CSP and HSTS headers absent, MFA not enforced | `APP_ENV` is not exactly `production` |
| Certificates never issue | DNS not resolving yet, or port 80 closed |
| Build killed with no error | Out of memory — the swap file in §1 |
| Alerts never arrive | Placeholder webhooks. The renderer refuses these, so the stack would not have started |

Logs: `docker compose $COMPOSE logs -f <service>`

---

## AWS features worth adopting later

- **Secrets Manager or SSM Parameter Store** instead of `.env.prod` on disk.
  Every variable already accepts a `_FILE` form pointing at a path, which is
  how a secrets sidecar would deliver them — no code change needed.
- **ECR** so images are built once and pulled, rather than rebuilt per
  instance. CI already pushes to a registry by SHA.
- **RDS Multi-AZ** when a pilot becomes a product. Dev/Test above is a single
  instance.
- **Data Lifecycle Manager** snapshots of the EBS volume, so the signing-key
  volume is captured without a manual step.

## What this does not cover

- **More than one instance.** The measured baseline says a pilot does not need
  it. Revisit with real traffic rather than in advance.
- **Meta and Google activation.** Flag-gated off and not needed for owned
  media. See `docs/EXTERNAL-DEPENDENCIES.md`.
- **The Data Partner's side.** That is theirs to deploy — see
  `docs/DEPLOY-PARTNER-AGENT.md`.
