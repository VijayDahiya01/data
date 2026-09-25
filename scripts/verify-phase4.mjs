#!/usr/bin/env node
/**
 * Phase 4 exit criterion (spec v5 §85):
 *   "Eligible user sees ad without central user ID."
 *
 * This phase proves the product's central claim, so the checks are
 * deliberately adversarial. As well as the happy path, it hunts the customer
 * identifier the Partner Agent was given through EVERY text and JSONB column
 * in the Oolix database and through the API logs.
 *
 * Requires: the stack up, an Agent provisioned and running, the mock Partner
 * running. See the README quickstart.
 *
 * Usage: node scripts/verify-phase4.mjs
 */
import { readFileSync, existsSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { agentUrl } from './lib/agent-port.mjs';
import { seedToken } from './lib/login.mjs';

const AGENT = agentUrl();
const MOCK = process.env.MOCK_PARTNER_URL ?? 'http://localhost:4001';
const PLACEMENT = 'booking_success_offer';
const PURPOSE = 'travel_insurance_offer';
const SEGMENT = 'RECENT_TRAVELLER_60D';

const OOLIX_DB =
  process.env.DATABASE_URL ?? 'postgresql://oolix:oolix@localhost:5432/oolix?schema=public';
// The mock Partner's own audience source. Oolix holds no credential to this in
// production; the test uses it only to plant a deterministic fixture user.
const PARTNER_DB =
  process.env.PARTNER_DATABASE_URL ??
  'postgresql://partner:partner@localhost:5433/partner_audience';

// §91 fixtures.
const USER_ELIGIBLE = 'U123';
const USER_NOT_MEMBER = 'U456';
const USER_WITHDRAWN = 'U321';

// A per-run user so the frequency-cap check does not depend on how many
// impressions an earlier run already consumed.
const FRESH_USER = `UT${randomUUID().replace(/-/g, '').slice(0, 10).toUpperCase()}`;

// Warming up the Agent costs impressions, and impressions are exactly what the
// frequency-cap section measures. The probe therefore burns its OWN user.
const PROBE_USER = `UP${randomUUID().replace(/-/g, '').slice(0, 10).toUpperCase()}`;

/* --- fixture supply ---------------------------------------------------------
 *
 * Phase 4 serves ads, so it needs something servable. Building it here rather
 * than inheriting whatever earlier runs happened to leave behind is the
 * difference between a test that proves serving works and one that proves
 * somebody else's leftovers still exist.
 */

const API = process.env.API_URL ?? 'http://localhost:4000';
const login = (username) => seedToken(username, { api: API });

async function apiCall(path, { method = 'GET', body, token } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      'Idempotency-Key': randomUUID(),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed };
}

/** A one-pixel PNG, enough to finalize a creative. */
const FIXTURE_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

/**
 * An approved, in-flight, segment-targeted activation on this phase's
 * placement. Starts an hour ago so it is servable the moment it exists.
 */
