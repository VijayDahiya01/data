# Partner data platform — design for scale

**Status:** every phase of the roadmap (§9) is built on `feat/partner-connect`.
Phases 6 and 7 — the hosted Agent and the cross-Partner clean room, both in
AWS Nitro Enclaves — are described for operators in
[`DEPLOY-ENCLAVE.md`](DEPLOY-ENCLAVE.md), with the checks still to run on real
enclave hardware. A joint audience reaches the asking Partner's Agent and is
kept there; letting Buyers target it in campaigns is the next step.
**Builds on:** Partner Connect (branch
`feat/partner-connect`), described for non-engineers in
[`PARTNER-CONNECT.md`](PARTNER-CONNECT.md).

**The question this answers:** how does any Data Partner — whatever database
they run, however they store their data — connect to Oolix with almost no work,
and how does that keep working at a thousand Partners and a hundred million
customers each?

It is written from three chairs at once:

| Chair                | What they need from this design                                                                                                                          |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Data Partner**     | Under an hour of their engineer's time. One read-only login. Nothing installed in their database, only a light read-only load on it, nothing leaving it. |
| **Business manager** | Fast onboarding, many attributes per Partner, Partners who pass their own security review, a cost that does not grow with every new Partner              |
| **Tech lead**        | One standard model for every source, correct answers when Partners store the same thing differently, and headroom for 100× growth                        |

---

## 1. Where we are today

Partner Connect already does the core of this:

- The **Agent** runs inside the Partner's network, reads their database with a
  read-only login, and keeps a **cleaned copy** on their server. Oolix receives
  attribute names, count ranges and quality percentages — never data.
- **Sources:** PostgreSQL, MySQL/MariaDB, SQL Server, MongoDB, CSV/Excel.
- **Cleaning:** dates in any format, codes and synonyms, unknown values asked
  rather than guessed, only adults who agreed to marketing copied, IDs scrambled.
- **Orders and bookings** tables summed up per customer; **incremental** sync on
  a changed-at column; **quality** reported as percentages.

**What it cannot do yet** — and what this design fixes:

1. **The same fact stored differently.** Age comes only from a date of birth. A
   Partner who stores `age = 25`, or an age band `25-45`, or a birth year
   `1992`, gets nothing for age today. The same is true of recency stored as a
   number of days, or purchase counts over a different window.
2. **Very large tables.** Each table is read in one long query. On a
   100-million-row production database that is a multi-hour transaction — bad
   for the Partner's database.
3. **The long tail of sources** — Oracle, warehouses, SaaS platforms, files in
   cloud buckets.
4. **Data laid out differently.** Customer details split over several tables,
   kept as key–value rows (WordPress, Magento), or held in lists inside
   MongoDB documents — lists are skipped today.
5. **Partners who cannot run a server**, and real-time consent withdrawal.
6. **Discovery** (found while testing): a Partner who connects only through
   Partner Connect is invisible to Buyers unless both are in a Network, or the
   Partner also lists a Marketplace segment — and Networks cannot be created
   from the product yet.

---

## 2. Target architecture at a glance

```
 PARTNER'S NETWORK                                                       OOLIX CLOUD
┌───────────────────────────────────────────────────────────────┐
│ Sources                Agent                                   │
│ ┌──────────────┐  read ┌───────────────────────────────────┐  │   names, ranges,  ┌──────────────┐
│ │ Postgres     │ ─────►│ Connector ─► Normaliser ─► Store  │──┼── percentages ──►│ Control plane │
│ │ MySQL, SQLSrv│ only  │ (one per    (representation  (copy,│  │                  │ matcher       │
│ │ Oracle, Mongo│       │  protocol)   → standard form) IDs   │◄─┼── signed ────────│ portal        │
│ │ Warehouses   │       │                               scrambled) │  campaigns     └──────────────┘
│ │ Files, SaaS  │       │ Serving: consent + audiences in memory │  │                         │
│ └──────────────┘       └───────────────────────────────────┘  │                  (future) TEE
│ Partner backend ── "show ad to C123?" ──► Agent ──► ad / no ad │                  clean room for
└───────────────────────────────────────────────────────────────┘                  cross-Partner work
```

