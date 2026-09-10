# Load baseline

Measured 2026-09-03 with `scripts/load-baseline.mjs`. Not a capacity plan — a
starting point, so the next measurement means something.

**Where it was taken.** One developer laptop: the API as a host process, its
Postgres and Redis in containers, everything over loopback. A real host will
differ in both directions — better hardware, worse network. What transfers is
the *shape*: the ratios between these endpoints, and which of them is nowhere
near its budget.

Percentiles, never means. A mean hides the failure that matters: a p95 breach
with a healthy-looking average is the normal shape of a latency problem.

## Results

| Endpoint | Conc. | req/s | p50 | p95 | p99 | max |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| API `/healthz` — framework floor | 20 | 1,866 | 7.9 ms | 24.7 ms | 41.1 ms | 135.9 ms |
| API `/readyz` — touches the database | 20 | 684 | 23.7 ms | 54.9 ms | 102.9 ms | 513.2 ms |
| API `/metrics` — the scrape itself | 10 | 316 | 30.2 ms | 44.0 ms | 53.4 ms | 81.9 ms |
| Portal `/login` — production build | 20 | 335 | 57.5 ms | 82.2 ms | 92.4 ms | 166.5 ms |

Zero failures in every run.

## What this says

**There is plenty of headroom for a pilot.** A pilot is a handful of Buyers and
Partners doing occasional, deliberate things — creating campaigns, approving
them. Hundreds of requests per second is orders of magnitude beyond that. The
constraint on a pilot will be correctness and operations, not throughput.

**The database is the cost.** `/healthz` and `/readyz` differ only by touching
Postgres, and that difference is 2.7× the throughput and 2× the p95. Anything
that makes a page do more queries shows up here first. The `/readyz` max of
513ms is a connection-pool wait under sustained saturation, not a slow query.

**The scrape is cheap enough to keep.** 316 req/s for an endpoint polled every
30 seconds is not a concern.

**Do not baseline a development build.** The same portal page measured **10.6
req/s at a p50 of 803ms** in `next dev`, against **335 req/s at 57.5ms** from
the production image — a 30× difference, entirely from on-demand compilation.
The first number would have been alarming and meaningless.

## Not measured

**The Agent's ad decision path**, the one with the §103 100ms budget. It lives
inside the Partner's infrastructure and its latency is dominated by the
Partner's own database, so a number taken here would describe this laptop and
nothing else. What exists instead is instrumentation on the Agent itself: a
duration histogram bucketed around 100ms, a budget-breach counter, and a
warning log on every breach — collected by the Partner (see
`docs/MONITORING.md`). Establish that number during Partner onboarding, on
their hardware, against their data.

**Sustained or soak load.** These are twelve-second runs. They say nothing
about connection leaks, memory growth or index bloat over days.

**Write paths.** Everything here is a read. Campaign creation and approval
involve writes and an audit trail; measure those before assuming they scale
like reads.

## Repeating it

```sh
node scripts/load-baseline.mjs --url http://127.0.0.1:4000/readyz \
  --concurrency 20 --duration 12 --label "API /readyz"
```

`--budget 100` adds an over-budget count and percentage, for anything held to
the §103 deadline. The script discards a warm-up period and refuses to report
percentiles for a run where more than 1% of requests failed — a tidy p95 over a
failed run is worse than no number at all.
