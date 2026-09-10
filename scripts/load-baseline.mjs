#!/usr/bin/env node
/**
 * A load baseline, with no dependency to install.
 *
 * Deliberately not a load-testing framework. A framework would measure this
 * better, and it would also be one more thing to install on a machine that may
 * not have network access when someone needs the number. This does the one
 * thing a baseline needs: fixed concurrency, a warm-up that is discarded, and
 * percentiles from every sample rather than a running average.
 *
 * Percentiles, not means. A mean latency hides exactly the failure that
 * matters here: §103 gives an ad decision 100ms, and a p95 breach with a
 * healthy-looking mean is the normal shape of that problem.
 *
 *   node scripts/load-baseline.mjs --url http://localhost:8099/private/v1/ad-decision \
 *     --method POST --body '{"partner_user_id":"ACME-1","placement_id":"x"}' \
 *     --concurrency 20 --duration 15
 */
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    url: { type: 'string' },
    method: { type: 'string', default: 'GET' },
    body: { type: 'string' },
    concurrency: { type: 'string', default: '10' },
    duration: { type: 'string', default: '10' },
    warmup: { type: 'string', default: '2' },
    label: { type: 'string' },
    budget: { type: 'string' },
  },
});

if (!values.url) {
  console.error('usage: load-baseline.mjs --url <url> [--method POST] [--body json]');
  process.exit(2);
}

const concurrency = Number(values.concurrency);
const durationMs = Number(values.duration) * 1000;
const warmupMs = Number(values.warmup) * 1000;
const budgetMs = values.budget ? Number(values.budget) : null;

const headers = values.body ? { 'Content-Type': 'application/json' } : undefined;
const init = { method: values.method, headers, body: values.body };

/** One request. Returns latency in ms, or null if it failed. */
async function once() {
  const t0 = performance.now();
  try {
    const res = await fetch(values.url, init);
    // Drain the body: leaving it unread lets sockets pile up and measures the
    // wrong thing entirely.
    await res.arrayBuffer();
    return { ms: performance.now() - t0, ok: res.ok, status: res.status };
  } catch {
    return { ms: performance.now() - t0, ok: false, status: 0 };
  }
}

async function run(untilMs, collect) {
  const deadline = Date.now() + untilMs;
  const workers = Array.from({ length: concurrency }, async () => {
    while (Date.now() < deadline) {
      const r = await once();
      collect?.(r);
    }
  });
  await Promise.all(workers);
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  // Nearest-rank: with a few thousand samples the interpolated variants differ
  // by less than the measurement noise, and this one is explainable.
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[idx];
}

// Warm-up is discarded, not counted. The first requests pay for connection
// setup, JIT and a cold query plan; folding them in makes a baseline that
// cannot be compared with the next one.
process.stderr.write(`warming up ${values.warmup}s...\n`);
await run(warmupMs, null);

const samples = [];
let failures = 0;
const statuses = new Map();

process.stderr.write(`measuring ${values.duration}s at concurrency ${concurrency}...\n`);
const startedAt = Date.now();
await run(durationMs, (r) => {
  samples.push(r.ms);
  if (!r.ok) failures += 1;
  statuses.set(r.status, (statuses.get(r.status) ?? 0) + 1);
});
const elapsedSec = (Date.now() - startedAt) / 1000;

samples.sort((a, b) => a - b);
const rps = samples.length / elapsedSec;
const over = budgetMs ? samples.filter((s) => s > budgetMs).length : 0;

const report = {
  label: values.label ?? values.url,
  concurrency,
  seconds: Number(elapsedSec.toFixed(1)),
  requests: samples.length,
  rps: Number(rps.toFixed(1)),
  failures,
  statuses: Object.fromEntries(statuses),
  ms: {
    p50: Number(percentile(samples, 50).toFixed(1)),
    p90: Number(percentile(samples, 90).toFixed(1)),
    p95: Number(percentile(samples, 95).toFixed(1)),
    p99: Number(percentile(samples, 99).toFixed(1)),
    max: Number((samples.at(-1) ?? 0).toFixed(1)),
  },
};
if (budgetMs) {
  report.budget_ms = budgetMs;
  report.over_budget = over;
  report.over_budget_pct = Number(((over / samples.length) * 100).toFixed(2));
}

console.log(JSON.stringify(report, null, 2));

// A run where most requests failed is not a latency measurement, and reporting
// a tidy p95 for it would be worse than reporting nothing.
if (failures > samples.length * 0.01) {
  process.stderr.write(`\n${failures} of ${samples.length} requests failed.\n`);
  process.exitCode = 1;
}
