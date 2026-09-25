# The four things code cannot do

Everything blocking a live pilot now needs a credit card, an application form,
or a signature. This is what each one actually involves, what it costs, how
long it takes, and — the part that matters most — **what blocks what**.

## Read this first: you probably do not need Meta or Google

The pilot runs on **owned media** (`PARTNER_WEB`): the Partner shows the advert
in their own app or site, through their own Agent, and no customer data ever
leaves their boundary. That is the whole product claim, and it is the flow that
341 verification checks cover.

Meta and Google are `FEATURE_META_ENABLED` / `FEATURE_GOOGLE_ENABLED`, **off by
default**, and §84 keeps the channel unrequestable while they are off. They are
also the longest lead time and the only item needing privacy sign-off for data
leaving the Partner boundary.

**So the critical path to a live pilot is item 1 alone.** Items 2–4 run beside
it, and item 2 can be dropped entirely for a first pilot.

```
   Host + DNS ──┬──> pilot goes live on owned media
                ├──> Penetration test    (needs a deployed staging env)
                ├──> Meta / Google       (needs a live app on a real domain)
                └──> Contracts           (can start today, needs nothing)
```

---

## 1. Host, managed services, DNS — a purchase

Sizing is in `docs/DEPLOYMENT.md` and comes from the measured load baseline,
not a guess. For one or two Partners:

| | Spec | Notes |
| --- | --- | --- |
| Compute | 1 host, 4 vCPU / 8 GB | All services and the TLS terminator |
| PostgreSQL | Managed, 2 vCPU / 4 GB, 50 GB | The database is the cost centre |
| Redis | Managed, 1 GB | Rate limits, idempotency, §76.1 frequency state |
| Object storage | S3-compatible bucket | Creative assets |
| DNS | `api.` `app.` | Two names on one domain |
| Email | Brevo, free up to 300 a day | Confirmations, invitations, resets. Verify the sending domain (DKIM, DMARC) or they land in spam |
| Backup target | Anything **not** this host | NFS, object storage, another region |

Roughly **$120–160/month** on DigitalOcean or Linode, **$250–350** on AWS or
GCP for equivalent managed tiers. A pilot is far below the measured ceiling of
~700 req/s, so the smallest managed tier of each is genuinely enough.

### The region is a compliance decision, not a latency one

The spec prices in **INR** and targets **`IN`** geographies. If the pilot
touches Indian customers, India's DPDP Act 2023 governs it, and where the
database physically sits is a question your legal review will ask. Choose the
region **before** provisioning — `ap-south-1` (Mumbai) or `BLR1` (Bangalore) —
because moving a database between regions later is a migration, not a setting.

### After it exists

```sh
cp .env.prod.example .env.prod     # fill in every REQUIRED value
openssl rand -base64 32            # once per secret, never reused
pnpm preflight --env-file .env.prod
```

`preflight` refuses placeholder or reused secrets, seeded development
identities, the password grant, non-HTTPS URLs, a moving `IMAGE_TAG`,
placeholder alert webhooks, and a backup destination that never leaves the
host. Then follow `docs/DEPLOYMENT.md` → "First deployment, in order".

**Lead time: hours.** This is the only item on the critical path.

---

## 2. Meta App Review and Google Data Manager access

Skip this for a first pilot unless a Buyer specifically needs it.

### Meta

1. A **Meta Business Manager**, then **Business Verification** — legal entity
   documents. *A few business days*, and it blocks everything after it.
2. A Meta **App** with the **Marketing API** product enabled, live, on a real
   domain — which is why the host comes first.
3. **App Review for `ads_management`**: a written justification per permission
   plus **a screen recording of the feature actually working**. You cannot
   record that before the deployment exists.
4. **Marketing API Access Tier.** As of 4 May 2026 the old "Ads Management
   Standard Access" is renamed; *Limited Access* needs a verified Business
   Manager and a live app, and *Full Access* needs **500 Marketing API calls in
   15 days at under 15% error rate**.

That last point is a genuine chicken-and-egg: full rate limits require traffic
you cannot generate until you are live. Plan to launch on Limited.

### Google

**This one has a hard deadline that has already passed.** Since **1 April
2026**, Customer Match uploads through the Google Ads API fail; the **Data
Manager API** is the only supported path.

