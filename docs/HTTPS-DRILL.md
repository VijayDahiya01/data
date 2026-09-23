# Running the stack over HTTPS

Everything in a pilot is served over TLS: the portal, the API, and Keycloak.
This is not presentation. The Agent verifies manifest signatures against an
issuer and audience, the API validates tokens against an issuer, and the
portal marks its session cookie `Secure` only when its public URL is `https`.
Those values have to change together or nothing authenticates — and the errors
do not name the cause.

`oolix/infra/caddy/Caddyfile` terminates TLS in front of everything. The API, portal
and Keycloak publish no host ports at all: the terminator is the only service
that faces anything.

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

Point the three names at your own machine — Windows
`C:\Windows\System32\drivers\etc\hosts`, elsewhere `/etc/hosts`:

```
127.0.0.1  api.oolix.localhost app.oolix.localhost auth.oolix.localhost
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
curl --cacert /tmp/caddy-root.crt \
  https://auth.oolix.localhost/realms/oolix/.well-known/openid-configuration
```

Four things are worth confirming by eye, because each has failed silently:

1. **The issuer is `https://`, not `http://`.** If Keycloak reports http, the
   proxy headers are not reaching it and every token will be rejected later.
2. **Plain HTTP redirects rather than serves** — `http://api…` should answer
   `308`.
3. **`Strict-Transport-Security` is present** on a response.
4. **An authorization request with the real `redirect_uri` returns `302`**, not
   an "Invalid parameter: redirect_uri" page:

```sh
curl --cacert /tmp/caddy-root.crt -o /dev/null -w '%{http_code}\n' \
 "https://auth.oolix.localhost/realms/oolix/protocol/openid-connect/auth?client_id=oolix-web&response_type=code&scope=openid&redirect_uri=https%3A%2F%2Fapp.oolix.localhost%2Fapi%2Fauth%2Fcallback"
```

A browser will warn once, until the local CA is trusted. The certificate is
real; its issuer is simply not yet known to the machine.

## Going to a real domain

Change four things and nothing else:

| Variable              | From                       | To                        |
| --------------------- | -------------------------- | ------------------------- |
| `TLS_MODE`            | `internal`                 | an email address for ACME |
| `API_HOST`            | `api.oolix.localhost`      | the real name             |
| `APP_HOST`            | `app.oolix.localhost`      | the real name             |
| `AUTH_HOST`           | `auth.oolix.localhost`     | the real name             |

Then set `API_PUBLIC_URL`, `WEB_PUBLIC_URL` and `KEYCLOAK_PUBLIC_URL` to the
matching `https://` addresses. The names must resolve publicly and reach ports
80 and 443, because that is how the certificate is issued.

**A Partner Agent's `api_base_url` must be exactly `API_PUBLIC_URL`.** It is
signed as the assertion audience and compared as a string, so an equivalent
address that reaches the same server fails with
`Client assertion verification failed` and no further explanation.

## What the drill found

None of this worked the first time, and every failure was silent or misleading:

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
