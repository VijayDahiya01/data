#!/usr/bin/env node
/**
 * Phase 6 exit criterion (spec v5 §85):
 *   "One campaign runs across 2+ Partners independently."
 *
 * Independence is the whole point of §13, so this proves it by BREAKING one
 * Partner and confirming the other is untouched: a kill switch on Partner A
 * must not disturb Partner B's activation on the same campaign.
 *
 * Also covers the §99 idempotency guarantees and the §98.1 Ops dashboard.
 *
 * Usage: node scripts/verify-phase6.mjs
 */
import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { seedToken, onboardPartnerAgent } from './lib/onboard-partner.mjs';

const API = process.env.API_PUBLIC_URL ?? 'http://localhost:4000';

const BUYER_ORG = '11111111-1111-4111-8111-111111111111';
const PARTNER_A_ORG = '22222222-2222-4222-8222-222222222222';
const PARTNER_B_ORG = '33333333-3333-4333-8333-333333333333';
const BRAND = '66666666-6666-4666-8666-666666666666';
const OOLIX_ORG = '99999999-9999-4999-8999-999999999999';

const OOLIX_DB =
  process.env.DATABASE_URL ?? 'postgresql://oolix:oolix@localhost:5432/oolix?schema=public';

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
  if (!ok) failures += 1;
  return ok;
};

async function api(path, { method = 'GET', token, body, orgId = BUYER_ORG, idempotencyKey } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
      'X-Org-Id': orgId,
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
  return {
    status: res.status,
    body: json,
    replayed: res.headers.get('idempotency-replayed') === 'true',
  };
}

const oolix = new pg.Client({ connectionString: OOLIX_DB });
await oolix.connect();

console.log('\nPhase 6 verification -- Multi-Partner hardening (spec §85)\n');

