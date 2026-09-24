# Deploying Oolix to AWS

A first deployment, start to finish, written for someone doing it for the first time. About
**90 minutes**, most of it waiting for things to build.

One EC2 instance in **Mumbai** runs everything Oolix operates, and the database is on **Neon**'s
free plan. Your laptop needs nothing installed beyond a browser and `ssh`, which Windows already
has.

This is **Oolix's side** of the Data Partner boundary only: the portal, the API, the worker and
sign-in. Each Data Partner runs its own Agent inside its own infrastructure — that is
`docs/DEPLOY-PARTNER-AGENT.md`, and it comes after this.

For a paying client, the box at the end of §G swaps Neon for RDS in Mumbai.

## What you will have at the end

| Address                    | What it is                                    |
| -------------------------- | --------------------------------------------- |
| `https://app.<your-host>`  | The portal. Every persona signs in here       |
| `https://api.<your-host>`  | The API. Partner Agents call it               |
| `https://auth.<your-host>` | Sign-in, including the authenticator-app step |

The instance runs these as Docker containers: `caddy` (HTTPS), `portal`, `api`, `worker`,
`keycloak` (sign-in), `redis`, `backup`, and `prometheus` and `alertmanager` for alerts. Only
Caddy can be reached from outside.

## Four things worth knowing first

| | |
| --- | --- |
| **Neon's free plan runs out partway through each month** | It includes 100 compute-hours a month, and Oolix never lets the database sleep: the worker checks Agent health every 60 seconds. That uses about 6 compute-hours a day, so the allowance lasts **roughly 16 days** — then Neon suspends the database until the next month and Oolix stops working. Fine for a demo; for a pilot, a paid Neon plan or RDS (§G) |
| **Neon has no India region** | The database is in Singapore, about 60 ms from Mumbai, and every page makes several database round trips. Expect pages up to a second slower than with the database next door. It also means the data sits in Singapore |
| **Containers cannot reach the instance's AWS role by default** | EC2's metadata service allows one network hop and Docker adds a second, so creative uploads to S3 fail with a credentials error that names no cause. §D sets the hop limit to 2 |
| **Public IPv4 is billed** | About **$3.60/month** per address, even while attached to a running instance |

Two things you do **not** need. **An email service:** Oolix sends no email — an admin creates each
account with a temporary password, and the second factor is an authenticator app. **Certificate
tooling:** Caddy gets and renews Let's Encrypt certificates by itself.

> **Demo or pilot? Read this first.** Oolix cannot yet create the _first_ administrator in an
> empty database: signing in needs an existing Oolix account, and accounts are created by
> inviting from an existing organisation. For a **demo**, §11 loads the synthetic demo
> organisations — the ones the test suite uses — and the question never comes up. A **real
> pilot** with real companies needs a first-administrator step that does not exist yet.

---

## Browser path — the AWS Console

Everything up to a terminal on the instance. Set the region menu (top right) to **Asia Pacific
(Mumbai)** first — every step below must be in the same region.

### A. Elastic IP

**EC2 → Network & Security → Elastic IPs → Allocate Elastic IP address → Allocate.**

Write the address down. This guide uses `13.233.10.20` as the example — **replace it with yours
everywhere**. It never changes, so DNS and certificates are a one-time job.

### B. Two S3 buckets

**S3 → Create bucket**, twice. Leave **Block all public access** ticked on both.

| Bucket name                     | Holds                                                 |
| ------------------------------- | ----------------------------------------------------- |
| `oolix-creatives-<yourcompany>` | Ad creatives, served through the API — never publicly |
| `oolix-backups-<yourcompany>`   | Nightly database dumps and the signing keys           |

Bucket names are unique across all of AWS; if a name is taken, add a few random characters.

### C. A role that lets the instance use the buckets

The instance reaches S3 with a role instead of access keys pasted into a file.

