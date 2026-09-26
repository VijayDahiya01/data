# Partner Agent authentication contract

Appendix A · spec v5 §69.3, §82, §92

This is the contract between a Partner Agent and Oolix Cloud: how an Agent
obtains an identity, how it proves that identity on every call, and exactly what
Oolix checks before trusting one.

**Why it is built this way.** The Agent runs inside the Data Partner's
infrastructure, next to a customer database Oolix must never see (§1, §12.1). So
the credential that matters — the Agent's private key — is generated _there_ and
never transmitted. Oolix only ever holds a public key. That single asymmetry is
what makes a signed report batch meaningful evidence rather than a claim, and it
is why a compromise of the Oolix database cannot let anyone impersonate a
Partner's Agent.

---

## 1. Bootstrap token (§92.1)

A `PARTNER_SECURITY_ADMIN` — not the commercial `PARTNER_ADMIN` (§66) — mints a
single-use token.

```http
POST /v1/partner/agents/bootstrap-tokens
Authorization: Bearer <user access token>
```

```json
{
  "bootstrap_token": "6Qk1w9x...base64url...",
  "expires_at": "2026-08-22T10:15:00Z",
  "warning": "Shown once. Oolix stores only its SHA-256."
}
```

| Property | Value                                                         |
| -------- | ------------------------------------------------------------- |
| Entropy  | 32 cryptographically secure random bytes, base64url           |
| Lifetime | 15 minutes                                                    |
| Uses     | Exactly one — `used_at` is set in the registering transaction |
| At rest  | `SHA-256(token)` only, in `agent_bootstrap_tokens.token_hash` |

Storing only the hash means an attacker who reads the Oolix database still
cannot register an Agent. Fifteen minutes and single use bound the window in
which a token intercepted in transit is worth anything.

Unused tokens can be revoked in bulk:

```http
POST /v1/partner/agents/bootstrap-tokens/revoke
```

---

## 2. Registration (§92.2)

The Agent generates a **P-256 keypair locally** and sends only the public half.

```http
POST /agent/v1/register
Content-Type: application/json
```

```json
{
  "bootstrap_token": "6Qk1w9x...",
  "agent_public_key_jwk": { "kty": "EC", "crv": "P-256", "x": "...", "y": "..." },
  "agent_version": "0.4.3",
  "capabilities": ["PARTNER_WEB"]
}
```

```json
201
{
  "agent_id": "agent_123",
  "client_id": "oolix_agent_123",
  "token_endpoint": "https://api.oolix.example/agent/v1/token",
  "issuer": "https://api.oolix.example",
  "audience": "oolix-agent-api"
}
```

This endpoint is unauthenticated by necessity — the Agent has no access token
yet — so the bootstrap token in the body _is_ the credential. Oolix validates,
in one transaction:

1. `SHA-256(bootstrap_token)` matches a stored hash;
2. it has not expired, been used, or been revoked;
3. the Partner organization is active;
4. `agent_version` satisfies the minimum-version policy (§80);
5. the submitted JWK is a well-formed P-256 **public** key.

A JWK carrying a `d` parameter is rejected outright. Its presence means the
Agent is leaking its own private key, and accepting it would silently destroy
the property this whole design exists to provide.

`used_at` is set in the same transaction that creates the Agent row. Two
concurrent registrations with one token therefore cannot both succeed.

> The private key never leaves Partner infrastructure. Oolix cannot produce a
> signature that appears to come from a Partner's Agent, and cannot recover the
> key if the Partner loses it — re-bootstrapping is the recovery path.

---

## 3. Access token (§92.3)

Tokens are short-lived and obtained by proving possession of the private key.

```http
POST /agent/v1/token
Content-Type: application/json
```

```json
{
  "client_id": "oolix_agent_123",
  "client_assertion_type": "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
  "client_assertion": "<ES256 JWT signed by the Agent private key>"
}
```

The assertion is a JWT with `alg: ES256`:

| Claim | Value                                    |
| ----- | ---------------------------------------- |
| `iss` | `client_id`                              |
| `sub` | `client_id`                              |
| `aud` | the token endpoint URL                   |
| `jti` | unique per assertion (replay protection) |
| `exp` | at most 60 seconds ahead                 |

