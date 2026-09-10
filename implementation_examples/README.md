# Oolix implementation pack

Appendix A · spec v5

Appendix A lists eleven artifacts a developer needs to stand this system up. Most
of them are not copies kept in this folder — they are the **live** files the
repository actually builds and runs from, and this README points at them. A
duplicate would drift within a week and then quietly mislead somebody.

The four artifacts that had no other home live here for real, and
`node scripts/verify-pack.mjs` fails if any of them falls out of step with the
code it describes.

| Appendix A file             | Where it lives                                                                 | Kind      |
| --------------------------- | ------------------------------------------------------------------------------ | --------- |
| `.env.example`              | [`../.env.example`](../.env.example)                                           | live      |
| `001_init.sql`              | [`001_init.sql`](001_init.sql)                                                 | snapshot  |
| `Dockerfile.partner-agent`  | [`Dockerfile.partner-agent`](Dockerfile.partner-agent)                         | here      |
| `README.md`                 | this file                                                                      | here      |
| `agent-config.example.yaml` | [`../partner-agent/config.example.yaml`](../partner-agent/config.example.yaml) | live      |
| `docker-compose.yml`        | [`../docker-compose.yml`](../docker-compose.yml)                               | live      |
| `k8s-partner-agent.yaml`    | [`k8s-partner-agent.yaml`](k8s-partner-agent.yaml)                             | here      |
| `openapi.yaml`              | [`openapi.yaml`](openapi.yaml)                                                 | canonical |
| `seed-data.yaml`            | [`seed-data.yaml`](seed-data.yaml)                                             | mirror    |
| `agent-auth.md`             | [`agent-auth.md`](agent-auth.md)                                               | here      |
| `mock-partner/`             | [`../apps/mock-partner`](../apps/mock-partner)                                 | live      |

- **canonical** — §86 makes `openapi.yaml` authoritative for HTTP shapes. CI
  lints it, and an integration test fails if the server's route table and this
  file disagree in either direction.
- **snapshot** — `001_init.sql` is a byte-for-byte copy of the Prisma migration.
  §96: "Prisma migrations remain authoritative." Edit the schema and generate a
  migration; never edit the snapshot.
- **mirror** — `seed-data.yaml` describes the fixtures that
  `packages/db/prisma/seed/index.ts` creates. The identifiers are checked
  against the seed script.
- **live** — the real file, used by the real toolchain. Not a copy.

Run the drift check on its own with:

```bash
node scripts/verify-pack.mjs
```

---

## Reading order

**If you are integrating**, start with
**[`INTEGRATION-GUIDE.md`](INTEGRATION-GUIDE.md)**. It goes from "we have agreed
to do this" to "an ad is serving", and the tables it asks you to build are in
**[`partner-schema.sql`](partner-schema.sql)**. The rest of this pack is
reference you will reach for from there.

**If you are trying to understand the system**, these four in this order explain
the shape of it faster than the spec does:

1. **[`agent-auth.md`](agent-auth.md)** — how a Partner Agent gets an identity
   and proves it. The asymmetry described there (the private key never leaves
   the Partner) is the hinge the rest of the architecture turns on.
2. **[`001_init.sql`](001_init.sql)** — read it for what is _absent_. No
   `customers` table, no `partner_user_id` column, no raw attribution token, no
   exact segment reach. The privacy model is enforced by things that do not
   exist (§54, §73).
3. **[`openapi.yaml`](openapi.yaml)** — the whole API surface, with each
   endpoint's spec citation. Three surfaces are kept apart on purpose: `/v1/*`
   for users, `/agent/v1/*` for Agents, and the probes.
4. **[`k8s-partner-agent.yaml`](k8s-partner-agent.yaml)** — where the Agent
   actually runs. Note that the NetworkPolicy is applied by the **Partner**, not
   by Oolix: the Partner can verify for themselves that the binary Oolix shipped
   cannot phone anywhere unexpected.

---

## Standing it up locally

```bash
pnpm install
pnpm infra:up            # Postgres, Redis, LocalStack, Keycloak, Partner-side Postgres
pnpm db:migrate
pnpm db:seed             # §95 fixtures -- see seed-data.yaml
pnpm dev:api             # http://localhost:4000
pnpm agent:provision     # mints a bootstrap token and registers an Agent (§92)
pnpm agent:run           # http://localhost:8082
pnpm dev:mock-partner    # http://localhost:4001?user=U123
```

Then prove it end to end:

```bash
pnpm verify              # §85 phase exit criteria, phases 0-7
```

`pnpm verify` is the real acceptance test. It drives live HTTP against a running
Agent and asserts each phase's exit criterion from §85 — that a Partner can
approve a request, that an ad decision resolves locally, that a qualified lead
maps back to the activation that earned it, and that a settlement reproduces
from immutable inputs.

---

## What this pack does not contain

- **Secrets of any kind.** §82 requires non-local secrets to come from a secret
  manager. The credentials in `k8s-partner-agent.yaml` are `REPLACE_ME`
  placeholders, and the signing keys under `.keys/` are generated on first boot
  and git-ignored.
- **Meta or Google adapters.** §15, §16 and §84 keep both behind feature flags
  that are off until the exact account and eligibility model is proven for a
  specific Partner/Buyer pair. §85 places them in phases 9 and 10.
- **Anything TEE-related.** §28 and §104 put cross-Partner overlap and dedupe
  beyond the MVP; nothing here depends on it.
- **Real customer data.** By construction, at every layer. That is the product.