1. **IAM → Policies → Create policy → JSON.** Paste this with your two bucket names, **Next**,
   name it `oolix-s3`, **Create policy**:

   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       {
         "Effect": "Allow",
         "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
         "Resource": [
           "arn:aws:s3:::oolix-creatives-YOURCOMPANY/*",
           "arn:aws:s3:::oolix-backups-YOURCOMPANY/*"
         ]
       },
       {
         "Effect": "Allow",
         "Action": ["s3:ListBucket"],
         "Resource": [
           "arn:aws:s3:::oolix-creatives-YOURCOMPANY",
           "arn:aws:s3:::oolix-backups-YOURCOMPANY"
         ]
       }
     ]
   }
   ```

2. **IAM → Roles → Create role.** Trusted entity **AWS service**, use case **EC2**, **Next**.
   Tick `oolix-s3` **and** `AmazonSSMManagedInstanceCore` — the second lets you open a terminal
   through Session Manager (§I) with no SSH port at all. **Next**, name it `oolix-app-role`,
   **Create role**.

### D. Launch the instance

**EC2 → Instances → Launch instances**

| Section | Setting |
| --- | --- |
| Name | `oolix` |
| Application and OS Images | **Ubuntu Server 24.04 LTS**, 64-bit (x86) |
| Instance type | **`t3.large`** — 2 vCPU, 8 GB |
| Key pair | **Create new key pair** → name `oolix-key`, RSA, `.pem`. It downloads; keep it safe |
| Network settings → **Edit** | **Select existing security group → `oolix-app`** if you made one. Otherwise tick **Allow SSH traffic from → My IP**, **Allow HTTPS traffic from the internet** and **Allow HTTP traffic from the internet** |
| Configure storage | **40 GiB**, gp3 |
| Advanced details → IAM instance profile | **`oolix-app-role`** |
| Advanced details → Metadata version | **V2 only (token required)** |
| Advanced details → Metadata response hop limit | **2** |

**Launch instance.** Wait until it shows **Running** and **2/2 checks passed**.

- **Why `t3.large`:** the portal and API images are built on the instance, and that needs the
  memory. Anything smaller dies part-way through the build with no useful error.
- **SSH from My IP, never Anywhere** — `0.0.0.0/0` invites a constant stream of break-in
  attempts. If your internet provider changes your IP and SSH stops connecting, edit that rule
  back to My IP.
- **Forgot the hop limit?** Creative uploads will fail later. Fix it without relaunching:
  **Instances → select → Actions → Instance settings → Modify instance metadata options** → hop
  limit **2**.

### E. Attach the Elastic IP

**EC2 → Elastic IPs → select yours → Actions → Associate Elastic IP address.** Resource type
**Instance**, pick `oolix`, **Associate**.

### F. DNS — three names

Oolix needs three names — `api.`, `app.` and `auth.` — all pointing at the Elastic IP.

**No domain? Use sslip.io.** It turns any name containing an IP address into that address, with
nothing to register. Write your Elastic IP with dashes:

```text
api.13-233-10-20.sslip.io
app.13-233-10-20.sslip.io
auth.13-233-10-20.sslip.io
```

**Own a domain?** Create three **A** records — `api`, `app` and `auth` — pointing at the Elastic
IP, and use those names wherever this guide shows `sslip.io` ones.

Check from your laptop before going on — certificates cannot be issued until these resolve:

```sh
nslookup api.13-233-10-20.sslip.io        # must answer with your Elastic IP
```

### G. The database — Neon

**console.neon.tech → sign up → New project**

| Field | Value |
| --- | --- |
| Project name | `oolix` |
| Postgres version | **16**. Change it if the default is newer — the nightly backup uses `pg_dump` 16, which refuses to back up a newer server |
| Cloud provider and region | **AWS**, **Asia Pacific (Singapore)** — the closest Neon offers to Mumbai |

Then open **Connect** on the project dashboard, switch **Connection pooling off**, and copy the
connection string. It has three parts you will use later:

```text
postgresql://neondb_owner:npg_AbC123xYz@ep-cool-name-a1b2c3d4.ap-southeast-1.aws.neon.tech/neondb?sslmode=require
             └── ROLE ──┘ └── PASS ───┘ └────────────────────── HOST ──────────────────────┘