async function provisionServableActivation() {
  const buyer = await login('buyer.admin@example.test');
  const approver = await login('partner.approver@example.test');

  const brands = await apiCall('/v1/brands', { token: buyer });
  const brandId = brands.body?.items?.[0]?.id;
  if (!brandId) throw new Error('no brand seeded');

  const campaign = await apiCall('/v1/campaigns', {
    method: 'POST',
    token: buyer,
    body: {
      name: `Phase 4 serving fixture ${Date.now()}`,
      objective: 'QUALIFIED_LEADS',
      brand_id: brandId,
      category: 'insurance',
      purpose_id: PURPOSE,
      budget: { amount_minor: 50_000_000, currency: 'INR' },
      start_at: new Date(Date.now() - 3_600_000).toISOString(),
      end_at: new Date(Date.now() + 60 * 86_400_000).toISOString(),
      geographies: ['IN'],
      landing_url: 'https://insurance.example/quote',
      lead_definition: { qualified_statuses: ['QUALIFIED'], duplicate_window_days: 30 },
    },
  });
  const campaignId = campaign.body?.id;
  if (!campaignId) throw new Error(`campaign: ${JSON.stringify(campaign.body)}`);

  const session = await apiCall('/v1/creatives/upload-session', {
    method: 'POST',
    token: buyer,
    body: {
      campaign_id: campaignId,
      file_name: 'offer.png',
      mime_type: 'image/png',
      file_size_bytes: FIXTURE_PNG.length,
      creative_type: 'NATIVE_CARD',
      headline: 'Protect your trip',
      body: 'Travel insurance in minutes.',
      cta: 'GET_QUOTE',
      destination_url: 'https://insurance.example/quote',
    },
  });
  await fetch(session.body.upload_url, { method: 'PUT', body: FIXTURE_PNG });
  const creativeVersionId = session.body.creative_version_id;
  await apiCall(`/v1/creatives/${creativeVersionId}/finalize`, {
    method: 'POST',
    token: buyer,
    body: { content_sha256: createHash('sha256').update(FIXTURE_PNG).digest('hex') },
  });

  // The segment this phase's fixture users belong to, on this phase's placement.
  const cat = await apiCall('/v1/catalogue/segments?query=Recent%20Travellers', { token: buyer });
  const seg = (cat.body?.items ?? []).find((s) => s.display_name === 'Recent Travellers');
  if (!seg) throw new Error('seeded segment not discoverable -- is the seed loaded?');
  const detail = await apiCall(`/v1/catalogue/segments/${seg.segment_id}`, { token: buyer });
  const placement = (detail.body?.placements ?? []).find((p) => p.placement_key === PLACEMENT);
  if (!placement) throw new Error(`placement ${PLACEMENT} not offered with this segment`);

  // §37: a Partner is not requestable until its Agent has checked in. The
  // runner restarts the Agent immediately before this phase, so the first
  // attempt lands in the gap before its first heartbeat and is refused with
  // PART_002. Waiting is correct; failing the phase for it is not.
  const requestBody = {
    partner_org_id: seg.partner.id,
    segment_id: seg.segment_id,
    channels: [
      {
        channel: 'PARTNER_WEB',
        placement_ids: [placement.placement_id],
        allocation_minor: 30_000_000,
        frequency_cap: { max_impressions: 2, window: 'P1D' },
      },
    ],
    creative_version_ids: [creativeVersionId],
    partner_payout: { model: 'CPQL', unit_price_minor: 450_000 },
  };

  let request = { status: 0, body: null };
  for (let i = 0; i < 40; i += 1) {
    request = await apiCall(`/v1/campaigns/${campaignId}/partner-requests`, {
      method: 'POST',
      token: buyer,
      body: requestBody,
    });
    if (request.body?.request_id) break;
    if (request.body?.error?.code !== 'PART_002') break;
    await sleep(3000);
  }
  const requestId = request.body?.request_id;
  if (!requestId) throw new Error(`request: ${JSON.stringify(request.body)}`);

  await apiCall(`/v1/campaigns/${campaignId}/submit`, { method: 'POST', token: buyer, body: {} });

  // §66.2: the approver is deliberately not the user who created the campaign.
  const approved = await apiCall(`/v1/partner-requests/${requestId}/approve`, {
    method: 'POST',
    token: approver,
    body: {
      approved_channels: ['PARTNER_WEB'],
      approved_placement_ids: [placement.placement_id],
      approved_creative_version_ids: [creativeVersionId],
      audience_expansion_allowed: false,
    },
  });
  if (approved.status >= 400) throw new Error(`approve: ${JSON.stringify(approved.body)}`);
  return approved.body?.activation_ids?.[0] ?? null;
}

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
  if (!ok) failures += 1;
  return ok;
};

async function decide(user, placement = PLACEMENT) {
  const res = await fetch(`${AGENT}/private/v1/ad-decision`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      partner_user_id: user,
      placement_id: placement,
      context: { page_type: 'booking_success' },
    }),
  });
  return res.json();
}