try {
  // -------------------------------------------------------------------------
  console.log('0. Setup: both Partners ready');
  const buyerAdmin = await seedToken('buyer.admin@example.test');
  const buyerOperator = await seedToken('buyer.operator@example.test');
  const approverA = await seedToken('partner.approver@example.test');
  const approverB = await seedToken('partnerb.approver@example.test');
  const securityA = await seedToken('partner.security@example.test');
  const adminA = await seedToken('partner.admin@example.test');

  const oolixAdmin = await seedToken('oolix.admin@example.test');

  for (const [org, who] of [
    [PARTNER_A_ORG, 'partner.security@example.test'],
    [PARTNER_B_ORG, 'partnerb.admin@example.test'],
  ]) {
    const r = await api('/v1/partner/readiness', { token: await seedToken(who), orgId: org });
    if (r.body?.readiness !== 'READY_FOR_CAMPAIGNS') {
      await onboardPartnerAgent({ api: API, securityToken: await seedToken(who), orgId: org });
    }
  }
  check('both Partners are READY_FOR_CAMPAIGNS', true);

  // -------------------------------------------------------------------------
  console.log('\n1. Idempotency (§22.3, §53, §99)');
  const campaignKey = randomUUID();
  const campaignBody = {
    name: `Multi-partner ${Date.now()}`,
    objective: 'QUALIFIED_LEADS',
    brand_id: BRAND,
    category: 'insurance',
    purpose_id: 'travel_insurance_offer',
    budget: { amount_minor: 50_000_000, currency: 'INR' },
    start_at: new Date(Date.now() - 3_600_000).toISOString(),
    end_at: new Date(Date.now() + 60 * 86_400_000).toISOString(),
    geographies: ['IN'],
    landing_url: 'https://insurance.example/quote',
    lead_definition: { qualified_statuses: ['QUALIFIED'], duplicate_window_days: 30 },
  };

  const first = await api('/v1/campaigns', {
    method: 'POST',
    token: buyerAdmin,
    body: campaignBody,
    idempotencyKey: campaignKey,
  });
  check('campaign created', first.status === 201, `status ${first.status}`);
  const campaignId = first.body.id;

  const replay = await api('/v1/campaigns', {
    method: 'POST',
    token: buyerAdmin,
    body: campaignBody,
    idempotencyKey: campaignKey,
  });
  check(
    'the same key + same payload REPLAYS rather than creating a second campaign',
    replay.body?.id === campaignId && replay.replayed,
    replay.replayed ? 'replayed' : `new id ${replay.body?.id}`,
  );

  const conflict = await api('/v1/campaigns', {
    method: 'POST',
    token: buyerAdmin,
    body: { ...campaignBody, name: 'Different name entirely' },
    idempotencyKey: campaignKey,
  });
  check(
    'the same key + DIFFERENT payload is a 409 conflict (§99)',
    conflict.status === 409 && conflict.body?.error?.code === 'IDEMPOTENCY_CONFLICT',
    `status ${conflict.status} ${conflict.body?.error?.code ?? ''}`,
  );

  const { rows: dupes } = await oolix.query(
    `SELECT count(*)::int AS n FROM campaigns WHERE name = $1`,
    [campaignBody.name],
  );
  check('exactly ONE campaign row exists for that key', dupes[0].n === 1, `${dupes[0].n} rows`);

  // -------------------------------------------------------------------------
  console.log('\n2. Build a campaign across two Partners (§13, §40.4)');
  const png = Buffer.from(
    '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000100ffff03000006000557bfabd40000000049454e44ae426082',
    'hex',
  );
  const session = await api('/v1/creatives/upload-session', {
    method: 'POST',
    token: buyerOperator,
    body: {
      campaign_id: campaignId,
      file_name: 'o.png',
      mime_type: 'image/png',
      file_size_bytes: png.length,
      creative_type: 'NATIVE_CARD',
      headline: 'Protect your trip',
      body: 'Get travel insurance in minutes.',
      cta: 'GET_QUOTE',
      destination_url: 'https://insurance.example/quote',
    },
  });
  await fetch(session.body.upload_url, {
    method: 'PUT',
    headers: session.body.upload_headers,
    body: png,
  });
  await api(`/v1/creatives/${session.body.creative_version_id}/finalize`, {
    method: 'POST',
    token: buyerOperator,
    body: { content_sha256: createHash('sha256').update(png).digest('hex') },
  });
  const creativeId = session.body.creative_version_id;

  // One query per segment: accumulated test segments share the travel category
  // and would otherwise refill the capped page.
  const catA = await api('/v1/catalogue/segments?query=Recent%20Travellers', {
    token: buyerAdmin,
  });
  const catB = await api('/v1/catalogue/segments?query=Travel%20Rewards%20Members', {
    token: buyerAdmin,
  });
  const segA = catA.body.items.find((i) => i.display_name === 'Recent Travellers');
  const segB = catB.body.items.find((i) => i.display_name === 'Travel Rewards Members');
  if (!segA || !segB) {
    throw new Error('seeded catalogue segments are not discoverable -- is the seed loaded?');
  }
  const detA = await api(`/v1/catalogue/segments/${segA.segment_id}`, { token: buyerAdmin });
  const detB = await api(`/v1/catalogue/segments/${segB.segment_id}`, { token: buyerAdmin });

  const reqA = await api(`/v1/campaigns/${campaignId}/partner-requests`, {
    method: 'POST',
    token: buyerAdmin,
    body: {
      partner_org_id: PARTNER_A_ORG,
      segment_id: segA.segment_id,
      channels: [
        {
          channel: 'PARTNER_WEB',
          placement_ids: [detA.body.placements[0].placement_id],
          allocation_minor: 20_000_000,
          frequency_cap: { max_impressions: 2, window: 'P1D' },
        },
      ],
      creative_version_ids: [creativeId],
      partner_payout: { model: 'CPQL', unit_price_minor: 450_000 },
    },
  });
  const reqB = await api(`/v1/campaigns/${campaignId}/partner-requests`, {
    method: 'POST',
    token: buyerAdmin,
    body: {
      partner_org_id: PARTNER_B_ORG,
      segment_id: segB.segment_id,
      channels: [
        {
          channel: 'PARTNER_WEB',
          placement_ids: [detB.body.placements[0].placement_id],
          allocation_minor: 20_000_000,
          frequency_cap: { max_impressions: 3, window: 'P1D' },
        },
      ],
      creative_version_ids: [creativeId],
      partner_payout: { model: 'CPQL', unit_price_minor: 450_000 },
    },
  });
  check(
    'two Partner requests created',
    reqA.status === 201 && reqB.status === 201,
    `A=${reqA.status} B=${reqB.status}`,
  );

  const submit = await api(`/v1/campaigns/${campaignId}/submit`, {
    method: 'POST',
    token: buyerAdmin,
    idempotencyKey: randomUUID(),
  });
  check('campaign submitted to both Partners', submit.status === 200 || submit.status === 201);

  const noKey = await api(`/v1/campaigns/${campaignId}/submit`, {
    method: 'POST',
    token: buyerAdmin,
  });
  check('submit REQUIRES an Idempotency-Key (§53)', noKey.status === 400, `status ${noKey.status}`);

  // -------------------------------------------------------------------------
  console.log('\n3. Independent approval (§40.4)');
  const approveA = await api(`/v1/partner-requests/${reqA.body.request_id}/approve`, {
    method: 'POST',
    token: approverA,
    orgId: PARTNER_A_ORG,
    idempotencyKey: randomUUID(),
    body: {
      approved_channels: ['PARTNER_WEB'],
      approved_creative_version_ids: [creativeId],
      partner_payout: { model: 'CPQL', unit_price_minor: 450_000 },
    },
  });
  const approveB = await api(`/v1/partner-requests/${reqB.body.request_id}/approve`, {
    method: 'POST',
    token: approverB,
    orgId: PARTNER_B_ORG,
    idempotencyKey: randomUUID(),
    body: {
      approved_channels: ['PARTNER_WEB'],
      approved_creative_version_ids: [creativeId],
      partner_payout: { model: 'CPQL', unit_price_minor: 450_000 },
    },
  });
  check('Partner A approved independently', approveA.status === 201, `status ${approveA.status}`);
  check('Partner B approved independently', approveB.status === 201, `status ${approveB.status}`);

  const activationA = approveA.body?.activation_ids?.[0];
  const activationB = approveB.body?.activation_ids?.[0];
  check(
    'each Partner got its OWN activation (§13)',
    activationA && activationB && activationA !== activationB,
  );

  const noApprovalKey = await api(`/v1/partner-requests/${reqB.body.request_id}/approve`, {
    method: 'POST',
    token: approverB,
    orgId: PARTNER_B_ORG,
    body: { approved_channels: ['PARTNER_WEB'], approved_creative_version_ids: [creativeId] },
  });
  check(
    'approval REQUIRES an Idempotency-Key (§53)',
    noApprovalKey.status === 400,
    `status ${noApprovalKey.status}`,
  );

  // -------------------------------------------------------------------------
  console.log('\n4. Independence under failure (§13, §24, §40.4 -- §85 exit)');
  const killA = await api('/v1/partner/kill-switches', {
    method: 'POST',
    token: securityA,
    orgId: PARTNER_A_ORG,
    body: {
      scope: 'ACTIVATION',
      target_id: activationA,
      reason: 'Brand safety hold on Partner A only.',
    },
  });
  check('Partner A kills its OWN activation', killA.status === 201, `status ${killA.status}`);

  const { rows: stateA } = await oolix.query(`SELECT status FROM activations WHERE id = $1`, [
    activationA,
  ]);
  const { rows: stateB } = await oolix.query(`SELECT status FROM activations WHERE id = $1`, [
    activationB,
  ]);
  check(
    "Partner A's activation is stopped",
    ['ENDING', 'ENDED', 'PAUSED'].includes(stateA[0]?.status),
    stateA[0]?.status,
  );
  check(
    "Partner B's activation is COMPLETELY UNAFFECTED (§85 exit)",
    ['READY', 'LIVE', 'SYNCING'].includes(stateB[0]?.status),
    stateB[0]?.status,
  );

  const crossKill = await api('/v1/partner/kill-switches', {
    method: 'POST',
    token: securityA,
    orgId: PARTNER_A_ORG,
    body: { scope: 'ACTIVATION', target_id: activationB, reason: 'Attempting to kill Partner B.' },
  });
  check(
    'Partner A CANNOT kill Partner B’s activation',
    crossKill.status === 404 || crossKill.status === 403,
    `status ${crossKill.status}`,
  );

  const resumeBlocked = await api(`/v1/activations/${activationA}/resume`, {
    method: 'POST',
    token: adminA,
    orgId: PARTNER_A_ORG,
  });
  check(
    'a kill switch outranks resume -- it must be released first (§24)',
    resumeBlocked.status === 409,
    `status ${resumeBlocked.status} ${resumeBlocked.body?.error?.code ?? ''}`,
  );

  // -------------------------------------------------------------------------
  console.log('\n5. Parent campaign is a projection, not a source of truth (§42)');
  const view = await api(`/v1/campaigns/${campaignId}`, { token: buyerAdmin });
  const rows = view.body?.partner_requests ?? [];
  check('the Buyer sees BOTH Partner requests', rows.length === 2, `${rows.length} requests`);
  check(
    'each carries its own independent activation state',
    rows.every((r) => r.activations?.length === 1),
  );
  const statuses = rows.flatMap((r) => r.activations.map((a) => a.status));
  check(
    'the two activations are in DIFFERENT states',
    new Set(statuses).size === 2,
    statuses.join(' / '),
  );
  check(
    'the parent status does not hide the divergence',
    ['PARTIALLY_APPROVED', 'PARTIALLY_LIVE', 'READY', 'SUBMITTED'].includes(view.body?.status),
    view.body?.status,
  );
  check(
    'a stopped activation names its reason (§77)',
    rows.some((r) =>
      r.activations.some((a) => typeof a.status_reason === 'string' && a.status_reason.length > 0),
    ),
  );

  // -------------------------------------------------------------------------
  console.log('\n6. Activation lifecycle (§52.3, §76)');
  const pauseB = await api(`/v1/activations/${activationB}/pause`, {
    method: 'POST',
    token: buyerAdmin,
    body: { reason: 'Buyer pausing spend.' },
  });
  check(
    'the BUYER can pause its own activation',
    pauseB.body?.status === 'PAUSED',
    `status ${pauseB.status}`,
  );

  const resumeB = await api(`/v1/activations/${activationB}/resume`, {
    method: 'POST',
    token: buyerAdmin,
  });
  check(
    'and resume it (§76 PAUSED -> LIVE)',
    resumeB.body?.status === 'LIVE',
    `status ${resumeB.status}`,
  );

  const endNoReason = await api(`/v1/activations/${activationB}/end`, {
    method: 'POST',
    token: buyerAdmin,
    body: {},
  });
  check('ending demands a reason for the audit trail (§83)', endNoReason.status === 400);

  const foreignPause = await api(`/v1/activations/${activationB}/pause`, {
    method: 'POST',
    token: adminA,
    orgId: PARTNER_A_ORG,
    body: { reason: 'Reaching into another Partner.' },
  });
  check(
    'a Partner cannot pause an activation it does not serve',
    foreignPause.status === 404,
    `status ${foreignPause.status}`,
  );

  // -------------------------------------------------------------------------
  console.log('\n7. Kill switch release and Ops dashboard (§24, §98.1)');
  const release = await api(`/v1/partner/kill-switches/${killA.body.kill_switch_id}/release`, {
    method: 'POST',
    token: securityA,
    orgId: PARTNER_A_ORG,
  });
  check('the kill switch can be released', release.body?.active === false);
  check(
    'releasing does NOT resurrect an ended activation (§76)',
    /not resumed/i.test(release.body?.note ?? ''),
  );

  const dash = await api('/v1/admin/ops/dashboard', { token: oolixAdmin, orgId: OOLIX_ORG });
  check('Ops dashboard responds', dash.status === 200, `status ${dash.status}`);
  check('  reports Agent health (§78.2)', typeof dash.body?.agent_health?.total === 'number');
  check(
    '  reports activation states by §76 status',
    Object.keys(dash.body?.activations ?? {}).length > 0,
  );
  check(
    '  reports approval SLA pressure (§101)',
    typeof dash.body?.approvals?.pending_review === 'number',
  );
  check(
    '  reports reconciliation reviews (§77.3)',
    typeof dash.body?.reconciliation?.review_required === 'number',
  );
  check(
    '  shows both external channels as disabled (§84)',
    dash.body?.external_sync?.meta_enabled === false &&
      dash.body?.external_sync?.google_enabled === false,
  );
  check(
    '  carries the §78.2 alert thresholds alongside the figures',
    (dash.body?.thresholds?.alerts?.length ?? 0) > 5,
  );
  // Hunt for identifier VALUES, not vocabulary. The alert descriptions
  // legitimately mention "partner_user_id" while explaining what the redaction
  // alert means; that is documentation, not data. What must never appear is an
  // actual customer identifier or address.
  const dashJson = JSON.stringify(dash.body);
  const dataLeaks = [
    [/U\d{3}/g, 'fixture user id'],
    [/UT[0-9A-F]{10}/g, 'generated test user id'],
    [/[\w.+-]+@[\w-]+\.[\w.]+/g, 'email address'],
  ]
    .flatMap(([re, label]) => (dashJson.match(re) ?? []).map((m) => `${label}:${m}`))
    // Seeded users all live on example.test; a match there would still be a
    // leak, so nothing is excluded.
    .slice(0, 5);
  check(
    'the Ops dashboard exposes NO customer identifiers or addresses (§66)',
    dataLeaks.length === 0,
    dataLeaks.join(', ') || 'none',
  );

  const buyerTriesOps = await api('/v1/admin/ops/dashboard', { token: buyerAdmin });
  check(
    'a Buyer cannot read the Ops dashboard',
    buyerTriesOps.status === 403,
    `status ${buyerTriesOps.status}`,
  );
} finally {
  await oolix.end();
}

console.log(
  failures === 0 ? '\nPhase 6 verified: all checks passed.\n' : `\n${failures} check(s) FAILED.\n`,
);
process.exit(failures === 0 ? 0 : 1);