```

Write down **ROLE**, **PASS** and **HOST**. If HOST contains `-pooler`, pooling is still on —
switch it off and copy again: the pooled address cannot run the database migrations.

Oolix does not use Postgres row-level security — each organisation's data is kept apart by the
API — so the role Neon created for you is the right one to use.

<details>
<summary><strong>When a client pays — RDS in Mumbai instead of Neon</strong></summary>

Puts the data in India and removes Neon's monthly limit, for roughly **$25/month** more.

> **Solve one thing before relying on this.** The API checks the database's certificate, and RDS
> certificates are signed by Amazon's own authority, which Node does not trust by default. Until
> the RDS certificate bundle is made available to the `api` and `worker` containers
> (`NODE_EXTRA_CA_CERTS`), they cannot connect. Neon's certificate is publicly trusted, which is
> why the main path needs nothing.

1. **EC2 → Security Groups → Create security group** `oolix-data`: inbound **PostgreSQL (5432)**
   from **Custom → the instance's security group** — the group, not an IP address.
2. **RDS → Create database → Standard create → PostgreSQL 16**: template **Dev/Test**,
   `db.t4g.small`, 20 GiB gp3, **Public access: No**, security group `oolix-data`, initial
   database name `oolix`, backups 7 days. About 10 minutes; copy the **Endpoint**.
3. In §4, create only `keycloak`, connecting to `oolix`:
   `psql "postgresql://USER:PASS@ENDPOINT:5432/oolix?sslmode=require" -c 'CREATE DATABASE keycloak;'`
4. In §6, use `ENDPOINT:5432` wherever this guide says `HOST`.

To move an existing Neon deployment across, dump and restore both databases, then update
`.env.prod`:

```sh
pg_dump "NEON_URL" -Fc -f oolix.dump && pg_restore --no-owner -d "RDS_URL" oolix.dump
```

**Redis stays in the stack either way** — it holds only rate-limit counters. ElastiCache is
optional: add `-f oolix/infra/docker/compose.managed-redis.yml` after the Postgres file in §8 and
set `REDIS_URL=rediss://…`, with encryption in transit enabled when the cluster is created.

</details>

### H. Somewhere for alerts to go — 2 minutes

The safety check in §7 refuses to continue until alerts have a real destination — otherwise every
alert would fire into nothing while the dashboard stayed green. For a demo, **ntfy** is free and
needs no account:

1. Install the **ntfy** app on your phone.
2. Make up a long random topic name, such as `oolix-alerts-7f3k9q2m`. Anyone who knows the name can
   read it, so make it unguessable.
3. In the app: **+ → Subscribe to topic** → that name.

Your alert address is `https://ntfy.sh/oolix-alerts-7f3k9q2m`. Slack's plain incoming webhook does
**not** work: Alertmanager sends its own format, which Slack rejects.

### I. Open a terminal on the instance

**Session Manager — recommended.** A terminal in the browser that needs no inbound port at all,
so SSH can eventually be closed entirely.

1. The role needs `AmazonSSMManagedInstanceCore` (§C). If you add it to a running instance, the
   agent notices within a few minutes — or at once after `sudo snap restart amazon-ssm-agent` in
   any other terminal. The agent comes preinstalled on Ubuntu.
2. **EC2 → Instances →** select `oolix` → **Connect → Session Manager → Connect.**
3. A session starts as `ssm-user` in a bare shell. Switch to the user this guide expects:

   ```sh
   sudo su - ubuntu
   ```

4. A session closes after **20 idle minutes**, and §8's build can take longer. Raise it once:
   **Systems Manager → Session Manager → Preferences → Edit → Idle session timeout: 60**.

**Or EC2 Instance Connect in the browser.** It needs one more inbound rule first: the browser
terminal reaches the instance from AWS's addresses, not yours, so a My IP rule alone blocks it.

1. **EC2 → Instances →** select `oolix` → **Security** tab → click the security group's name.
2. **Edit inbound rules → Add rule.** Type **SSH**, Source **Custom**, then type
   `ec2-instance-connect` in the box and pick **`com.amazonaws.ap-south-1.ec2-instance-connect`**.
   If it does not appear, enter `13.233.177.0/29` — the same addresses written out. **Save
   rules.** Keep the My IP rule too.
3. **Instances →** select `oolix` → **Connect → EC2 Instance Connect**, username **`ubuntu`** →
   **Connect**.

