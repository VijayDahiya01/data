# Running the stack over HTTPS

Everything in a pilot is served over TLS: the portal and the API. This is not
presentation. The Agent verifies manifest signatures against an issuer and
audience, the API names its own public URL as the issuer of every sign-in
token, emailed links are built from the portal's public URL, and the portal
marks its session cookie `Secure` only when that URL is `https`. Those values
have to change together or nothing authenticates — and the errors do not name
the cause.

`oolix/infra/caddy/Caddyfile` terminates TLS in front of everything. The API and
portal publish no host ports at all: the terminator is the only service that
faces anything.

## The one setting

```
TLS_MODE=internal            a local certificate authority, for a drill
TLS_MODE=ops@yourdomain.com  real Let's Encrypt certificates
```

Both are valid `tls` arguments in Caddy, which is why one variable covers the
laptop drill and the real deployment with no second file to keep in step.

## The drill

Prove the whole chain locally before renting anything.

```sh
cp .env.prod.example .env.prod          # fill in every REQUIRED value
```

Email stays real in a drill: the API refuses to start outside local development
without a Brevo API key and a sender Brevo has verified (`.env.prod.example`,
"email").

Point the two names at your own machine — Windows
`C:\Windows\System32\drivers\etc\hosts`, elsewhere `/etc/hosts`:

```
127.0.0.1  api.oolix.localhost app.oolix.localhost
```

Then, once, create the signing keys. This is deliberately a separate step:

```sh
docker compose -f oolix/infra/docker/compose.prod.yml --env-file .env.prod \
  --profile init run --rm keys
```

And start:

```sh
docker compose -f oolix/infra/docker/compose.prod.yml --env-file .env.prod up -d
```

## Checking it, without skipping the check

`curl -k` proves nothing — it is the flag that switches off the thing being
tested. Use Caddy's own root instead, so the chain is actually validated:

```sh
docker exec oolix-prod-caddy-1 \
  cat /data/caddy/pki/authorities/local/root.crt > /tmp/caddy-root.crt

curl --cacert /tmp/caddy-root.crt https://api.oolix.localhost/healthz
curl --cacert /tmp/caddy-root.crt https://app.oolix.localhost/login
```

Three things are worth confirming by eye, because each has failed silently:

1. **Plain HTTP redirects rather than serves** — `http://api…` should answer
   `308`.
2. **`Strict-Transport-Security` is present** on a response.
3. **Sign-in answers.** A wrong password must come back as `401` with
   `AUTH_001` — which proves the sign-in key loaded and the database is
   reachable, without needing an account:

```sh
curl --cacert /tmp/caddy-root.crt -s https://api.oolix.localhost/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"nobody@example.com","password":"not-the-password"}'
```

A browser will warn once, until the local CA is trusted. The certificate is
real; its issuer is simply not yet known to the machine.

## Going to a real domain

Change three things and nothing else:

| Variable              | From                       | To                        |
| --------------------- | -------------------------- | ------------------------- |
| `TLS_MODE`            | `internal`                 | an email address for ACME |
| `API_HOST`            | `api.oolix.localhost`      | the real name             |
| `APP_HOST`            | `app.oolix.localhost`      | the real name             |

Then set `API_PUBLIC_URL` and `WEB_PUBLIC_URL` to the matching `https://`
addresses. The names must resolve publicly and reach ports
80 and 443, because that is how the certificate is issued.

**A Partner Agent's `api_base_url` must be exactly `API_PUBLIC_URL`.** It is
signed as the assertion audience and compared as a string, so an equivalent
address that reaches the same server fails with
`Client assertion verification failed` and no further explanation.

## What the drill found

None of this worked the first time, and every failure was silent or misleading.
(The three Keycloak findings are history: sign-in moved into Oolix on
2026-09-24, and Keycloak with it.)

- The migration step had never run: `pnpm deploy --prod` writes no `.bin` entry
  for the Prisma CLI, so `npx prisma` exited 127. The image now installs a
  launcher and the build fails if the CLI is missing.
- Prisma 7 reads the datasource URL from a config file rather than the schema,
  and no such file existed in the image. `prisma validate` now runs at build
  time so this cannot regress.
- Keycloak's database was never created — it crash-looped on
  `FATAL: database "keycloak" does not exist` after everything else came up
  healthy.
- The realm import named `http://localhost:3000` for its redirect URIs and
  `http://localhost:8081` as its `frontendUrl`. The second is the dangerous
  one: it overrides the hostname setting, so the realm issued tokens whose
  issuer no API would accept. Both are now rendered per deployment.
- Keycloak's default distributed cache made it retry a stale cluster peer
  forever, producing a restart loop with the real cause buried under thousands
  of connection-refused lines.
- The API refused to start because no signing key was mounted — which is the
  designed behaviour, and the reason key provisioning is now its own step.