Three rules that never change, whatever is added:

1. **Oolix's cloud never connects to a Partner's database.** The Partner gives a
   read-only login to _their own_ Agent, inside their own network. No inbound
   firewall rule, no credential at Oolix.
2. **Only the standard form leaves the connector.** Every source, however odd,
   is turned into the same standard attributes before anything else touches it.
   Adding a source never changes matching, serving or Oolix.
3. **Only metadata and ranges reach Oolix.** Attribute names, precision, count
   ranges, percentages, health.

---

## 3. How a Partner gives access

### 3.1 The access ladder

The Partner picks the first rung that works for them. Every rung ends in the
same normalised copy.

| #   | How                                     | Partner's work                                | Best for                                                    | Status                                         |
| --- | --------------------------------------- | --------------------------------------------- | ----------------------------------------------------------- | ---------------------------------------------- |
| 1   | **Read-only database login**            | Run the 2–4 lines of SQL the setup page shows | Most Partners                                               | Done                                           |
| 2   | Same login, on a **read replica**       | Point the login at the replica                | Tables over ~10M rows, busy production databases            | Advise in UI                                   |
| 3   | **A view** with only the needed columns | One `CREATE VIEW`                             | Privacy-strict Partners who want to hide columns themselves | Works today                                    |
| 4   | **File exports**                        | Schedule an export they already make          | No database access; SMBs; Excel/Tally users                 | Done: a folder, SFTP, S3, GCS, Azure Blob      |
| 5   | **Warehouse** service account           | Create a read-only service account            | Partners whose data lives in BigQuery, Snowflake, Redshift  | Done: BigQuery, Snowflake                      |
| 6   | **SaaS platform** sign-in               | Click "Allow" (OAuth)                         | Shopify, WooCommerce, Salesforce, HubSpot, Zoho             | Shopify done (an app token); WooCommerce by its database, with a template |
| 7   | **Push API** to their own Agent         | Their system calls their Agent                | Anything we cannot read; **instant consent withdrawal**     | Done                                           |
| 8   | **Change stream (CDC)**                 | Grant a replication role                      | Very large or fast-changing tables                          | Later                                          |

Rung 7 deserves a note: it turns "we cannot read your system" into "send us what
you have", and it is also how a withdrawal of consent takes effect in seconds
instead of at the next nightly refresh — the Partner's app calls
`DELETE /private/v1/customers/{id}` on its own Agent when someone opts out.

### 3.2 One connector per protocol, not per product

Most databases speak one of a few wire protocols, so a handful of connectors
covers most of the market:

| Connector           | Also covers                                                                                                                                      | Status               |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------- |
| PostgreSQL          | Amazon RDS & Aurora, Google Cloud SQL & AlloyDB, Azure, Supabase, Neon, CockroachDB, YugabyteDB, **Redshift** (to test)                          | Done                 |
| MySQL               | MariaDB, Aurora MySQL, TiDB, PlanetScale, SingleStore, **WooCommerce, Magento**                                                                  | Done                 |
| SQL Server          | Azure SQL, Amazon RDS for SQL Server                                                                                                             | Done (CI to confirm) |
| MongoDB             | Atlas, Amazon DocumentDB, Azure Cosmos DB (Mongo API)                                                                                            | Done                 |
| Files               | CSV, TSV, Excel, JSON lines, Parquet; from a folder, S3, GCS, Azure Blob, SFTP                                                                   | Done                 |
| Oracle              | Oracle Cloud, on-premise — banks, insurers, large enterprises                                                                                    | Done (CI to confirm) |
| BigQuery, Snowflake | Their warehouses                                                                                                                                 | Done                 |
| DynamoDB, Firestore | App-first companies on AWS / Firebase                                                                                                            | Later                |
| Long tail           | An optional adapter that runs existing open-source (Airbyte-protocol) source connectors beside the Agent — 300+ sources without writing each one | Later, opt-in        |

**Priority comes from the market, not from technology.** In India: D2C and
e-commerce run Shopify, WooCommerce and Magento (MySQL); travel runs MySQL,
PostgreSQL and SQL Server; banks and insurers run Oracle and SQL Server; app
companies run MongoDB, Firebase and BigQuery; retail chains export from their
ERP or Tally to Excel. Sales should confirm the order before Phase 3.