The rule admits only AWS's connection service, and using it still takes your AWS sign-in.

**Or from Windows PowerShell,** in the folder where `oolix-key.pem` downloaded:

```powershell
icacls oolix-key.pem /inheritance:r
icacls oolix-key.pem /grant:r "$($env:USERNAME):(R)"
ssh -i .\oolix-key.pem ubuntu@13.233.10.20
```

The two `icacls` lines are needed once: Windows makes the downloaded key readable by everyone,
and `ssh` refuses such a key. Answer `yes` to the fingerprint question.

Whichever you use, you are now `ubuntu@ip-…`. **Everything from §1 onwards runs in this
terminal.**

---

## 1. Base packages

```sh
sudo apt update && sudo apt upgrade -y
curl -fsSL https://get.docker.com | sh
sudo apt install -y s3fs postgresql-client
sudo usermod -aG docker ubuntu && newgrp docker
docker compose version            # v2.24.4 or newer; v5.x is fine
```

If a purple **"Daemons using outdated libraries"** screen appears during the upgrade, press
**Enter**. There is no firewall step: the security group is the firewall.

## 2. Swap

Building the images briefly needs more memory than the instance has. Swap is the difference
between slow and killed:

```sh
sudo fallocate -l 4G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
free -h                           # Swap: 4.0Gi
```

## 3. Mount the backup bucket

Backups must leave the instance — one kept next to what it protects survives only the failures
that do not matter. This makes the backups bucket appear as a folder:

```sh
BUCKET=oolix-backups-YOURCOMPANY
sudo mkdir -p /mnt/oolix-backups
sudo s3fs $BUCKET /mnt/oolix-backups -o iam_role=auto \
  -o url=https://s3.ap-south-1.amazonaws.com -o endpoint=ap-south-1 \
  -o allow_other -o uid=$(id -u) -o gid=$(id -g)
echo "$BUCKET /mnt/oolix-backups fuse.s3fs _netdev,allow_other,iam_role=auto,url=https://s3.ap-south-1.amazonaws.com,endpoint=ap-south-1 0 0" \
  | sudo tee -a /etc/fstab
```

**Prove it is really the bucket:**

```sh
df -h /mnt/oolix-backups          # the Filesystem column must say s3fs
```

If it says `/dev/root`, the mount failed and backups would quietly land on the instance's own
disk. The usual cause is the role from §C not being attached to the instance.

## 4. Create the databases

Neon starts you with a database called `neondb`, which Oolix does not use. Create the two it does
— one for Oolix, one for sign-in — with **ROLE**, **PASS** and **HOST** from §G:

```sh
psql "postgresql://ROLE:PASS@HOST/neondb?sslmode=require" \
  -c 'CREATE DATABASE oolix;' -c 'CREATE DATABASE keycloak;'
psql "postgresql://ROLE:PASS@HOST/oolix?sslmode=require" -c 'SHOW server_version;'
```

Expect `CREATE DATABASE` twice, then a version starting with **16**. If it is 17 or 18, create a
new Neon project on 16 now — §G says why.

## 5. Get the code

```sh
sudo mkdir -p /srv && sudo chown ubuntu /srv && cd /srv
git clone https://github.com/VijayDahiya01/data.git oolix
cd oolix
```

The repository is public, so no credentials are needed.

## 6. Configuration

```sh
cp .env.prod.example .env.prod
chmod 600 .env.prod
sed -i "s/^IMAGE_TAG=.*/IMAGE_TAG=$(git rev-parse --short HEAD)/" .env.prod
for i in 1 2 3; do openssl rand -base64 32; done
nano .env.prod
```

The `sed` line stamps the version you cloned. The `for` line prints three random strings — your
three secrets. In `nano`, move with the arrow keys; **Ctrl+O** then **Enter** saves; **Ctrl+X**
exits.

Find each of these lines in the file and fill it in. Leave every other line as it is:

