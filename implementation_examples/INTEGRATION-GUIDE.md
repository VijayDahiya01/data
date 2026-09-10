# Integrating as a Data Partner

For the engineer doing the work. It goes from "we have agreed to do this" to
"an ad is serving", and says how to check each step actually worked rather than
appeared to.

**What you are building.** Oolix sends you signed instructions describing an
audience. Software you run, inside your infrastructure, decides which of your
customers match and which ad each one sees. Your customer data never leaves,
and Oolix never learns who anybody is.

**What that means practically.** You run one binary, expose a pre-computed view
of your own data to it, and add one endpoint to your backend. Everything else
is configuration.

**Rough effort.** A day for the Agent and the data view, a day for the page
integration, plus whatever your change process costs. The slowest part is
usually getting a database user provisioned, so start that first.

---

## Before you start

**Three named people, and they must differ.** These are enforced, not advised:

| Role                   | Does                                                       |
| ---------------------- | ---------------------------------------------------------- |
| Partner security admin | Registers and revokes Agents. **Not** the commercial admin |
| Partner admin          | Placements, policy, commercial setup                       |
| Campaign approver      | Accepts or refuses individual campaigns                    |

Onboarding stalls here more than anywhere else. Ask for the names on day one.

**Infrastructure**

- Somewhere to run a container, inside your network
- Outbound HTTPS to the Oolix API. No inbound connection from us, ever
- A database user, read-only except for two tables the Agent owns
- If you run more than one replica: a Redis the replicas share

---

## Step 1 — Build the attribute view

Create the tables in `partner-schema.sql`. Three you fill; two the Agent writes
for itself.

The important one is `oolix_audience_attributes`: one row per customer, holding
only the attributes you are willing to be asked about. **It must be a
pre-computed table**, not a view over your live schema and not a join across it.
An ad decision has about 100 ms, and an audience build has to finish inside a
timeout measured in seconds. A view that joins four transactional tables will
miss both.

Populate it on whatever schedule suits your data. Nightly is usually enough.

Store **raw values, not derived ones** — a date of birth rather than an age. An
age column is wrong the morning after it is written, and the Agent derives it
anyway.

**Check it worked**

```sql
SELECT count(*), max(refreshed_at) FROM oolix_audience_attributes;
```

A row count near your addressable base and a recent timestamp. If the count is
far lower than you expect, the population job is filtering more than intended.

---

## Step 2 — Create the connector user

The grants are at the bottom of `partner-schema.sql`. Read on three tables,
write on the two the Agent owns. Nothing else, including no `CREATE`.

**Check it worked** — as that user, from the machine that will run the Agent:

```sh
psql "postgresql://oolix_agent_ro:...@your-db:5432/yourdb" \
  -c "SELECT count(*) FROM oolix_audience_attributes;"
```

If this is slow from where the Agent will run, fix that now. It is on the ad
path and a hundred milliseconds is the whole budget.

---

## Step 3 — Get an Agent identity

Your **security admin** mints a bootstrap token in the Oolix portal, under
Integrations. It is single-use, expires in 15 minutes, and is shown once —
Oolix keeps only its hash.

Register with it:

```sh
OOLIX_BOOTSTRAP_TOKEN=<the token>   oolix-agent --config /etc/oolix/agent.yaml --register
```

It prints the `agent_id` and `client_id` to put in your config, then exits. Do
this once; starting the agent normally afterwards uses the identity it saved.

What happens next is the part worth understanding, because it is why this
integration is safe to run:

1. The Agent starts and **generates a keypair inside your infrastructure**
2. It registers using the bootstrap token and its **public** key
3. The private key is written to disk and never transmitted

Oolix therefore cannot produce a signature that appears to come from your
Agent, and a compromise of the Oolix database does not change that. See
`agent-auth.md` for the full contract.

---

## Step 4 — Configure and run the Agent

**Oolix publishes the Agent image.** You do not need a Go toolchain, and you
should not build it yourself for a pilot — ask Oolix for the registry path and
the version agreed for your deployment, and pin both. A pinned version is what
makes the binary you audited the binary that runs, and what makes a rollback
possible.

The image is small (about 25 MB), runs as an unprivileged user, and contains no
shell — there is nothing in it to get a prompt from if it is ever reached.

Deploy with `Dockerfile.partner-agent` or `k8s-partner-agent.yaml`. It needs a
writable path for its key, outbound HTTPS, and a private port your own backend
can reach. **Do not expose it publicly** — it has no business being reachable
from the internet.

**The state directory must be writable by uid 65532.** The Agent runs
unprivileged, and a volume created by Docker is owned by root, so registration
fails on the very last step — after the token has been spent. The Kubernetes
manifest handles this with `fsGroup: 65532`. With plain Docker, set it yourself:

```sh
docker run --rm -v oolix-agent-state:/state alpine chown -R 65532:65532 /state
```

The configuration file is yours. The part that matters is the mapping:

```yaml
connector:
  type: postgres_view
  dsn: postgres://oolix_agent_ro:•••@db.internal/customers
  query_timeout: 50ms

  audience:
    attribute_table: oolix_audience_attributes
    mapping_version: 1
    mapping:
      # Oolix asks about `payment_method`; you store `pay_mode`. The
      # translation lives here, on your machine. Oolix never learns your
      # column names.
      payment_method: pay_mode
      purchase_category: product_class
      gender: sex_code

      # Derived attributes: declare the column they come FROM.
      #
      # Writing `date_part('year', age(dob))` works and is unindexable — no
      # index on dob can serve it, so every audience with an age rule reads
      # your whole table. Declaring the column lets it compile to a range
      # instead. Measured 12x faster on 20,000 rows; the gap grows with the
      # table.
      age:
        expr: "date_part('year', age(dob))"
        type: NUMBER
        column: dob
        derive: years_since

      purchase_recency_days:
        expr: "date_part('day', now() - last_order_at)"
        type: NUMBER
        column: last_order_at
        derive: days_since
```

**An attribute you leave out is one you cannot be asked about.** A campaign
requiring it will not match you at all — which is the honest outcome, not a
partial one.

Bump `mapping_version` whenever the mapping changes. It is reported with every
estimate, so an answer can always be tied to the mapping that produced it.

**`api_base_url` must be the exact URL Oolix publishes for itself.**

Not an equivalent address that reaches the same server — the same string. The
Agent signs every request with that URL as the audience, and Oolix checks it
against its own public URL. Reach the same API by a different hostname or IP and
authentication fails with `Client assertion verification failed`, which says
nothing about the cause. Both `api_base_url` and `manifest_issuer` take that
value.

**Check it worked**

```sh
curl http://agent.internal:8082/readyz
```

Look for `"status":"ready"` with `identity_valid`, `config_fresh` and
`connector_healthy` all true.

- `identity_valid: false` — registration did not complete, or `api_base_url`
  does not match what Oolix publishes. Check the URL before re-registering.
- `connector_healthy: false` — the database is unreachable or too slow. The
  message names which.

**Point your own monitoring at it.** The Agent serves Prometheus metrics on the
same private port:

```sh
curl http://agent.internal:8082/metrics
```

Decisions by outcome and reason, a latency histogram bucketed around the 100ms
budget, and how long since it last reached Oolix (`-1` means never). These are
yours: Oolix cannot reach inside your network to collect them, which is the
same property that keeps your customer data where it is. The two worth alerting
on are `oolix_agent_last_control_sync_age_seconds` climbing and
`oolix_agent_decision_budget_breaches_total` rising — the first means outbound
HTTPS is broken, the second almost always means the database is too far away.

There is no per-user label anywhere in it, by design.

---

## Optional — Meta and Google activation

Skip this unless you have agreed to run a campaign on Meta or Google. Partner
web and app inventory needs none of it.

This is the one path where customer data leaves your boundary — hashed, but
real. It runs entirely from your Agent using **your** platform credential.
Oolix never holds that credential and never sees an identifier; it records the
resulting audience id and a status, nothing more.

Nothing uploads until Oolix has separately verified that the account
relationship, the granted scopes, the platform-confirmed capabilities, the
segment's consent basis and your own policy all permit it. A failure there
means no upload at all, and the Buyer is offered your owned inventory instead.

**Point the Agent at your matching identifiers.** These live in a different
table from your targeting attributes, deliberately: the attribute table has no
contact details in it, and a table without an email address cannot leak one.

```yaml
channels:
  meta:
    enabled: true
    # Your token, resolved from your own secret store. It never leaves here.
    access_token_secret_ref: 'secret://meta-access-token'
    ad_account_id: '1234567890'

  export:
    identity_table: 'oolix_match_identities'
    fields:
      email: email_address
      phone: phone_e164
```

**A field you leave out is one the Agent cannot read** — not one it chooses not
to send. Mapping nothing means no external upload is possible, which is the
default.

The read is restricted to one activation's current membership, and to those
fields only. Identifiers are normalized and SHA-256 hashed inside your
infrastructure before anything is sent.

**Watch the skip count** in your Agent's logs and in the Oolix status. A high
number means members had no usable identifier, which almost always means a
mapping is wrong — and the only other symptom is that the campaign quietly
under-delivers.