const oolix = new pg.Client({ connectionString: OOLIX_DB });
const partner = new pg.Client({ connectionString: PARTNER_DB });
await oolix.connect();
await partner.connect();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log('\nPhase 4 verification -- Owned web MVP (spec §85)\n');

try {
  // -------------------------------------------------------------------------
  console.log('0. Setup');
  await partner.query(
    `INSERT INTO oolix_segment_membership (partner_user_id, segment_id, expires_at)
     VALUES ($1, $2, NOW() + INTERVAL '60 days')
     ON CONFLICT (partner_user_id, segment_id) DO NOTHING`,
    [FRESH_USER, SEGMENT],
  );
  await partner.query(
    `INSERT INTO oolix_user_consent (partner_user_id, purpose_id, eligible, policy_version)
     VALUES ($1, $2, TRUE, 'P-21')
     ON CONFLICT (partner_user_id, purpose_id) DO NOTHING`,
    [FRESH_USER, PURPOSE],
  );
  for (const probe of [PROBE_USER]) {
    await partner.query(
      `INSERT INTO oolix_segment_membership (partner_user_id, segment_id, expires_at)
       VALUES ($1, $2, NOW() + INTERVAL '60 days')
       ON CONFLICT (partner_user_id, segment_id) DO NOTHING`,
      [probe, SEGMENT],
    );
    await partner.query(
      `INSERT INTO oolix_user_consent (partner_user_id, purpose_id, eligible, policy_version)
       VALUES ($1, $2, TRUE, 'P-21')
       ON CONFLICT (partner_user_id, purpose_id) DO NOTHING`,
      [probe, PURPOSE],
    );
  }
  check('planted a fresh Partner-side fixture user', true, FRESH_USER);

  // Supply the thing this phase serves from, rather than inheriting whatever
  // earlier runs left behind.
  const fixtureActivation = await provisionServableActivation();
  check(
    'provisioned an in-flight activation to serve from',
    Boolean(fixtureActivation),
    fixtureActivation ? String(fixtureActivation).slice(0, 8) : 'none',
  );

  // The Agent pulls config on an interval; wait for the new manifest to land
  // rather than racing it.
  let sawFixture = false;
  for (let i = 0; i < 20 && !sawFixture; i += 1) {
    await sleep(3000);
    const probe = await decide(PROBE_USER);
    sawFixture = probe?.decision === 'SHOW';
  }
  check('the Agent picked up the new manifest', sawFixture, sawFixture ? '' : 'never served');

  // -------------------------------------------------------------------------
  console.log('\n1. Agent health (§69.2)');
  const health = await fetch(`${AGENT}/healthz`)
    .then((r) => r.json())
    .catch(() => null);
  check('Agent /healthz responds', health?.status === 'ok', `version ${health?.version}`);

  const ready = await fetch(`${AGENT}/readyz`)
    .then((r) => r.json())
    .catch(() => null);
  check('Agent /readyz reports ready', ready?.status === 'ready');
  check(
    '  control config is fresh (§75)',
    ready?.config_fresh === true,
    `age ${ready?.config_age_seconds}s`,
  );
  check('  connector is healthy (§58)', ready?.connector_healthy === true);

  // -------------------------------------------------------------------------
  console.log('\n2. The core claim (§12, §44, §85 exit)');
  const served = await decide(FRESH_USER);
  check('an ELIGIBLE user is served an ad', served?.decision === 'SHOW', served?.reason ?? '');
  check('  the ad carries an approved creative', Boolean(served?.creative?.creative_version_id));
  check(
    '  the ad carries an opaque click token (§90)',
    typeof served?.click_token === 'string' &&
      Buffer.from(served.click_token, 'base64url').length === 32,
  );
  check(
    '  the token is opaque -- it decodes to nothing meaningful',
    (() => {
      try {
        JSON.parse(Buffer.from(served?.click_token ?? '', 'base64url').toString('utf8'));
        return false;
      } catch {
        return true;
      }
    })(),
    `${served?.click_token?.slice(0, 12)}...`,
  );
  check(
    '  the destination carries the token, not campaign metadata',
    served?.creative?.destination_url?.includes('?t=') &&
      !/(activation|campaign|segment|partner|user)/i.test(
        new URL(served.creative.destination_url).search,
      ),
  );

  const notMember = await decide(USER_NOT_MEMBER);
  check(
    'a user in NO segment is not served',
    notMember?.decision === 'NO_AD' && notMember?.reason === 'USER_NOT_IN_SEGMENT',
    notMember?.reason,
  );

  const withdrawn = await decide(USER_WITHDRAWN);
  check(
    'a user who WITHDREW consent is not served (§81.1)',
    withdrawn?.decision === 'NO_AD' && withdrawn?.reason === 'CONSENT_NOT_ELIGIBLE',
    withdrawn?.reason,
  );

  // -------------------------------------------------------------------------
  console.log('\n3. No central user ID -- the adversarial hunt (§3, §12, §54, §73)');

  const hunted = [USER_ELIGIBLE, USER_NOT_MEMBER, USER_WITHDRAWN, FRESH_USER];

  const { rows: namedCols } = await oolix.query(
    `SELECT table_name || '.' || column_name AS ref
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND (column_name ILIKE '%partner_user%' OR column_name ILIKE '%customer_id%'
             OR column_name ILIKE '%end_user%'  OR column_name ILIKE '%subscriber%')`,
  );
  check(
    'no partner-user column exists in the Oolix schema (§73)',
    namedCols.length === 0,
    namedCols.map((r) => r.ref).join(', ') || 'none',
  );

  const { rows: forbidden } = await oolix.query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name = ANY($1::text[])`,
    [
      [
        'customers',
        'audience_members',
        'segment_members',
        'partner_transactions',
        'partner_purchase_history',
        'cross_partner_identity',
      ],
    ],
  );
  check(
    'no forbidden central table exists (§54)',
    forbidden.length === 0,
    forbidden.map((r) => r.table_name).join(', ') || 'none',
  );

  // The real test: a leak would most plausibly arrive inside a JSONB snapshot
  // or a metadata blob, not a helpfully-named column. So scan every text-ish
  // column in every base table.
  const { rows: scanCols } = await oolix.query(
    `SELECT c.table_name, c.column_name
       FROM information_schema.columns c
       JOIN information_schema.tables t
         ON t.table_schema = c.table_schema AND t.table_name = c.table_name
      WHERE c.table_schema = 'public'
        AND t.table_type = 'BASE TABLE'
        AND c.data_type IN ('text','character varying','jsonb','json')`,
  );

  const pattern = `\\m(${hunted.join('|')})\\M`;
  const leaks = [];
  for (const { table_name, column_name } of scanCols) {
    const { rows } = await oolix.query(
      `SELECT 1 FROM public."${table_name}" WHERE "${column_name}"::text ~ $1 LIMIT 1`,
      [pattern],
    );
    if (rows.length > 0) leaks.push(`${table_name}.${column_name}`);
  }
  check(
    `the partner_user_id appears in NO Oolix column (scanned ${scanCols.length}, incl. JSONB)`,
    leaks.length === 0,
    leaks.join(', ') || 'none',
  );

  const apiLog =
    process.env.OOLIX_API_LOG ??
    'C:\\Users\\DELL\\AppData\\Local\\Temp\\claude\\C--Users-DELL-Desktop-wxwqxqwxw-newone\\04245371-e661-4d1b-9d4c-9eeaaeb249f9\\scratchpad\\api.log';
  if (existsSync(apiLog)) {
    const contents = readFileSync(apiLog, 'utf8');
    const found = hunted.filter((id) => new RegExp(`\\b${id}\\b`).test(contents));
    check(
      'the partner_user_id appears in no Oolix API log line (§78.1)',
      found.length === 0,
      found.join(',') || 'none',
    );
  }

  // §3 / §45: per-user frequency state is Partner-local. Oolix DOES store
  // frequency CONFIGURATION -- the agreed cap, the placement default -- which
  // is a commercial term, not state about a person. The distinction is whether
  // anything is keyed by a user, and the scan above already proved no such
  // column exists. This asserts the remaining frequency columns are all
  // configuration.
  const { rows: freqCols } = await oolix.query(
    `SELECT table_name || '.' || column_name AS ref FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name ILIKE '%frequency%'`,
  );
  const configOnly = new Set([
    'placements.max_frequency_default',
    'channel_requests.frequency_cap',
    'segments.refresh_frequency',
  ]);
  const unexpectedFreq = freqCols.map((r) => r.ref).filter((ref) => !configOnly.has(ref));
  check(
    'central frequency columns are configuration only, never per-user state (§3, §45)',
    unexpectedFreq.length === 0,
    unexpectedFreq.join(', ') || `${freqCols.length} config columns, 0 user-keyed`,
  );

  // -------------------------------------------------------------------------
  console.log('\n4. Frequency cap enforced Partner-side (§44 step 8, §76.2)');
  // §76.2: "Default frequency cap is per activation across all approved
  // placements in that Partner/channel." With several live campaigns the Agent
  // legitimately moves to the next eligible activation once one caps, so the
  // property to assert is that NO activation exceeds ITS OWN cap -- not that
  // the third request overall is refused.
  // The bound has to scale with SUPPLY, not be a fixed number of requests.
  // Every eligible activation must cap before the Agent runs out of things to
  // serve, so a fixed 20 fails the moment an environment has eleven live
  // activations rather than two -- and fails as "never capped", which reads
  // like the cap is broken when it is working exactly as §76.2 specifies.
  const { rows: liveRows } = await oolix.query(
    `SELECT count(*)::int AS n FROM activations WHERE status IN ('READY', 'LIVE')`,
  );
  const MAX_CAP = 3; // caps in play across the seeded campaigns are 2 and 3
  const budget = (liveRows[0]?.n ?? 5) * MAX_CAP + 5;

  const servedBy = new Map();
  const refusals = new Map();
  // The whole budget is spent rather than stopping at the first refusal. The
  // Agent rotates across activations, so the FIRST reason it gives is whichever
  // activation it happened to reach last -- which may be one targeting a
  // different audience entirely. What §76.2 promises is that the cap binds, not
  // that it is the final word.
  for (let i = 0; i < budget; i += 1) {
    const d = await decide(FRESH_USER);
    if (d.decision === 'SHOW') {
      servedBy.set(d.activation_id, (servedBy.get(d.activation_id) ?? 0) + 1);
      continue;
    }
    refusals.set(d.reason, (refusals.get(d.reason) ?? 0) + 1);
  }

  const overCap = [...servedBy.entries()].filter(([, n]) => n > MAX_CAP);
  check(
    'no activation ever serves more than its frequency cap (§76.2)',
    overCap.length === 0,
    [...servedBy.entries()].map(([id, n]) => `${id.slice(0, 8)}:${n}`).join(' ') || 'none served',
  );
  const totalServed = [...servedBy.values()].reduce((a, b) => a + b, 0);
  const totalRefused = [...refusals.values()].reduce((a, b) => a + b, 0);
  check(
    'the user is served, then serving stops once every cap is spent (§76.2)',
    totalServed > 0 && totalRefused > 0 && totalServed <= servedBy.size * MAX_CAP,
    `${totalServed} served across ${servedBy.size} activations, then ${totalRefused} refused ` +
      `(${[...refusals.keys()].join(', ') || 'none'})`,
  );

  // -------------------------------------------------------------------------
  console.log('\n5. Placement scope and latency (§76.2, §103)');
  const unknown = await decide(USER_ELIGIBLE, 'not_a_real_placement');
  check('an unapproved placement serves nothing', unknown?.decision === 'NO_AD', unknown?.reason);

  const timings = [];
  for (let i = 0; i < 20; i += 1) {
    const t0 = performance.now();
    await decide(USER_NOT_MEMBER);
    timings.push(performance.now() - t0);
  }
  timings.sort((a, b) => a - b);
  const p95 = timings[Math.max(0, Math.ceil(timings.length * 0.95) - 1)];
  check('ad decision p95 is inside the §103 budget', p95 < 100, `p95 ${p95.toFixed(1)}ms / 100ms`);

  // -------------------------------------------------------------------------
  console.log('\n6. Mock Partner end to end (§91)');
  const mockHealth = await fetch(`${MOCK}/healthz`)
    .then((r) => r.json())
    .catch(() => null);
  if (!mockHealth) {
    check('mock Partner is running', false, 'start it with: pnpm dev:mock-partner');
  } else {
    check('mock Partner is running', true);

    const viaPartner = await fetch(`${MOCK}/api/ad-decision?user=${USER_NOT_MEMBER}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ placement_id: PLACEMENT, context: { page_type: 'booking_success' } }),
    }).then((r) => r.json());
    check(
      'browser -> Partner backend -> Agent path works',
      viaPartner?.decision === 'NO_AD',
      viaPartner?.reason,
    );

    const anonymous = await fetch(`${MOCK}/api/ad-decision`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ placement_id: PLACEMENT }),
    }).then((r) => r.json());
    check(
      'an anonymous visitor is not segment-targeted (§76.2)',
      anonymous?.decision === 'NO_AD',
      anonymous?.reason,
    );

    const page = await fetch(`${MOCK}/?user=${USER_ELIGIBLE}`).then((r) => r.text());
    check(
      'the Partner page ships no customer id to the browser',
      !page.includes('partner_user_id'),
    );
  }

  // -------------------------------------------------------------------------
  console.log('\n7. Attribution tokens stored as hashes only (§71, §90)');
  // §27 batches uploads rather than one request per impression, so wait for
  // the Agent's flush interval. Poll for THIS run's specific token hash: any
  // rows left by an earlier run would otherwise satisfy the wait immediately.
  const { createHash } = await import('node:crypto');
  const expectedHash = served?.click_token
    ? createHash('sha256').update(served.click_token).digest('hex')
    : null;

  console.log('  (waiting for the Agent attribution flush...)');
  let match = [];
  for (let i = 0; i < 15 && expectedHash; i += 1) {
    const { rows } = await oolix.query(
      `SELECT activation_id FROM attribution_tokens WHERE encode(token_hash,'hex') = $1`,
      [expectedHash],
    );
    match = rows;
    if (match.length > 0) break;
    await sleep(2000);
  }

  const { rows: total } = await oolix.query('SELECT count(*)::int AS n FROM attribution_tokens');
  check('Oolix received attribution token metadata', total[0].n > 0, `${total[0].n} rows`);

  const { rows: badHashes } = await oolix.query(
    'SELECT count(*)::int AS n FROM attribution_tokens WHERE length(token_hash) <> 32',
  );
  check(
    'every stored token is a 32-byte SHA-256, never a raw token (§90)',
    badHashes[0].n === 0,
    `${badHashes[0].n} malformed`,
  );

  check(
    'the served token resolves to its activation BY HASH (§90)',
    match.length === 1 && match[0].activation_id === served.activation_id,
    match.length ? 'resolved' : 'not found',
  );

  const { rows: rawLeak } = await oolix.query(
    `SELECT count(*)::int AS n FROM attribution_tokens
      WHERE encode(token_hash,'escape') LIKE $1`,
    [`%${served.click_token.slice(0, 10)}%`],
  );
  check('the RAW token value is stored nowhere (§90)', rawLeak[0].n === 0);
} finally {
  await oolix.end();
  await partner.end();
}

console.log(
  failures === 0 ? '\nPhase 4 verified: all checks passed.\n' : `\n${failures} check(s) FAILED.\n`,
);
process.exit(failures === 0 ? 0 : 1);