```ini
# The database -- ROLE, PASS and HOST from §G
DATABASE_URL=postgresql://ROLE:PASS@HOST/oolix?sslmode=require
KEYCLOAK_JDBC_URL=jdbc:postgresql://HOST/keycloak?sslmode=require
KEYCLOAK_DB_USER=ROLE
KEYCLOAK_DB_PASSWORD=PASS
POSTGRES_USER=ROLE
POSTGRES_PASSWORD=PASS
POSTGRES_HOST=HOST
POSTGRES_DB=oolix

# The three random strings
KEYCLOAK_ADMIN_PASSWORD=<first>
OIDC_CLIENT_SECRET=<second>
PORTAL_SESSION_SECRET=<third>

# Addresses -- §F, with your Elastic IP
TLS_MODE=you@yourcompany.com
API_HOST=api.13-233-10-20.sslip.io
APP_HOST=app.13-233-10-20.sslip.io
AUTH_HOST=auth.13-233-10-20.sslip.io
API_PUBLIC_URL=https://api.13-233-10-20.sslip.io
WEB_PUBLIC_URL=https://app.13-233-10-20.sslip.io
KEYCLOAK_PUBLIC_URL=https://auth.13-233-10-20.sslip.io

# Storage -- §B and §3
AWS_REGION=ap-south-1
S3_CREATIVE_BUCKET=oolix-creatives-YOURCOMPANY
CDN_PUBLIC_BASE_URL=https://api.13-233-10-20.sslip.io/creatives
BACKUP_DEST=/mnt/oolix-backups

# Alerts -- §H
ALERT_WEBHOOK_DEFAULT=https://ntfy.sh/oolix-alerts-7f3k9q2m
ALERT_WEBHOOK_ONCALL=https://ntfy.sh/oolix-alerts-7f3k9q2m
```

- **Leave empty:** `REDIS_URL` (Redis runs in the stack), and `AWS_ENDPOINT_URL`,
  `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` (the role from §C provides access).
- **The same ROLE and PASS three times is correct.** Keycloak and the backup job log in as the same
  database user.
- **`TLS_MODE` is an email address,** for Let's Encrypt's certificate notices.
- **The three URLs must match §F exactly.** Sign-in compares them as text, and a mismatch makes
  every request fail as an invalid token while everything looks fine.
- **Never put a comment after a value on the same line** — it becomes part of the value.

## 7. The safety check

```sh
docker run --rm -v "$PWD:/w" -w /w node:24-alpine node scripts/preflight.mjs --env-file .env.prod
```

It refuses placeholder or reused secrets, the development accounts, anything but
`APP_ENV=production`, non-HTTPS addresses, a moving version tag, placeholder alert addresses and
backups that stay on this disk. **Fix every `FAIL` line and run it again** — each names the
setting, and each exists because that mistake is silent in production. `WARN` lines are advice;
the one about rehearsing a restore stays until you have done one.

## 8. Build and start

```sh
COMPOSE="-f oolix/infra/docker/compose.prod.yml -f oolix/infra/docker/compose.managed-postgres.yml --env-file .env.prod"

docker compose $COMPOSE build                              # 10-15 minutes the first time
docker compose $COMPOSE --profile init run --rm keys       # ONCE, first deployment only
docker compose $COMPOSE --profile monitoring up -d
docker compose $COMPOSE --profile monitoring ps
```

The `keys` step creates the signing keys and prints `manifest key ready: …` and
`agent-token key ready: …`. Run again later, it reports the existing keys and changes nothing.

`ps` should list `caddy`, `api`, `portal`, `worker`, `keycloak`, `redis`, `backup`, `prometheus`
and `alertmanager`, all **Up**; `api` and `portal` add **(healthy)** after a minute. The database
migrations run by themselves before the API starts.

> `COMPOSE=…` lasts only as long as this terminal. After reconnecting, paste that line again
> before any `docker compose $COMPOSE` command.

## 9. Check it works

Certificates take 30–60 seconds after the first start. Then:

```sh
H=13-233-10-20.sslip.io            # or your own domain
curl -s https://api.$H/healthz; echo
curl -s https://api.$H/readyz; echo
curl -sI https://app.$H/login | head -1
curl -s https://auth.$H/realms/oolix/.well-known/openid-configuration | head -c 80; echo
```

```text
{"status":"ok","contract_version":"…"}
{"status":"ready","checks":{"database":true},"contract_version":"…","environment":"production"}
HTTP/2 200
{"issuer":"https://auth.13-233-10-20.sslip.io/realms/oolix",…
```