### 3.3 Every connector does the same five things

The `Source` interface already exists. Every new connector implements it and
must pass one shared **conformance kit**: the same deliberately messy customer
set loaded into each database must come out of the Agent as the _identical_
cleaned table. That kit is how a new connector is trusted without re-testing
everything downstream.

```
Test()    Tables()    Columns(table)    Sample(table, n)    Stream(table, columns) / StreamSince(...)
```

### 3.4 Reading without hurting the Partner's database

What a Partner's database administrator will ask about first:

- **Read-only, enforced twice** — the login, and a read-only session (done).
- **Only the mapped columns** are read (done).
- **Chunked, resumable reads (done):** read in slices of ~10,000 rows by
  primary key (`WHERE id > last ORDER BY id LIMIT 10000`) instead of one long
  query. No long transaction on their primary, a failed sync resumes where it
  stopped, and the load is steady and small.
- **Time window, speed limit, time limit:** the refresh runs at 2 am in the
  Partner's time zone by default, a rows-per-second limit the Partner can set,
  and a per-query time limit (`statement_timeout`, or a deadline) so a slow
  read is stopped before it can slow their application (all done).
- **Replica advice (done):** when a table is over ~10M rows, the setup page
  suggests pointing at a read replica.

### 3.5 How the data is laid out, not just which database

"Any database" is half the problem. The other half is how the data is laid
out inside it. Each layout maps onto the same standard copy:

| Layout                             | Example                                                                            | How the Agent reads it                                                                                                                                                              | Status                   |
| ---------------------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| One row per customer               | `customers(id, dob, city, …)`                                                      | Read directly                                                                                                                                                                       | Done                     |
| Nested documents                   | MongoDB `{_id, profile: {DOB, city}}`                                              | Flattened to `profile.DOB`, `profile.city`                                                                                                                                          | Done                     |
| One row per order or booking       | `orders(customer_id, ordered_at, …)`                                               | Summed up per customer                                                                                                                                                              | Done                     |
| Customer details split over tables | `users` + `user_profiles` + `addresses`                                            | An "add another customer table" step joins them on the customer ID. Where one customer has several rows (addresses), the Partner picks which counts: the default one, or the latest | Done                     |
| Key–value rows                     | WordPress `wp_usermeta(user_id, meta_key, meta_value)`; Magento's attribute tables | Pivoted: each `meta_key` the Partner picks becomes a column                                                                                                                         | Done                     |
| Lists inside a document            | `interests: ["travel", "cricket"]`, `addresses: [{…}, {…}]`                        | Read as the element marked default or primary, else the first; as a set, or as a table of its own: later                                                                           | Done (primary element)   |
| A folder of dated files            | `customers_2026-10-27.csv`                                                         | The newest file, or every file in date order                                                                                                                                        | Done (the newest)        |

Platform templates (§8) pre-fill these choices for known systems. WooCommerce,
for example, keeps one row per customer in `wc_customer_lookup` and one per
order in `wc_orders` (or, on older stores, `wc_order_stats`), so a Partner on
a known platform confirms rather than chooses. Built for WooCommerce: the
setup page offers its layout, counting only completed and processing orders,
and MailPoet's subscriptions as consent where that plugin is installed.
Every orders table can now say which statuses count.

---

## 4. Linking: where the Agent runs

| Option                          | Partner's work                                   | Trust story                                                         | When                                                                                                                                       |
| ------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| **Self-hosted, Docker Compose** | Three commands on any server with Docker         | Data never leaves their network                                     | Done — the default                                                                                                                         |
| Self-hosted, **Kubernetes**     | `helm install`                                   | Same                                                                | Done — larger Partners: a Helm chart with the setup page (`partner/pack/helm/oolix-agent`)                                                 |
| Self-hosted, **single binary**  | Install a service (Linux or Windows)             | Same                                                                | Done — Partners with no Docker, many Windows/SQL Server shops                                                                              |
| **Cloud marketplace image**     | One click in AWS/Azure into their VPC            | Same                                                                | Later                                                                                                                                      |
| **Oolix-hosted, in a TEE**      | Allow one IP or a private link to their database | Runs in a hardware enclave; attestation proves Oolix cannot read it | Built — Partners with no servers at all (`DEPLOY-ENCLAVE.md`)                                                                              |

