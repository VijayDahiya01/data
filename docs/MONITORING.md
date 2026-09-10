# Monitoring and alerting

The metric names existed and the thresholds existed. What did not exist was
anything that collected them, so both lived only as log lines nobody was
watching. A threshold with no collector behind it is documentation.

There are **two** collection points, and they belong to different people.

| | Scraped by | Reachable from |
| --- | --- | --- |
| Oolix API `/metrics` | Oolix | Oolix's internal network only |
| Partner Agent `/metrics` | **the Partner** | inside the Partner's network only |

That split is not an oversight. The Agent runs inside the Partner's
infrastructure and Oolix deliberately cannot reach it — so decision latency and
the NO_AD reason mix are numbers only the Partner can collect, and Oolix must
not ask them to open a hole for it.

---

## The Oolix side

`GET /metrics` on the API, Prometheus text format, derived from the database on
each scrape. Nothing is held in process, so a replica that just started reports
the same numbers as one that has been up for a week.

| Metric | Answers |
| --- | --- |
| `oolix_agent_heartbeat_age_seconds{agent,partner_org}` | Is this Partner's Agent still checking in? |
| `oolix_agent_config_age_seconds{agent,partner_org}` | Is it serving a config Oolix has superseded? |
| `oolix_agents{status}` | How many Agents, in what state |
| `oolix_agents_never_seen` | Registered but never checked in — a stalled onboarding |
| `oolix_activations{status}` | Is anything actually live? |
| `oolix_partner_requests{status}` | What is waiting on a Partner |
| `oolix_partner_review_oldest_seconds` | How close the approval SLA is to breaking |

Per agent, not averaged: "one Partner's Agent is down" is the alert that
matters, and a mean across every Partner hides it completely.

**Not exposed publicly.** The exposition names Partner organisations and Agent
ids, which is operational detail no Buyer or Partner should be able to
enumerate. The TLS terminator returns 404 for `/metrics`; a collector reaches
the API directly on the internal network.

**No per-person label anywhere.** There is no customer identifier in the
control plane to label with (§54, §73), and a label is exactly where one would
end up by accident. A test asserts it.

## Running the collector

Opt-in, because a pilot may already have one and a second collector nobody
watches is worse than none — it looks like coverage:

```sh
docker compose -f infra/docker/compose.prod.yml --env-file .env.prod \
  --profile monitoring up -d
```

`infra/monitoring/alertmanager.yml` ships with placeholder webhooks. **Replace
them before the pilot takes real traffic**, or every rule fires into nothing.

## The rules

`infra/monitoring/alerts.yml`, validated with `promtool` — 7 rules.

The thresholds are not invented there: they are the same numbers the worker
already enforces (`HEARTBEAT_STALE_SECONDS = 300`,
`CONFIG_CRITICAL_SECONDS = 900`). If one moves, move both. A rule that
disagrees with the code pages at a moment the product considers healthy, or
stays silent at one it does not.

Severity is split deliberately:

- **page** — `AgentHeartbeatStale`, `AgentConfigCritical`, `MetricsScrapeFailing`.
  Serving is stopping, a revocation may not have landed, or the monitoring
  itself is blind.
- **ticket** — a stalled onboarding, an ageing approval, nothing live. Real,
  but paging someone at 3am for them is how a rota learns to ignore the channel.

`MetricsScrapeFailing` matters more than it looks: while it is firing, every
other rule in the file is silent.

---

## The Partner side

The Agent serves `GET /metrics` on its health port for the Partner's own
collector:

| Metric | Answers |
| --- | --- |
| `oolix_agent_ad_decisions_total{decision,reason}` | What is being served, and why not |
| `oolix_agent_ad_decision_duration_ms` | Histogram, bucketed around the 100ms budget |
| `oolix_agent_decision_budget_breaches_total` | How often §103 was missed |
| `oolix_agent_control_sync_failures_total` | Can it reach Oolix |
| `oolix_agent_last_control_sync_age_seconds` | `-1` means it never has |

`-1` rather than `0` for "never synced" is deliberate: zero reads as "synced a
moment ago" on every dashboard, which is the opposite of the truth.

Labels are bounded on purpose. Decision and reason come from fixed enums;
placement is left out because it is unbounded in principle, and cardinality
that grows with a Partner's catalogue turns a metrics endpoint into an outage
of its own. There is no per-user label, and a test asserts that too — monitoring
data is copied to more places, and kept longer, than anyone plans for.

---

## What is not covered

**Queue lag.** `SQS_DOMAIN_EVENTS_URL` is optional and a scheduler-only worker
is a valid deployment, so there is nothing to measure until a queue is actually
configured. Add the exporter with the queue.

**Ad-serving volume as a business metric.** Impressions and clicks are reported
through the existing reporting path on their own schedule, not scraped here.