Oolix already targets Data Manager — §48.2 forbade the old API for new work,
and the adapter was built against it. Nothing to change; it is simply now the
only option rather than the preferred one.

You need: a **Google Ads manager account**, a **developer token**, a **Google
Cloud project with the Data Manager API enabled**, and **OAuth2 credentials**.

### Before the first real upload

§48.2 asks for normalization and batch limits to be re-checked against the
**live** documentation. Do this — a normalization change is invisible until
match rates quietly drop, and by then customer data has already been uploaded
in the wrong shape.

Then, on a real account with a small test audience:

```sh
FEATURE_META_ENABLED=true pnpm verify:channels
```

**Lead time: weeks.** Business Verification and App Review dominate.

---

## 3. A penetration engagement

52 automated probes catch **regressions**. They do not catch business-logic
abuse — a tester who understands what an approval *means* and tries to get paid
for delivery that never happened.

**Scope it as** (this is `docs/GO-LIVE.md` §87.1's own wording, updated for
sign-in now living in Oolix): sign-up, sign-in, sessions, password reset and
invitations, and RBAC; organization isolation; the Agent registration and revocation path; and
the manifest signing chain.

**Hand them:**

- `docs/SECURITY-REVIEW.md` — what was already reviewed, and the named gaps
- `pnpm probe` and `pnpm probe:authed` — so they start where these stop
- `partner/pack/openapi.yaml` — the full API surface
- A staging deployment with two Partner tenants and one Buyer

**Ask for a retest after fixes to be included in the price.** A report you
cannot prove you acted on is worth much less at the next compliance review.

Roughly **$5,000–15,000** for a focused application engagement. **Lead time:
2–4 weeks** including scheduling.

---

## 4. Contracts and privacy sign-off

Can start today. Needs no code and no infrastructure.

| Document | Covers |
| --- | --- |
| Partner agreement | Payout model and unit price, approval SLA, kill-switch rights, what the Agent may run on |
| Buyer agreement | Budget commitment, billing basis, what a "qualified lead" means (§102) |
| Data Processing Agreement | Who is controller and who is processor, per flow |
| Privacy assessment | Lawful basis for the audience, retention, and DPDP Act consent if Indian customers are involved |

### Five terms that are not only paperwork

The documents are paperwork. Five of their terms are also **configuration**,
and the system will compute a perfectly correct invoice from a wrong number
without ever noticing.

| Term to agree | Where it is entered | If it disagrees with the contract |
| --- | --- | --- |
| Payout model | `partner_payout.model` — CPM, CPC, CPL, CPQL, FIXED or HYBRID | Every settlement uses the wrong basis |
| Unit price | `partner_payout.unit_price_minor` | Every payout is off by that factor |
| What a "qualified lead" is | `lead_definition.qualified_statuses`, plus the optional `valid_lead_rule` / `qualified_lead_rule` | The Buyer is billed for the wrong events |
| Duplicate window | `lead_definition.duplicate_window_days` (default 30) | Too short and the Partner is paid twice for one person |
| Approval SLA | `approvalSlaDays` on the Partner profile (§101) | Requests expire on a day nobody agreed to |

Phase 7 verifies that §102 settlement arithmetic is correct and reproducible.
It cannot know whether the inputs match something a person signed. So agree
these as **exact values**, not prose — "CPQL at ₹450.00" rather than "cost per
qualified lead, to be agreed".

**The one that needs real attention:** the Meta/Google path is the *only* place
customer data leaves the Partner boundary. Owned media never does. If you are
not doing item 2 for this pilot, say so in the assessment — it makes the
privacy review dramatically simpler, and it is the strongest thing about the
architecture.

`docs/PILOT-READINESS.md` documents what the system does and does not hold, and
is written to be handed to a reviewer directly.

---

## Suggested order

1. **Today** — start contracts (item 4). Nothing blocks them.
2. **Day 1** — buy the host and DNS (item 1). Run `pnpm preflight`. Deploy.
3. **Week 1** — onboard the first Partner on owned media. **This is a live
   pilot.**
4. **Week 1, in parallel** — book the penetration test (item 3) against the
   staging deployment, and begin Meta Business Verification (item 2) if a Buyer
   wants external channels.