```json
200
{ "access_token": "<Oolix-signed>", "token_type": "Bearer", "expires_in": 900 }
```

Fifteen minutes is deliberate. It is long enough that a 30-second control sync
does not spend its life at the token endpoint, and short enough that a leaked
token is worth little — while §69.3 revocation does not wait for expiry at all
(see §5).

---

## 4. Validating every `/agent/v1/*` call (§92.4)

Oolix performs all of the following, in order, on every request:

1. Read `Authorization: Bearer <access_token>` and `X-Agent-Id`.
2. Verify the access token's signature, `iss`, `aud`, `exp` and `nbf`.
3. Require the token subject / `client_id` to map to the **same** `X-Agent-Id`.
   Without this check, a valid token for one Agent could be replayed while
   claiming to be another.
4. Load the Agent registration; require `status = ACTIVE` and an active
   `partner_org_id`.
5. Verify the scope the endpoint requires — `config:read`, `reporting:write`,
   `channel_status:write`, `heartbeat:write`, or `capabilities:write` (a
   managed Agent publishing what its local copy can answer).
6. Reject revoked keys and Agent versions per security policy.
7. Attach `agent_id` and `partner_org_id` to the request context.

> **Never trust a `partner_org_id` supplied in the body.** The Partner comes
> from the Agent's registration record. Every Agent-facing query is scoped by
> that value, which is why an Agent cannot report delivery for, or read config
> belonging to, a Partner that is not its own.

Authentication failures are audited by `agent_id` and `correlation_id` only.
Tokens and Partner customer data are never logged (§78.1).

### Payload signatures

The bearer token _authenticates_; the optional `payload_signature` on a
heartbeat or report batch provides _tamper evidence_. When present, Oolix
verifies it with the Agent's registered public key **after** the access token
has been validated.

```http
POST /agent/v1/heartbeat
X-Agent-Id: agent_123
Authorization: Bearer <access_token>
X-Correlation-Id: corr_...
```

```json
{
  "agent_version": "0.4.3",
  "config_age_seconds": 120,
  "status": "HEALTHY",
  "sent_at": "2026-08-22T10:00:00Z",
  "payload_signature": "<ES256 over the canonical body hash>"
}
```

---

## 5. Revocation (§69.3)

```http
POST /v1/partner/agents/{id}/revoke
```

A reason is required and recorded (§83).

Revocation is effective **immediately**, not at token expiry: step 4 above
re-reads Agent status on every call, so an already-issued 15-minute token stops
working the moment the Agent is revoked. The Agent observes this as `401` on its
next control sync and reports `identity_valid: false` on `/readyz`, which drops
it out of the Partner's load balancer rather than leaving it serving stale
manifests for the remainder of the grace window.

Recovery is a fresh bootstrap token and a new registration. The old key is not
reinstated.

---

## 6. Failure modes

| Situation                                | Response       | Agent behaviour                                              |
| ---------------------------------------- | -------------- | ------------------------------------------------------------ |
| Bootstrap token expired / used / revoked | `401 AUTH_001` | Registration fails; operator mints a new token               |
| Client assertion fails verification      | `401 AUTH_001` | Retry with backoff; alert if it persists                     |
| Access token expired                     | `401 AUTH_001` | Re-run §3 and retry once                                     |
| Agent revoked                            | `401 AUTH_001` | Stop serving; `/readyz` reports `identity_valid: false`      |
| `X-Agent-Id` disagrees with the token    | `401 AUTH_001` | Audited as a possible replay                                 |
| Missing scope for the endpoint           | `403 PERM_001` | Configuration error; do not retry                            |
| Oolix unreachable                        | —              | Serve cached manifests inside `stale_grace` (§75), then stop |

The last row is the one that matters most operationally: an Oolix outage must
not become a Partner outage. §75 lets the Agent keep serving already-approved
manifests for the configured grace window, bounded by each manifest's own
`config_expires_at`, and it starts nothing new after that.