The last row is where the TEE work pays off twice: the same enclave technology
that would later power cross-Partner matching also lets Oolix run a Partner's
Agent for them **without being able to see their data**. It is the only option
that is both zero-infrastructure for the Partner and keeps the privacy promise.

---

## 5. Matching attributes — the heart of the design

### 5.1 The problem

The same fact arrives in many shapes. Using the examples that started this
design:

| Partner | Column       | Value         | What it really means                                                    |
| ------- | ------------ | ------------- | ----------------------------------------------------------------------- |
| A       | `age_group`  | `25-45`       | Somewhere between 25 and 45 years old — **when the band was recorded**  |
| B       | `age`        | `25`          | 25 years old **on some date** — today, or when they signed up?          |
| C       | `dob`        | `25 Oct 2025` | A date of birth — this person is 1 year old (and is left out: under 18) |
| D       | `birth_year` | `1992`        | Born some time in 1992                                                  |

Note that `25 Oct 2025` means nothing on its own. In a `dob` column it is a
birth date. Next to an `age` column it may be the day that age was recorded —
`25` on 25 Oct 2025 means 26 or 27 today. In a `last_order` column it is a
recent purchase. **Meaning is decided per column, never per value.**

A Buyer then asks for "age 30 to 40". Partner A cannot answer that precisely;
Partner B's answer goes wrong a year after the data was recorded unless it is
aged forward; Partner C's answer is exact. A design that pretends these are the
same thing will either show ads to the wrong people or hide good Partners.

### 5.2 The model: concept → representations → standard form → precision

Each standard attribute gets:

1. **A concept** — what it means ("years since birth").
2. **Accepted representations** — the shapes Partners use, each with a
   converter.
3. **One standard storage form** — chosen so the value **stays correct over
   time** without rewriting it.
4. **A precision** — how exactly this Partner knows it, published to Oolix as
   metadata (never values).

**Rule 1: store facts that do not change, derive the rest at question time.**
Age changes every day; a birth date does not. Days-since-last-order changes
every day; the order date does not. So the store keeps dates, and age or
recency is worked out when a Buyer asks. (This is already how date of birth and
last-order date work.)

**Rule 2: store what is uncertain as a range.** A value known exactly is a range
whose two ends are equal. A band is a wider range. Every representation fits
the same two columns.

### 5.3 Worked example: age

Standard storage: two columns, `birth_date_min` and `birth_date_max` — the
earliest and latest birth date this customer could have.

| Representation                                         | Detected from                                     | Stored as (`as_of` = when recorded)                                                       | Precision  |
| ------------------------------------------------------ | ------------------------------------------------- | ----------------------------------------------------------------------------------------- | ---------- |
| Date of birth, any format                              | Dates; names like `dob`, `birth_date`             | `[dob, dob]`                                                                              | exact      |
| Birth year                                             | Whole numbers 1900–2010; `yob`, `birth_year`      | `[1 Jan, 31 Dec]` of that year                                                            | 1 year     |
| Age in years                                           | Whole numbers 0–120; `age`                        | born after `as_of − (age+1) years`, on or before `as_of − age years`                      | 1 year     |
| Age band `25-45`, `25 to 45`, `35+`, `<25`, `under 25` | Text ranges; `age_group`, `age_band`, `age_range` | born after `as_of − (hi+1) years`, on or before `as_of − lo years` (open-ended for `35+`) | band width |
| Words (`young`, `senior`)                              | Few distinct text values                          | Asked once: "what ages does `senior` mean?" → a band                                      | band width |

**Where `as_of` comes from** is the one question the setup page may need to ask,
in plain words: _"Is this age kept up to date, or is it the age when the
customer signed up?"_ If it is kept up to date, `as_of` is the sync date. If it
is the sign-up age, the page asks which column holds the sign-up date — or
offers the row's changed-at column. One click either way, and the value then
ages correctly every year with no work from the Partner.

**Answering a Buyer's rule** — "age between 30 and 40" on day T:

- **Certainly matches** when every possible age of this customer is inside
  30–40: `birth_date_min > T − 41 years` and `birth_date_max ≤ T − 30 years`.
  Both are plain date comparisons, as cheap as today's date-of-birth check.
- **Possibly matches** when the possible ages only overlap 30–40.

**Policy (recommended):** ads and audience lists use **certain matches only** —
nobody is shown an ad because they _might_ be in the audience. Reach estimates
show the certain range. So for "30–40":

| Partner                      | Stores       | Certain matches                                          |
| ---------------------------- | ------------ | -------------------------------------------------------- |
| C (dates of birth)           | exact        | exactly the right people                                 |
| B (age number, aged forward) | 1-year       | everyone born in the window; a few at the edges excluded |
| D (birth year)               | 1-year       | same as B                                                |
| A (band 25–45)               | 21-year band | **nobody** — the band is wider than the question         |

Partner A is not silently wrong and not silently hidden: **precision is
published with the capability**. For a band, that is the band edges themselves
(`age: BETWEEN, precision: bands 18-24, 25-45, 46+`), which describe the
Partner's format, not any customer. The matcher can then tell the Buyer
_"Partner A knows ages only as 25–45; widen the rule to 25–45 to include
them"_. When the band is kept up to date, a Buyer asking for "25 to 45" matches
Partner A's customers in that band exactly. Oolix needs one optional field in
the capability format and that hint in the matcher; the Agent does the rest.

### 5.4 The same model for every attribute

| Concept               | Representations accepted                                                                        | Stored as                                                                                            |
| --------------------- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Age                   | DOB, birth year, age + as-of, band + as-of, words                                               | birth-date range                                                                                     |
| Purchase recency      | last order date; "days since last order" + as-of; "bought in last 30 days" yes/no; orders table | last-order date range (`yes, last 30 days` = a 30-day range)                                         |
| Purchase count        | count over **its** window (30 / 90 / 365 days / lifetime); orders table                         | count range, **with its window**; answered only for that window, or computed exactly from orders     |
| Spend / income        | amount, band (`10k-20k`, `20L+`), currency                                                      | range in INR, with precision                                                                         |
| Location              | city name, state, **pincode**, lat/long, address text                                           | standard city / state / country codes; pincode → city and state from the public India Post directory |
| Gender                | words, letters, ISO codes                                                                       | code (done)                                                                                          |
| Categories, interests | one value, a list, an array (MongoDB), a comma-separated string                                 | a **set** of codes — a customer can be in several                                                    |
| Yes/no facts          | booleans, `Y/N`, `1/0`, dates ("subscribed on …")                                               | yes/no (done)                                                                                        |
| Last seen / booked    | dates in any format, Unix times, "days since"                                                   | date range                                                                                           |

Two consequences worth stating:

- **A count without its window is not the same attribute.** "5 orders in 30
  days" and "5 orders ever" must never answer the same question. The window is
  part of the representation, and the orders-table route (already built) is
  preferred because it computes the standard windows itself.
- **Hierarchies roll up, never down.** A Partner with cities answers state and
  country questions; a Partner with only states cannot answer a city question.

### 5.5 Detecting the representation, so the Partner does not have to

Detection already scores column names and sampled values. It gains
representation detection, per column:

1. **Name hints** — `dob` → date; `age` → number; `age_group` → band;
   `yob` → year; `days_since_order` → days.
2. **Value shapes** in the sample — all dates; whole numbers 0–120; 4-digit
   years; text matching `a-b`, `a+`, `<a`, `under a`, `a to b`; a few distinct
   words.
3. **Mixed columns** — when most values are one shape and a few another (`25`,
   `30`, `25-30`, `14/04/1992`), each value is read in its own shape where that
   is unambiguous, and the rest are listed for the Partner, as unknown values
   are today.
4. **Only what cannot be inferred is asked** — at most "kept up to date or at
   sign-up?" for ages, and "what does `senior` mean?" for words.

The setup page keeps showing real rows before and after, so the Partner sees
`25-45` → "25 to 45 years (as of 1 Mar 2025)" and `25` → "25 years (kept up to
date)" before anything is copied.