`"environment":"production"` confirms the production protections are on. The API's log also shows
`SECURITY WARNING: The SSL modes 'prefer', 'require', and 'verify-ca' are treated as aliases for
'verify-full'` once at start — harmless: it means the database certificate **is** verified.

## 10. Back up the signing keys — now

The API signs every instruction it sends a Partner Agent with a key that lives on this instance's
disk. Lose it and every Agent rejects everything until each Partner registers again; leak it and
someone can forge instructions an Agent trusts. A database backup does not contain it.

```sh
docker run --rm -v oolix-prod_api-keys:/k -v /mnt/oolix-backups:/b alpine \
  tar czf /b/signing-keys-$(date +%F).tar.gz -C /k .
ls -l /mnt/oolix-backups
```

The `backup` container repeats this every 24 hours, together with both databases.

## 11. Demo accounts

### Load the demo organisations

This fills the empty database with the synthetic demo world — the same organisations the test
suite uses, already business-verified. The seeding tools run in a throwaway Node container, about
5 minutes:

```sh
docker run --rm -v "$PWD:/w" -w /w \
  -e DATABASE_URL="$(grep '^DATABASE_URL=' .env.prod | cut -d= -f2-)" \
  node:24.19.0-alpine sh -c 'corepack enable && pnpm install --frozen-lockfile && pnpm db:seed --env=staging'
```

| Organisation              | Type            | Accounts, all `@example.test`                                                    |
| ------------------------- | --------------- | -------------------------------------------------------------------------------- |
| ABC Insurance             | Buyer           | `buyer.admin`, `buyer.operator`, `finance`, `analyst`                            |
| Travel A                  | Data Partner    | `partner.admin`, `partner.approver`, `partner.security`, `partner.finance`       |
| Rewards B                 | Data Partner    | `partnerb.admin`, `partnerb.approver`                                            |
| Meridian Ventures         | Network sponsor | `network.admin`                                                                  |
| Oolix Platform Operations | Oolix           | `oolix.admin`                                                                    |

Plus **`demo@example.test`**: one login holding every persona across four organisations, switched
from the sidebar.

The install leaves a `node_modules` folder in `/srv/oolix`; nothing else uses it, and
`sudo find /srv/oolix -name node_modules -type d -prune -exec rm -rf {} +` removes it.

> **Demo only.** These organisations are fake and now live in your real database. Before a real
> pilot, start again from a new Neon project.

### Create sign-ins for the accounts you will use

The seed created the Oolix side of each account; Keycloak holds the passwords. For each person you
will sign in as — at least `demo@example.test`:

1. Open `https://auth.13-233-10-20.sslip.io/admin` and sign in as `admin` with your
   `KEYCLOAK_ADMIN_PASSWORD`.
2. Top-left realm menu → choose **oolix** (not _master_).
3. **Users → Create new user.** Username and Email both `demo@example.test`, **Email verified:
   On**, a first name → **Create**.
4. **Credentials → Set password.** At least 12 characters with an upper-case letter, a lower-case
   letter and a digit; **Temporary: On** → **Save**.

**Email verified must be On.** Oolix connects a new sign-in to its account by verified email; with
it Off, sign-in succeeds and then everything answers `AUTH_001` — which looks like a bug and is
not.

**To show an approval, create a second person.** Nobody may approve a request they created, even
holding both roles — so use, for example, `buyer.admin@example.test` to request and
`partner.approver@example.test` to approve.

### First sign-in

Open `https://app.13-233-10-20.sslip.io`, **Continue to sign in**, and use the email and temporary
password. Keycloak asks for a new password, then shows a QR code: scan it with an authenticator
app (Google Authenticator or Microsoft Authenticator) and type the 6-digit code.

Every account does this once; after that each sign-in asks for a code from the app, so **bring the
phone to the demo**. When the portal shows the organisation's data, sign-in, the second factor and
the database are all working end to end.

## 12. On the day of the demo

- `curl -s https://api.$H/readyz` answers `"status":"ready"`.
- Sign in once as each demo account.
- No warm-up is needed. Unlike most apps on Neon, Oolix never lets the database sleep — which is
  also why the free allowance runs out.
