# How the Partner side works

**For anyone who wants the whole picture — the team, a Partner's managers,
their security reviewers.** The engineer's step-by-step is
[`DEPLOY-PARTNER-AGENT.md`](DEPLOY-PARTNER-AGENT.md); the ad-slot integration
is in [`partner/pack/INTEGRATION-GUIDE.md`](../partner/pack/INTEGRATION-GUIDE.md).

The Partner's customer data never leaves their own server. A small program
from Oolix — the **Agent** — runs there. It keeps a cleaned copy of their
customer list and decides "show this ad or not" for each visitor. Oolix only
ever sees counts.

```
          PARTNER'S OWN NETWORK                                     OOLIX
┌──────────────────────────────────────────────────────┐
│ Their database ──read every night──► Agent + its own   │ ── attribute names ──►  Oolix API
│ (never changed)                      small copy        │    count ranges          and portal
│                                      (their server)    │ ◄── signed campaigns ──
│ Their website  ──"show an ad to C123?"──► Agent        │
│ backend        ◄──────── ad or no ad ─────            │
└──────────────────────────────────────────────────────┘
```

## 1. Setup — once, about 15 minutes

1. In the Oolix portal: **Your data → Connection → Get install command**.
   Copy the command shown there. It carries a one-time code, so the Agent
   connects itself to Oolix as it starts.
2. On any server in their network that has Docker, run it:

   ```sh
   mkdir oolix-agent && cd oolix-agent
   curl -fsSLo docker-compose.yml https://<oolix-api>/agent/v1/compose
   OOLIX_BOOTSTRAP_TOKEN=<one-time code> docker compose up -d
   ```

   Two containers start: the Agent, and a small database of its own.

3. Open the setup page on that server (`http://localhost:8083`; the password
   is in `docker compose logs agent | grep setup_password`) and follow the
   steps:

   | Step                      | What the Partner does                                                                                                                                                                         |
   | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | Connect to Oolix          | Done already by the install command; otherwise paste a one-time code from the portal                                                                                                                                                         |
   | Connect your database     | Give a **read-only** login: PostgreSQL, MySQL/MariaDB, SQL Server, Oracle, MongoDB, BigQuery, Snowflake; a Shopify store; a Google Sheet; or exports (CSV, Excel, JSON lines, Parquet) in a folder, on SFTP, or in S3, Cloud Storage or Azure |
   | Choose the customer table | Pick the table with one row per customer. A WooCommerce store gets its layout filled in, to confirm                                                                                         |
   | Check the matches         | Confirm what the tool found. It shows real rows cleaned: `14/04/1992` → 14 Apr 1992 (age 34), `Bombay` → MUMBAI, `25-45` → age 25 to 45. An age, an age group or a number of days is asked about once: kept up to date, or true on another date such as sign-up. Values it cannot place are listed for the Partner to answer, never guessed |
   | Orders and bookings       | Optional: pick a table with one row per order or per booking, and tick which statuses count — a cancelled or refunded order is not a purchase                                                |
   | Consent and publish       | Choose the column that records agreement to marketing, then **Publish**                                                                                                                       |

That is all the data work: no SQL jobs, no mapping files, nothing created in
their database.

## 2. Every night — automatic

- The Agent reads the tables (read-only), cleans the values, and keeps **only
  adults who agreed to marketing**. Nobody else could be shown an ad, so
  nobody else's data is copied.
- Customer IDs are scrambled before they are stored.
- Orders and bookings are summed up per customer: last purchase, purchases in
  the last 90 days, main category, usual payment method, shops online; last
  booking, booked recently, latest trip domestic or international. The orders
  themselves are never kept.
- It tells Oolix which attributes it can answer (age, city, purchases…) and,
  after a full refresh, how complete they are — as percentages.

A very large customer table can name a _changed-at_ column: the nightly
refresh then reads only the customers changed since the last one, with a full
refresh once a week to notice customers deleted from the table.

## 3. When an advertiser runs a campaign

1. The advertiser builds an audience in Oolix — for example, women aged 25–40
   in Mumbai who bought in the last 30 days.
2. Oolix finds the Partners whose attribute list fits. It uses the list only,
   never the data, and only Partners this advertiser may see: those in a
   Network with them, and those who chose **List me for all verified
   advertisers** in the portal (**Your data → What Buyers can ask → Who can find you**).
   A Partner who connected through the setup page and is in no Network must
   turn that on to be found.
3. Oolix asks the Agent how many customers match. The Agent counts on the
   Partner's server and answers with a **range** such as 10K–50K, never an
   exact number.
4. The Partner **approves or rejects** the campaign in the portal. They stay
   in control, and can stop it at any time.
5. Once approved, the Agent builds the audience list on the Partner's server.

## 4. When a customer visits the Partner's website or app

1. The Partner's backend asks its Agent: _customer C123 is on the booking
   confirmation page — show an ad?_
2. In under 100 ms the Agent checks: is this customer in an approved audience,
   did they agree to marketing, have they already seen it too often?
3. It answers with an ad, or with _no ad_. The page shows the ad, or its own
   fallback content.
4. Only totals — how many views and clicks — go to Oolix, for reports and
   billing.

## 5. What the Partner's developer still does — about a day

Partner Connect removes the _data_ work, not the _show-the-ad_ work:

- In the portal, create the ad slots (**Placements**), e.g.
  `booking_success_offer`.
- In their backend, add **one route** that sends the logged-in customer's ID
  to the Agent and returns its answer. The integration guide has the code —
  about fifteen lines.
- On the page, render the answer, falling back to their own content when there
  is no ad. An ad must never slow down a booking or a checkout.

Ads are for **logged-in** customers only. An anonymous visitor gets no ad, by
design: there is nobody to check consent for.

## 6. What is kept where

| Place                                | What it holds                                                                                                                                                  |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The Partner's database               | Only read, once a night. Never changed                                                                                                                         |
| The Partner's server (the Agent)     | The cleaned copy — consenting adults only — with scrambled customer IDs, and the database login, encrypted                                                     |
| Oolix                                | Attribute names, count ranges, data-quality percentages, view and click totals. Never a name, phone number, email, customer ID or any value from their data |

## 7. Day to day

The Partner does almost nothing:

- The copy refreshes every night by itself. **Refresh now** on the setup page
  refreshes it at once — for example after customers withdraw consent.
- Optionally, their system tells the Agent directly: a customer who withdraws
  consent is out of every audience within a second, and stays out until the
  table records consent given again. The setup page shows the token and the
  two lines of code.
- Large tables are read in small slices, each a short read-only query, so
  the nightly read never holds their database for hours.
- They approve or reject campaigns in the portal, and can stop any campaign
  instantly.
- The setup page shows exactly what is stored, and has **Delete all copied
  data**, which also withdraws their attributes from Oolix.
- New versions of the Agent, signed by Oolix, install themselves at night if
  the Partner turns that on — or when they press **Update now**.

A Partner with a technical team can still set the Agent up by hand, against
tables they prepare themselves — the _advanced_ path in the deployment guide.