### 5.6 Codes at scale: getting unknown values down to zero

Today: exact codes, built-in synonyms, and the Partner's own answers. To scale
to thousands of Partners with thousands of category names:

1. **Shared synonyms, versioned and shipped with the Agent** (done; grows with
   every release).
2. **Fuzzy and transliterated matching** — `Gurgoan`, `गुरुग्राम` and
   `Gurugram` are one city; offered as suggestions the Partner confirms.
   _Built:_ text in the nine Brahmic scripts is romanised (one table serves
   them all, with north Indian schwa deletion), spellings are folded
   (`ee`/`i`, `ph`/`f`, doubled letters, `ai`/`e`), and a value within a
   letter or two of exactly one code is suggested. A value that is itself
   another place, or nearer one, is never suggested as a listed city:
   `Mangalore` is not a misspelled `Bangalore`. Parts of a city (`South Delhi`,
   `Bangalore North`, `Secunderabad`) are suggested as the city.
3. **Reference data** — the India Post pincode directory (~19,000 pincodes →
   district and state) turns a pincode column into city and state with no
   questions. _Built_ from GeoNames' copy (CC BY 4.0, credited on the setup
   page): a pincode gives its state, and its city only when every post office
   under it lies in the city — the postal district, with Thane, Manesar and
   Noida's villages carved out by name. Known places outside Oolix's list
   (`Lucknow`, `226001`, `Kerala`) are left empty and counted, not asked
   about.