When a campaign ends, is revoked, or you hit the kill switch, the Agent
**removes** the audience from the platform. Stopping the Agent is not enough on
its own: the audience is already over there.

---

## Step 5 — Publish what you can be asked about

In the portal, under **Audience capabilities**, declare which attributes you can
answer questions about. This is metadata only: attribute names and operators,
never values, never counts.

A Partner with nothing published is invisible to Buyers. This step is what makes
you discoverable.

---

## Step 6 — Define your ad slots

Under **Placements**, create one per slot. The fields that decide behaviour:

| Field                        | Decides                                                                           |
| ---------------------------- | --------------------------------------------------------------------------------- |
| Placement key                | The name your page sends, e.g. `booking_success_offer`. Never change it once live |
| Format and size              | The space reserved, so the page does not shift when an ad arrives                 |
| Allowed / blocked categories | Your policy, enforced locally at decision time                                    |
| Frequency cap                | Default per person per day. Two unless you say otherwise                          |
| Fallback                     | Collapse the slot, or show your own house content                                 |

Activate at least one. Draft placements cannot be requested.

---

## Step 7 — Put the slot on the page

Two pieces. Neither sends a customer identifier to Oolix.

**Your backend** gains one route. It resolves who the visitor is — from your own
session, exactly as the rest of your page does — and asks the local Agent:

```js
app.post('/api/ad-decision', async (req, reply) => {
  const customerId = req.session.userId; // YOUR session. Not ours.
  if (!customerId) return reply.send({ decision: 'NO_AD', reason: 'ANONYMOUS' });

  const res = await fetch(`${AGENT_URL}/private/v1/ad-decision`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      partner_user_id: customerId, // never leaves your network
      // Send the placement KEY you chose in Step 6 -- `booking_success_offer`,
      // not the UUID the portal shows. The field is named `placement_id` for
      // historical reasons; a UUID here matches no campaign and returns
      // NO_ELIGIBLE_CAMPAIGN, which looks exactly like having no campaigns.
      placement_id: req.body.placement_key,
      context: req.body.context ?? {},
    }),
    signal: AbortSignal.timeout(150),
  });
  return reply.send(await res.json());
});
```

**Your page** sends a placement id and nothing else, and renders what comes
back — an image creative, a native card, or your fallback.

**An ad must never break your page.** If the Agent is slow, unreachable or
refuses, show the fallback and carry on. A booking, a checkout or a login must
never wait on an advertisement. Treat the fallback as the normal path.

**Anonymous visitors get no ad, by design.** There is nobody to check consent
for, nobody to check audience membership for, and no way to honour a frequency
cap. That is why the target surface is post-login moments — a booking
confirmation, an order-success page — where you already know who is there.

---

## Step 8 — Prove it end to end

Ask Oolix to run a test campaign against you. Then:

1. Sign in to your own site as a customer who matches the audience
2. Load the page with the slot
3. The ad appears

If it does not, the reason tells you where to look.

---

## When no ad appears

The decision response always carries a reason. They describe a decision, never
a person.

| Reason                 | Means                                                                                             |
| ---------------------- | ------------------------------------------------------------------------------------------------- |
| `USER_NOT_IN_SEGMENT`  | This person did not match the approved rules                                                      |
| `CONSENT_NOT_ELIGIBLE` | No consent for this campaign's stated purpose — or no identity at all                             |
| `FREQUENCY_CAPPED`     | Already seen it today. The cap is working                                                         |
| `CAMPAIGN_NOT_ACTIVE`  | Outside the campaign's flight dates                                                               |
| `NO_ELIGIBLE_CAMPAIGN` | Nothing approved for this placement                                                               |
| `CATEGORY_BLOCKED`     | Your own policy refused it                                                                        |
| `SEGMENT_SOURCE_ERROR` | The Agent could not read your database in time — check `query_timeout` and the connection latency |
| `CONTROL_SYNC_STALE`   | The Agent has not reached Oolix recently. Check outbound HTTPS                                    |
| `KILL_SWITCH_ACTIVE`   | Someone at your organization stopped it                                                           |

`SEGMENT_SOURCE_ERROR` is the one that is usually infrastructure rather than
data. It means the lookup exceeded its budget, and the cause is almost always
network distance between the Agent and the database.

---

## What you keep

**Every campaign is yours to refuse.** Nothing runs on your property that you
did not individually approve, and no approval can be granted on your behalf —
not by Oolix, not by a network sponsor.

**You can stop anything, immediately.** Revocation takes effect on the Agent's
next check-in, not when a credential expires.

**Your data stays put.** No customer list is uploaded, no identifier is shared,
and nothing Oolix holds could be joined against another Partner's data. What
leaves your network is a reach band, a hashed token and counts.