- Showing an ad being served needs a Partner Agent running — `docs/DEPLOY-PARTNER-AGENT.md`.

## 13. Updating to a newer version

```sh
cd /srv/oolix && git pull
sed -i "s/^IMAGE_TAG=.*/IMAGE_TAG=$(git rev-parse --short HEAD)/" .env.prod
COMPOSE="-f oolix/infra/docker/compose.prod.yml -f oolix/infra/docker/compose.managed-postgres.yml --env-file .env.prod"
docker compose $COMPOSE build && docker compose $COMPOSE --profile monitoring up -d
```

Migrations run by themselves and must succeed before the apps restart. **Going back** is
`git checkout <previous-commit>` and the same last three lines — but only if the newer version did
not change the database. If it did, the way back is a restore: `docs/BACKUP-AND-ROLLBACK.md`.
Run `git checkout main` before the next `git pull`.

## 14. Costs

| Item                                      | Approx / month |
| ----------------------------------------- | -------------: |
| `t3.large` in Mumbai, running all the time |           ~$65 |
| 40 GiB gp3 disk                           |         ~$3.70 |
| Elastic IP                                |         ~$3.60 |
| S3, a few GB                              |            ~$1 |
| Neon free plan                            |             $0 |
| **Total**                                 |       **~$73** |

Verify against current AWS pricing — these move.

**Between demos, Stop the instance — do not Terminate it.** Stopping ends the compute charge; the
disk and the Elastic IP continue at about $7/month, and everything survives a restart.

**Terminating loses more than it seems.** The databases are safe on Neon, but the **signing keys
and certificates live on the instance's disk**. Without the §10 backup, every Partner Agent would
have to be registered again.

## If something is wrong

| Symptom | Cause |
| --- | --- |
| `ssh` hangs | The security group's SSH rule no longer matches your IP — set it to My IP again |
| `ssh` says `UNPROTECTED PRIVATE KEY FILE` | Run the two `icacls` lines in §I |
| Browser Instance Connect fails | It needs its own SSH rule — §I |
| SSM Agent: `unable to acquire credentials … Default Host Management …` | The instance has no role attached, or its role lacks `AmazonSSMManagedInstanceCore` (§C). The "Default Host Management" half is a fallback you are not using. Fix the role, then `sudo snap restart amazon-ssm-agent` |
| `df` shows `/dev/root` for the backups folder | The bucket did not mount — the role from §C is not attached (§D) |
| `psql` in §4 fails | ROLE, PASS or HOST copied wrongly — copy the string again from Neon's **Connect** |
| A `FAIL` line in §7 | Fix what it names; each line says which setting |
| Build stops with `Killed`, or no error at all | Out of memory — the swap in §2, and `t3.large` |
| `migrate` exits with an error though the database is reachable | HOST contains `-pooler` — §G |
| Keycloak restarts again and again | `KEYCLOAK_JDBC_URL` must start with `jdbc:postgresql://`, or the `keycloak` database from §4 is missing |
| Keycloak log: `Endpoint ID is not specified` | Append `&options=endpoint%3D<endpoint-id>` — the `ep-…` part of HOST — to `KEYCLOAK_JDBC_URL` |
| The browser warns about the certificate, or it never issues | DNS does not point at the Elastic IP yet (§F), or port 80 is closed |
| `/readyz` says `not_ready` | The API cannot reach the database — check `DATABASE_URL`, then `docker compose $COMPOSE logs api` |
| Signed in, then `AUTH_001` everywhere | **Email verified** was Off, or the email is not a seeded account — §11 |
| Every request fails as an invalid token, nothing obvious | The three URLs in `.env.prod` do not match the DNS names exactly |
| Creative upload fails with a credentials error | The metadata hop limit is 1 — §D |
| Backup log says `server version mismatch` | The Neon project is not on Postgres 16 — §G |
| Everything worked for about two weeks, then stopped | Neon's free compute for the month is used up — see the top |

Logs for any container: `docker compose $COMPOSE logs -f api` (or `portal`, `keycloak`, `worker`,
`caddy`).