4. **AI-assisted suggestions, opt-in** — for long-tail categories ("Running
   shoes" → FOOTWEAR), the Agent can send **distinct values only** — never rows,
   never customers — to a suggestion service and show the answers for the
   Partner to accept. Category names are not personal data; city names and
   anything else is excluded unless the Partner allows it. _Built:_ off unless
   the deployment sets `ANTHROPIC_API_KEY`; the Partner presses a button per
   attribute, which names what will be sent (place names included); values
   that look like an address, a phone number or an ID never leave; every
   answer is checked against the attribute's codes; six requests a minute
   per Agent.
5. **Learning, opt-in** — value → code answers that Partners confirm can be
   pooled (values only) to improve the shared synonyms for everyone. _Built:_
   the Partner ticks **Share my answers**; an Oolix admin approves each value
   (Partners counted, never named) before any Agent downloads it; unticking
   withdraws everything.

### 5.7 Identity: the ID the website sends

The copy is keyed by the customer ID the Partner's backend will send in an ad
request. Real Partners often have several — a CRM ID, an app user ID, a web
login ID. The design allows **several ID columns per customer** (each scrambled
separately), so an ad request with any of them finds the customer. Hashed email
and phone are kept the same way **only if** the Partner enables future
cross-Partner matching, under its own consent.

### 5.8 Changes in the Partner's schema

A renamed or dropped column must never break serving:

- The nightly sync fails safely — yesterday's copy keeps serving (done).
- To build: the setup page and the portal say _"column `dob` no longer exists —
  choose again"_, and Oolix's operations team sees "Partner X: sync failing 2
  nights" (health only, no data).
- New columns that look useful are suggested at the next visit.
- The Partner's own monitoring can already watch the Agent: it serves
  Prometheus `/metrics`, `/healthz` and `/readyz`.

---

## 6. Scale: what breaks first, and the fix

| Dimension                     | Comfortable today                               | Breaks around                      | Fix                                                                                                                                                                                                                                                                                 |
| ----------------------------- | ----------------------------------------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Customers per Partner         | ~10M (full nightly copy ≈ minutes)              | 50–100M (hours; long source query) | Chunked resumable reads (§3.4); incremental by default; CDC for the largest                                                                                                                                                                                                         |
| Ad decisions per Agent        | hundreds per second (indexed lookups)           | thousands per second               | Keep consent and audience membership **in memory** as compressed bitmaps, over a small number given to each customer at each refresh (a 10M-member audience ≈ a few MB); lookups in microseconds; several replicas behind the Partner's load balancer with shared Redis (supported) |
| Audience lists                | a table of member rows                          | many large audiences               | The same bitmaps, rebuilt per materialization                                                                                                                                                                                                                                       |
| Counting for reach estimates  | PostgreSQL scans                                | 100M rows × many estimates         | Column-store for counting (DuckDB inside the Agent, or a columnar Postgres extension)                                                                                                                                                                                               |
| Agents per Oolix deployment   | hundreds (30-second polling)                    | ~5,000                             | Long-poll or server-sent events for config; cached signed bundles                                                                                                                                                                                                                   |
| Reach estimate wait           | up to 30 s (each Agent polls for estimate work) | Buyers building audiences live     | The same long-poll, so an Agent answers in a second or two; recent answers cached per rule set                                                                                                                                                                                      |
| Partners onboarding per month | assisted by engineers                           | dozens                             | Self-serve funnel with step metrics (§7)                                                                                                                                                                                                                                            |
| Agent versions in the field   | manual upgrades                                 | hundreds of Partners               | Signed releases, staged rollout, Partner-controlled auto-update, support for the last 3 versions (done: `DEPLOY-PARTNER-AGENT.md`, "Updates")                                                                                                                                                                                    |
| Taxonomy changes              | edited by hand                                  | new attributes monthly             | Versioned taxonomy; Agents declare the version they support. The local copy is rebuilt at every full refresh, so a new attribute needs no migration there                                                                                                                           |

**Security that has to scale with trust:** builds are already reproducible —
the Agent image is built with `-trimpath` and an empty build ID, so a Partner's
security team can rebuild it and compare hashes. To add: signed images and an
SBOM per release, a public security pack for Partners' InfoSec teams, a yearly
penetration test, and, for the hosted tier, enclave attestation.

**Compliance (DPDP Act) that has to scale with Partners:** consent required and
fail-closed (done); children excluded (done); erasure at the next sync, and in
seconds through the push API (§3.1); data in India — Partner data never
leaves the Partner's server, but Oolix's own database is on Neon in Singapore
today and should move to RDS in Mumbai before paying clients, as
`DEPLOY-AWS.md` already notes; purpose recorded per consent (marketing vs. future cross-Partner matching); a
standard Data Processing Agreement.

---

## 7. The business view

**The onboarding funnel is the product.** Measure each step — signed up,
verified, Agent connected, table chosen, published, first campaign approved,
first ad served — from the setup page (step names only, never data). Targets:

| Metric                                   | Target       |
| ---------------------------------------- | ------------ |
| Partner engineer time to connect data    | under 1 hour |
| Sign-up to first approved campaign       | under 1 week |
| Partners who finish without Oolix's help | over 70%     |
| Attributes per connected Partner         | 6 or more    |
| Average coverage of published attributes | over 60%     |
| Nightly syncs that succeed               | over 99%     |

**Offerings:**

| Tier                 | Who                       | What Oolix does                                       |
| -------------------- | ------------------------- | ----------------------------------------------------- |
| Self-serve (default) | Most Partners             | Nothing — the setup page does it                      |
| Assisted             | First pilots; enterprises | A one-hour screen-share with an Oolix engineer        |
| Hosted, in a TEE     | Partners with no servers  | Runs the Agent in an enclave it cannot read — premium |

**The biggest commercial risk is not technical — it is consent.** Many Indian
companies have customer data but no record of marketing consent, and without it
nobody can be shown an ad. Worth offering early: a simple consent banner and
preference page Partners can drop into their site and app, writing consent into
their own database where the Agent reads it.

**Data quality is a revenue lever.** Partners with better coverage reach more
Buyers. Showing each Partner their quality per attribute (done) and how it
compares to similar Partners turns "answer your unknown values" into something
they want to do.

**Shorten security reviews.** For enterprise Partners the longest step is their
InfoSec review, not the setup. A ready security pack — architecture, data flow,
what leaves the network, encryption, pen-test summary, DPA, source access to
the Agent — saves weeks per enterprise deal.

**Cost:** the Partner pays for one small server (around ₹2,000–3,000 a month);
Oolix's cloud cost per Partner is tiny (config sync and counts). Only the
hosted TEE tier has a real per-Partner cost (dedicated enclave-capable
instances), so it should be priced, not free.

---

## 8. The Data Partner's view

**Their total work, all of it:**

1. Run three commands on a server, copied from the portal (or click "Allow"
   for a SaaS platform).
2. Create one read-only login — the setup page shows the exact statements.
3. Click through the setup page: about six choices, mostly confirmations.
4. Add one backend route for ads — about fifteen lines (the integration guide
   has it). Show the answer or their own content.

Everything after that is automatic: nightly refresh, publishing, quality
reports, upgrades.

**What they will ask, and the answer:**

| Question                            | Answer                                                                                                                                                    |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Can Oolix see our customers?        | No. Data stays on your server; Oolix sees attribute names and count ranges.                                                                               |
| Will it slow our database?          | Read-only, only the chosen columns, at night, in small slices with a speed limit you can set; use a replica if you have one.                             |
| What if we want out?                | Delete all copied data with one button; stop the containers. Nothing was created in your database.                                                        |
| Who approves what runs on our site? | You do, campaign by campaign, and you can stop any campaign instantly.                                                                                    |
| What about our customers' rights?   | Only those who agreed are copied. Withdrawals drop out at the next refresh, or at once with **Refresh now**; with the push API, within seconds.           |
| Who maintains it?                   | Oolix releases signed versions. Turn on automatic updates and the Agent installs them at night; or press **Update now**, or apply them yourself.          |

**Making it even less work:**

- **Templates for known platforms.** If the tables look like WooCommerce,
  Shopify or Magento, every column is already mapped — the Partner just
  confirms. Big win for D2C brands. (Built: WooCommerce's layout, and the
  Shopify connector, which maps itself; Magento later.)
- **No-Docker install** for Windows and Linux servers (built).
- **The hosted tier** for Partners with no servers at all (built).

---

## 9. Roadmap

Ordered by value per week of work. Effort assumes one engineer.

| Phase | What                                                                                                                                                                                                                         | Why first                                                            | Effort    |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | --------- |
| 0     | Close what testing found: a "visible to all verified Buyers" switch for Partner Connect Partners (or Network admission); SQL Server CI; run the Compose bundle in real containers                                            | Without discovery, no new Partner can be reached                     | 1 week    |
| 1     | **Representations (§5):** age as number / band / year / words with as-of; recency as days or yes/no; counts with their window; precision in capabilities; certain-match targeting                                            | The example that started this design; widens which Partners can join | 2–3 weeks |
| 2     | **Safe big reads (§3.4)** and the **push API** (instant consent withdrawal, a fallback for any system)                                                                                                                       | Protects Partner databases; DPDP responsiveness                      | 2 weeks   |
| 3     | **Layouts (§3.5)** — joined customer tables, key–value rows, lists — then **connectors wave 2** by market: Oracle, BigQuery, Snowflake, files from S3/GCS/SFTP and Parquet, Google Sheets; WooCommerce and Shopify templates | Real databases are rarely one tidy table; reach more Partner types   | 4–5 weeks |
| 4     | **Serving at scale (§6):** in-memory bitmaps, Helm chart, single-binary install, signed auto-updates                                                                                                                         | Big Partners and many Agents                                         | 2–3 weeks |
| 5     | **Codes at scale (§5.6):** pincode directory, fuzzy and transliterated matching, AI-assisted suggestions (opt-in)                                                                                                            | Fewer questions for Partners, higher coverage                        | 2 weeks   |
| 6     | **Hosted Agent in a TEE (§4)**                                                                                                                                                                                               | Zero-infrastructure tier                                             | 6–8 weeks |
| 7     | **Cross-Partner clean room in a TEE** — overlap counts, then joint audiences                                                                                                                                                 | Only once two or more Partners are live, with matching consent       | 6–8 weeks |

---

## 10. Decisions needed

1. **Banded data:** target certain matches only (recommended), or also
   "possible" matches with a warning?
2. **Discovery:** a simple "visible to all verified Buyers" switch, or build
   Network admission first?
3. **Connector order:** confirm with sales which Partner types come first
   (decides Phase 3).
4. **AI-assisted mapping:** allowed, with values only and Partner opt-in?
5. **Hosted TEE tier:** offer it, and at what price?
6. **Consent for cross-Partner matching:** start collecting it now in Partner
   onboarding, so Phase 7 is not blocked later?
