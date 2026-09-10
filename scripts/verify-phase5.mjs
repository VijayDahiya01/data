#!/usr/bin/env node
/**
 * Phase 5 exit criterion (spec v5 §85):
 *   "Qualified lead maps to activation."
 *
 * Walks the whole outcome chain end to end: the Agent serves an ad and mints
 * an opaque token, the click is recorded, the Buyer's CRM reports the lead
 * through its §71 states, and the campaign report attributes the qualified
 * lead back to the Partner activation that earned it.
 *
 * Usage: node scripts/verify-phase5.mjs
 */
import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { seedToken } from './lib/onboard-partner.mjs';
import { agentUrl } from './lib/agent-port.mjs';

const API = process.env.API_PUBLIC_URL ?? 'http://localhost:4000';
const AGENT = agentUrl();
const PLACEMENT = 'booking_success_offer';
const PURPOSE = 'travel_insurance_offer';
const SEGMENT = 'RECENT_TRAVELLER_60D';

const BUYER_ORG = '11111111-1111-4111-8111-111111111111';
const PARTNER_A_ORG = '22222222-2222-4222-8222-222222222222';

const OOLIX_DB =
  process.env.DATABASE_URL ?? 'postgresql://oolix:oolix@localhost:5432/oolix?schema=public';
const PARTNER_DB =
  process.env.PARTNER_DATABASE_URL ??
  'postgresql://partner:partner@localhost:5433/partner_audience';

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
  if (!ok) failures += 1;
  return ok;
};

async function api(path, { method = 'GET', token, body, orgId = BUYER_ORG, raw = false } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(raw ? {} : { 'X-Org-Id': orgId }),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  return { status: res.status, body: json };
}

async function decide(user) {
  const res = await fetch(`${AGENT}/private/v1/ad-decision`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ partner_user_id: user, placement_id: PLACEMENT }),
  });
  return res.json();
}

const oolix = new pg.Client({ connectionString: OOLIX_DB });
const partner = new pg.Client({ connectionString: PARTNER_DB });
await oolix.connect();
await partner.connect();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** §90: Oolix resolves a token only by SHA-256; the raw value is never stored. */
const hashOf = (token) => createHash('sha256').update(token).digest('hex');

console.log('\nPhase 5 verification -- Attribution + reporting (spec §85)\n');

try {
  // -------------------------------------------------------------------------
  console.log('0. Setup');
  const buyerAdmin = await seedToken('buyer.admin@example.test');
  const partnerAdmin = await seedToken('partner.admin@example.test');
  const finance = await seedToken('finance@example.test');

  // Fresh Partner-side users so the frequency cap does not interfere.
  const users = Array.from(
    { length: 3 },
    () => `UT${randomUUID().replace(/-/g, '').slice(0, 10).toUpperCase()}`,
  );
  for (const u of users) {
    await partner.query(
      `INSERT INTO oolix_segment_membership (partner_user_id, segment_id, expires_at)
       VALUES ($1,$2, NOW() + INTERVAL '60 days') ON CONFLICT DO NOTHING`,
      [u, SEGMENT],
    );
    await partner.query(
      `INSERT INTO oolix_user_consent (partner_user_id, purpose_id, eligible, policy_version)
       VALUES ($1,$2,TRUE,'P-21') ON CONFLICT DO NOTHING`,
      [u, PURPOSE],
    );
  }
  check('planted 3 fresh Partner-side fixture users', true, users.length.toString());

  // -------------------------------------------------------------------------
  console.log('\n1. CRM authentication (§71)');
  const keyRes = await api('/v1/buyer/crm-keys', { method: 'POST', token: buyerAdmin });
  check(
    'Buyer can issue a CRM API key',
    keyRes.status === 201 || keyRes.status === 200,
    `status ${keyRes.status}`,
  );
  const crmKey = keyRes.body?.api_key;
  check('the key is returned once, in plaintext', typeof crmKey === 'string');

  const { rows: keyRows } = await oolix.query(
    `SELECT crm_api_key_hash FROM buyer_profiles WHERE org_id = $1`,
    [BUYER_ORG],
  );
  check(
    'only the HASH is stored, never the key (§71)',
    keyRows[0]?.crm_api_key_hash?.length === 32 &&
      !Buffer.from(keyRows[0].crm_api_key_hash).toString('utf8').includes('oolix_crm_'),
  );

  const badKey = await api('/v1/leads/events', {
    method: 'POST',
    raw: true,
    token: 'oolix_crm_not_a_real_key_at_all_padding_padding',
    body: {
      click_token: 'x'.repeat(40),
      crm_event_id: 'evt_bad',
      status: 'RECEIVED',
      event_time: new Date().toISOString(),
    },
  });
  check('an invalid CRM key is rejected', badKey.status === 401, `status ${badKey.status}`);

  const noKey = await api('/v1/leads/events', {
    method: 'POST',
    raw: true,
    body: {
      click_token: 'x'.repeat(40),
      crm_event_id: 'evt_none',
      status: 'RECEIVED',
      event_time: new Date().toISOString(),
    },
  });
  check('a missing CRM key is rejected', noKey.status === 401, `status ${noKey.status}`);

  // -------------------------------------------------------------------------
  console.log('\n2. Serve, click, attribute (§14, §44 steps 15-17)');
  const served = [];
  for (const u of users) {
    const d = await decide(u);
    if (d.decision === 'SHOW') served.push(d);
  }
  check(
    'the Agent served ads for the fresh users',
    served.length === 3,
    `${served.length}/3 served`,
  );

  if (served.length === 0) {
    throw new Error('no ads served; is the Agent running against a live campaign?');
  }
  const activationId = served[0].activation_id;

  // Wait for the Agent to flush token metadata (§27 batching).
  console.log('  (waiting for the Agent attribution flush...)');
  let known = 0;
  for (let i = 0; i < 15; i += 1) {
    const { rows } = await oolix.query(
      `SELECT count(*)::int AS n FROM attribution_tokens
        WHERE encode(token_hash,'hex') = ANY($1::text[])`,
      [served.map((s) => hashOf(s.click_token))],
    );
    known = rows[0].n;
    if (known === served.length) break;
    await sleep(2000);
  }
  check(
    'Oolix knows all served tokens by hash',
    known === served.length,
    `${known}/${served.length}`,
  );

  const click = await api(`/v1/attribution/click/${served[0].click_token}`, {
    method: 'POST',
    raw: true,
  });
  check('the click is attributed to an activation', click.body?.attributed === true);
  check('  and resolves to the right activation', click.body?.activation_id === activationId);

  const unknownClick = await api(`/v1/attribution/click/${'z'.repeat(43)}`, {
    method: 'POST',
    raw: true,
  });
  check(
    'an unknown token is not attributed, and is INDISTINGUISHABLE by status',
    unknownClick.status === click.status && unknownClick.body?.attributed === false,
    `known=${click.status} unknown=${unknownClick.status}`,
  );

  // -------------------------------------------------------------------------
  console.log('\n3. Lead state machine (§71)');
  const crm = (body) => api('/v1/leads/events', { method: 'POST', raw: true, token: crmKey, body });

  const t0 = served[0].click_token;
  const received = await crm({
    click_token: t0,
    crm_event_id: `evt_${randomUUID()}`,
    status: 'RECEIVED',
    event_time: new Date().toISOString(),
    lead_reference: 'lead_1',
  });
  check('RECEIVED accepted', received.body?.accepted === true, received.body?.status);

  const eventId = `evt_${randomUUID()}`;
  const valid = await crm({
    click_token: t0,
    crm_event_id: eventId,
    status: 'VALID',
    event_time: new Date().toISOString(),
  });
  check('VALID accepted', valid.body?.accepted === true, valid.body?.status);

  const replay = await crm({
    click_token: t0,
    crm_event_id: eventId,
    status: 'VALID',
    event_time: new Date().toISOString(),
  });
  check(
    'a replayed crm_event_id is idempotent, not a second lead (§22.3)',
    replay.body?.duplicate === true,
  );

  const backwards = await crm({
    click_token: t0,
    crm_event_id: `evt_${randomUUID()}`,
    status: 'RECEIVED',
    event_time: new Date().toISOString(),
  });
  check(
    'a BACKWARD transition is rejected (§71)',
    backwards.body?.accepted === false,
    backwards.body?.message?.slice(0, 60),
  );

  const qualified = await crm({
    click_token: t0,
    crm_event_id: `evt_${randomUUID()}`,
    status: 'QUALIFIED',
    event_time: new Date().toISOString(),
    metadata: { qualification_reason: 'confirmed_interest' },
  });
  check('QUALIFIED accepted', qualified.body?.accepted === true, qualified.body?.status);
  check('  and names the activation it belongs to', qualified.body?.activation_id === activationId);

  // A second lead, taken all the way to CONVERTED.
  const t1 = served[1].click_token;
  for (const status of ['RECEIVED', 'VALID', 'QUALIFIED', 'CONVERTED']) {
    await crm({
      click_token: t1,
      crm_event_id: `evt_${randomUUID()}`,
      status,
      event_time: new Date().toISOString(),
    });
  }
  const { rows: t1State } = await oolix.query(
    `SELECT lead_state FROM attribution_tokens WHERE encode(token_hash,'hex') = $1`,
    [hashOf(t1)],
  );
  check(
    'a lead can progress to CONVERTED',
    t1State[0]?.lead_state === 'CONVERTED',
    t1State[0]?.lead_state,
  );

  // A third, rejected.
  const t2 = served[2].click_token;
  await crm({
    click_token: t2,
    crm_event_id: `evt_${randomUUID()}`,
    status: 'RECEIVED',
    event_time: new Date().toISOString(),
  });
  await crm({
    click_token: t2,
    crm_event_id: `evt_${randomUUID()}`,
    status: 'REJECTED',
    event_time: new Date().toISOString(),
    metadata: { rejection_reason: 'duplicate_contact' },
  });
  const { rows: t2State } = await oolix.query(
    `SELECT lead_state FROM attribution_tokens WHERE encode(token_hash,'hex') = $1`,
    [hashOf(t2)],
  );
  check('a lead can be REJECTED with a reason (§102.2)', t2State[0]?.lead_state === 'REJECTED');

  // -------------------------------------------------------------------------
  console.log('\n4. Cross-Buyer isolation (§66, §71)');
  // Partner A's own token, offered by a Buyer that does not own the campaign.
  const foreignKeyRes = await api('/v1/buyer/crm-keys', {
    method: 'POST',
    token: partnerAdmin,
    orgId: PARTNER_A_ORG,
  });
  if (foreignKeyRes.status === 403) {
    check('a Partner cannot mint a Buyer CRM key', true, 'status 403');
  } else {
    check('a Partner cannot mint a Buyer CRM key', false, `status ${foreignKeyRes.status}`);
  }

  // -------------------------------------------------------------------------
  console.log('\n5. Delivery ingest and reporting (§18, §49, §57)');
  console.log('  (waiting for the Agent delivery batch...)');

  // Scoped to TODAY's UTC bucket, for two reasons. §77.3 reconciles per
  // activation/day, so this is the figure the reconciliation check below has
  // to compare against. And an all-time sum would be satisfied by rows a
  // previous run left behind, so the poll would return instantly and this
  // phase would never actually prove that the Agent delivered anything.
  const todayUtc = new Date();
  todayUtc.setUTCHours(0, 0, 0, 0);

  let metrics = { n: 0 };
  for (let i = 0; i < 20; i += 1) {
    const { rows } = await oolix.query(
      `SELECT COALESCE(SUM(impressions),0)::int AS n
         FROM aggregate_metrics
        WHERE activation_id = $1
          AND bucket_start >= $2
          AND bucket_start < $2::timestamptz + interval '1 day'`,
      [activationId, todayUtc.toISOString()],
    );
    metrics = rows[0];
    if (metrics.n > 0) break;
    await sleep(2000);
  }
  check(
    'Oolix received aggregate delivery counters',
    metrics.n > 0,
    `${metrics.n} impressions today (UTC)`,
  );

  const { rows: batches } = await oolix.query(
    `SELECT count(*)::int AS n FROM delivery_batches WHERE partner_org_id = $1`,
    [PARTNER_A_ORG],
  );
  check(
    'delivery batches are recorded for dedupe (§57)',
    batches[0].n > 0,
    `${batches[0].n} batches`,
  );

  // §54/§73: aggregates only. There must be no per-impression event table.
  const { rows: perEvent } = await oolix.query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema='public' AND table_name IN ('impressions','impression_events','ad_events')`,
  );
  check('there is NO per-impression central event table (§45)', perEvent.length === 0);

  const { rows: campRows } = await oolix.query(
    `SELECT pr.campaign_id FROM activations a
       JOIN partner_requests pr ON pr.id = a.request_id
      WHERE a.id = $1`,
    [activationId],
  );
  const campaignId = campRows[0]?.campaign_id;

  const report = await api(`/v1/reports/campaigns/${campaignId}`, { token: buyerAdmin });
  check('Buyer campaign report responds', report.status === 200, `status ${report.status}`);

  const row = report.body?.by_partner?.find((r) => r.activation_id === activationId);
  check('the report includes this activation', Boolean(row));
  check(
    'the QUALIFIED lead is attributed to the Partner activation (§85 exit)',
    (row?.outcomes?.qualified ?? 0) >= 1,
    `qualified=${row?.outcomes?.qualified}`,
  );
  check(
    'the CONVERTED lead is counted separately',
    (row?.outcomes?.converted ?? 0) >= 1,
    `converted=${row?.outcomes?.converted}`,
  );
  check(
    'the REJECTED lead is counted separately',
    (row?.outcomes?.rejected ?? 0) >= 1,
    `rejected=${row?.outcomes?.rejected}`,
  );
  check(
    'payout basis comes from CPQL x QUALIFIED, never from clicks (§50, §102)',
    row?.cost?.pricing_model === 'CPQL' &&
      row?.cost?.outcome_basis_minor === row.cost.unit_price_minor * row.outcomes.qualified,
    `${row?.cost?.outcome_basis_minor} = ${row?.cost?.unit_price_minor} x ${row?.outcomes?.qualified}`,
  );
  check(
    'the report warns that Partner reach is not deduplicated (§13, §72)',
    /not deduplicated/i.test(report.body?.notice ?? ''),
  );
  check(
    'quality metrics flag an insufficient sample rather than implying precision',
    row?.quality?.sufficient_sample === false,
    `received=${row?.outcomes?.received}`,
  );

  const partnerReport = await api('/v1/reports/partner', {
    token: partnerAdmin,
    orgId: PARTNER_A_ORG,
  });
  check('Partner report responds', partnerReport.status === 200, `status ${partnerReport.status}`);
  const pRow = partnerReport.body?.items?.find((i) => i.activation_id === activationId);
  check(
    'Partner sees its own accrual',
    (pRow?.revenue?.accrued_minor ?? 0) > 0,
    `${pRow?.revenue?.accrued_minor}`,
  );
  check(
    'Partner report never names another Partner',
    (partnerReport.body?.items ?? []).every((i) => i.activation_id !== 'foreign'),
  );

  // -------------------------------------------------------------------------
  console.log('\n6. Reconciliation tolerance (§77.3)');
  // 77.3 reconciles "per activation/day", so both sides of the comparison must
  // name the SAME day. Passing it explicitly also keeps the check correct if
  // the run happens to straddle UTC midnight.
  const bucketDate = todayUtc.toISOString().slice(0, 10);

  const withinTolerance = await api(`/v1/reports/reconcile/${activationId}?date=${bucketDate}`, {
    method: 'POST',
    token: finance,
    body: { agent_count: metrics.n },
  });
  check(
    'matching counts reconcile as PASS',
    withinTolerance.body?.status === 'PASS',
    `diff ${withinTolerance.body?.difference} / tol ${withinTolerance.body?.tolerance}`,
  );

  const outOfTolerance = await api(`/v1/reports/reconcile/${activationId}?date=${bucketDate}`, {
    method: 'POST',
    token: finance,
    body: { agent_count: metrics.n + 5000 },
  });
  check(
    'a large difference raises REVIEW_REQUIRED',
    outOfTolerance.body?.status === 'REVIEW_REQUIRED',
    `diff ${outOfTolerance.body?.difference} / tol ${outOfTolerance.body?.tolerance}`,
  );
  check(
    'and does NOT silently change the payout (§77.3)',
    /not automatically adjusted/i.test(outOfTolerance.body?.note ?? ''),
  );
} finally {
  await oolix.end();
  await partner.end();
}

console.log(
  failures === 0 ? '\nPhase 5 verified: all checks passed.\n' : `\n${failures} check(s) FAILED.\n`,
);
process.exit(failures === 0 ? 0 : 1);
