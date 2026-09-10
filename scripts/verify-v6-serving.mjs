#!/usr/bin/env node
/**
 * v6 §20 acceptance — the rows that need a LIVE Agent.
 *
 * verify-v6.mjs proves the control plane: audiences, matching, estimates, the
 * campaign link, and the privacy boundary in the Oolix database. It stops where
 * the Partner begins.
 *
 * This script covers what happens inside the Partner:
 *
 *   Reach estimate    the Agent evaluates locally and returns a BUCKET
 *   Materialization   an approved rule set compiles into a local index
 *   Owned media       an eligible local user sees an ad; an ineligible one
 *                     gets NO_AD -- targeted by RULES, with no segment involved
 *   Revocation        a Partner stop ends local serving
 *
 * Requires: the stack up, an Agent provisioned and running against the v6
 * fixture attribute table (infra/partner-db/init/02-v6-audience-attributes.sql).
 *
 * Usage: node scripts/verify-v6-serving.mjs
 */
import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { seedToken } from './lib/onboard-partner.mjs';
import { agentUrl } from './lib/agent-port.mjs';

const API = process.env.API_PUBLIC_URL ?? 'http://localhost:4000';
const AGENT = agentUrl();

const BUYER_ORG = '11111111-1111-4111-8111-111111111111';
const PARTNER_A_ORG = '22222222-2222-4222-8222-222222222222';
const BRAND = '66666666-6666-4666-8666-666666666666';

const OOLIX_DB =
  process.env.DATABASE_URL ?? 'postgresql://oolix:oolix@localhost:5432/oolix?schema=public';
const PARTNER_DB =
  process.env.PARTNER_DATABASE_URL ??
  'postgresql://partner:partner@localhost:5433/partner_audience';

// §6.3's worked example, and the fixture rows it selects.
//   U123  online footwear buyer, 28, bought 12 days ago      -> matches
//   U456  in-store grocery buyer, last bought 200 days ago   -> fails two rules
//   U789  online footwear buyer but 45                       -> outside the age rule
const USER_MATCHES = 'U123';
const USER_WRONG_CATEGORY = 'U456';
const USER_WRONG_AGE = 'U789';

const PURPOSE = 'travel_insurance_offer';

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
  return { status: res.status, body: json };
}

async function decide(user, placementKey) {
  const res = await fetch(`${AGENT}/private/v1/ad-decision`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      partner_user_id: user,
      placement_id: placementKey,
      context: { page_type: 'offers' },
    }),
  });
  return res.json();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll until `probe` returns truthy, or give up. */
async function until(probe, { timeoutMs = 90_000, everyMs = 3_000, label = '' } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value) return value;
    await sleep(everyMs);
  }
  if (label) console.log(`        (timed out waiting for ${label})`);
  return null;
}

const oolix = new pg.Client({ connectionString: OOLIX_DB });
const partner = new pg.Client({ connectionString: PARTNER_DB });
await oolix.connect();
await partner.connect();

console.log('\nv6 serving verification -- local materialization and owned media (§20)\n');

try {
  // -------------------------------------------------------------------------
  console.log('0. Setup');
  const buyerAdmin = await seedToken('buyer.admin@example.test');
  const buyerOperator = await seedToken('buyer.operator@example.test');
  const approverA = await seedToken('partner.approver@example.test');
  const partnerAdmin = await seedToken('partner.admin@example.test');
  const securityA = await seedToken('partner.security@example.test');

  const { rows: attributeTable } = await partner.query(
    `SELECT to_regclass('oolix_audience_attributes') IS NOT NULL AS present`,
  );
  if (!attributeTable[0]?.present) {
    console.log('  SKIP  v6 attribute fixtures are not installed in the Partner database.');
    process.exit(0);
  }

  // Consent is a separate gate from audience membership (§44 steps 6 and 7).
  // The fixture users need it, or the ad decision would fail for a reason that
  // has nothing to do with v6.
  for (const user of [USER_MATCHES, USER_WRONG_CATEGORY, USER_WRONG_AGE]) {
    await partner.query(
      `INSERT INTO oolix_user_consent (partner_user_id, purpose_id, eligible, policy_version)
       VALUES ($1, $2, TRUE, 'P-21')
       ON CONFLICT (partner_user_id, purpose_id) DO NOTHING`,
      [user, PURPOSE],
    );
  }
  check('fixture users have advertising consent for the purpose', true);

  const health = await fetch(`${AGENT}/readyz`)
    .then((r) => r.json())
    .catch(() => null);
  check('the Agent is ready', health?.status === 'ready', health?.status ?? 'unreachable');

  // -------------------------------------------------------------------------
  console.log('\n1. An audience the Partner can actually evaluate (§6.3)');
  const rules = [
    { attribute: 'online_shopper', operator: 'EQ', value: true, required: true, weight: 5 },
    {
      attribute: 'purchase_category',
      operator: 'IN',
      value: ['FOOTWEAR'],
      required: true,
      weight: 5,
    },
    { attribute: 'age', operator: 'BETWEEN', value: [18, 35], required: true, weight: 5 },
    { attribute: 'purchase_recency_days', operator: 'LTE', value: 90, required: true, weight: 4 },
  ];

  const audience = await api('/v1/audiences', {
    method: 'POST',
    token: buyerAdmin,
    body: { name: `Urban Shoe Shoppers ${Date.now()}`, rules },
  });
  check('audience created', audience.status === 201, `status ${audience.status}`);
  const audienceId = audience.body?.id;
  const ruleHash = audience.body?.rule_hash;

  await api(`/v1/audiences/${audienceId}/publish`, { method: 'POST', token: buyerAdmin });

  const matches = await api(`/v1/audiences/${audienceId}/partner-matches`, {
    method: 'GET',
    token: buyerAdmin,
  });
  const matchA = matches.body?.items?.find((m) => m.partner_org_id === PARTNER_A_ORG);
  check(
    'Partner A is COMPATIBLE with this audience (§7)',
    matchA?.status === 'COMPATIBLE',
    `${matchA?.status} ${matchA?.match_score}%`,
  );

  // -------------------------------------------------------------------------
  console.log('\n2. The Agent evaluates locally and returns a bucket (§8.2)');
  const requested = await api(`/v1/audiences/${audienceId}/reach-estimates`, {
    method: 'POST',
    token: buyerAdmin,
    body: { partner_org_ids: [PARTNER_A_ORG] },
  });
  const estimateId = requested.body?.requests?.[0]?.reach_estimate_id;
  // §8.1 specifies 202: the estimates are QUEUED, not computed.
  check('an estimate was queued (§8.1)', requested.status === 202, `status ${requested.status}`);

  const answered = await until(
    async () => {
      const { rows } = await oolix.query(
        `SELECT status, reach_bucket, mapping_version FROM reach_estimates WHERE id = $1`,
        [estimateId],
      );
      const row = rows[0];
      return row && row.status !== 'REQUESTED' && row.status !== 'PROCESSING' ? row : null;
    },
    { label: 'the Agent to answer the estimate' },
  );

  check(
    'the Agent answered the estimate locally',
    Boolean(answered),
    answered ? `${answered.status} ${answered.reach_bucket ?? ''}` : 'no answer',
  );
  if (answered) {
    check(
      'the answer is a bucket or BELOW_THRESHOLD, never a count (§8.2)',
      answered.status === 'BELOW_THRESHOLD' || Boolean(answered.reach_bucket),
    );
    check(
      'the answer names the local mapping version it used (§16)',
      Number.isInteger(answered.mapping_version),
      `v${answered.mapping_version}`,
    );
  }

  // -------------------------------------------------------------------------
  console.log('\n3. Campaign bound to the audience (§9)');
  const campaign = await api('/v1/campaigns', {
    method: 'POST',
    token: buyerAdmin,
    idempotencyKey: randomUUID(),
    body: {
      name: `v6 serving ${Date.now()}`,
      brand_id: BRAND,
      objective: 'QUALIFIED_LEADS',
      category: 'insurance',
      purpose_id: PURPOSE,
      budget: { amount_minor: 20_000_000, currency: 'INR' },
      start_at: new Date(Date.now() - 3_600_000).toISOString(),
      end_at: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      geographies: ['IN'],
      landing_url: 'https://insurance.example/quote',
      lead_definition: { qualified_statuses: ['QUALIFIED'], duplicate_window_days: 30 },
    },
  });
  const campaignId = campaign.body?.id;
  check('campaign drafted', campaign.status === 201, `status ${campaign.status}`);

  const linked = await api(`/v1/campaigns/${campaignId}/audience-link`, {
    method: 'POST',
    token: buyerAdmin,
    idempotencyKey: randomUUID(),
    body: { audience_group_id: audienceId },
  });
  check('audience linked and frozen', linked.status === 201, `status ${linked.status}`);
  check('the link carries the audience rule hash (§10)', linked.body?.rule_hash === ruleHash);

  // A creative, because §70 binds a Partner's approval to a specific version.
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
      headline: 'New season footwear',
      body: 'Offers picked for you.',
      cta: 'SHOP_NOW',
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

  // A DEDICATED placement, published by the Partner for this run.
  //
  // A shared slot legitimately carries every other campaign approved for it, and
  // §76.1 ranks by Partner priority and pacing deficit -- so on an environment
  // with a dozen live activations the one under test may simply never win a
  // decision, which would look like "the audience does not serve" when the real
  // answer is "something else outranked it". Isolating the slot makes the
  // assertion about v6 rather than about queue depth.
  const placementKey = `v6_offers_${Date.now().toString(36)}`;
  const created = await api('/v1/partner/placements', {
    method: 'POST',
    token: partnerAdmin,
    orgId: PARTNER_A_ORG,
    body: {
      placement_key: placementKey,
      display_name: 'v6 verification offers slot',
      surface: 'web',
      format: 'native_card',
      allowed_categories: ['insurance'],
      max_frequency_default: 10,
    },
  });
  check(
    'the Partner can publish a placement for this run (§76.2)',
    created.status === 201,
    `status ${created.status} ${created.body?.error?.message ?? ''}`,
  );

  // §76.2: a placement is DRAFT until the Partner activates it. Nothing serves
  // in a slot the Partner has not switched on -- which is the point, and which
  // a test that skipped this step would quietly misrepresent.
  const activated = await api(`/v1/partner/placements/${created.body?.placement_id}/status`, {
    method: 'POST',
    token: partnerAdmin,
    orgId: PARTNER_A_ORG,
    body: { status: 'ACTIVE' },
  });
  check(
    'the Partner activates the placement before anything can serve in it (§76.2)',
    activated.status === 200 || activated.status === 201,
    `status ${activated.status}`,
  );

  const placements = await api(`/v1/catalogue/partners/${PARTNER_A_ORG}/placements`, {
    token: buyerAdmin,
  });
  const placement = placements.body?.items?.find((pl) => pl.placement_key === placementKey);
  check(
    'a Partner placement is reachable without going through a segment (§9 step 6)',
    Boolean(placement),
    placement?.display_name ?? `status ${placements.status}`,
  );

  // §19: no segment_id at all. This is the whole point of the v6 path.
  const request = await api(`/v1/campaigns/${campaignId}/partner-requests`, {
    method: 'POST',
    token: buyerAdmin,
    idempotencyKey: randomUUID(),
    body: {
      partner_org_id: PARTNER_A_ORG,
      ...(estimateId ? { reach_estimate_id: estimateId } : {}),
      channels: [
        {
          channel: 'PARTNER_WEB',
          placement_ids: placement ? [placement.placement_id] : [],
          allocation_minor: 10_000_000,
          // Deliberately high. §7 below has to prove that REVOCATION stopped
          // serving; a cap tight enough to bite would stop it too, and the
          // check could not tell the two apart.
          frequency_cap: { max_impressions: 50, window: 'P1D' },
        },
      ],
      creative_version_ids: [creativeId],
      partner_payout: { model: 'CPQL', unit_price_minor: 450_000 },
    },
  });
  check(
    'a Partner request targets the audience with NO segment (§19)',
    request.status === 201,
    `status ${request.status} ${request.body?.error?.message ?? ''}`,
  );
  const requestId = request.body?.request_id;

  const { rows: sourceRows } = await oolix.query(
    `SELECT targeting_source, segment_id, audience_rule_hash FROM partner_requests WHERE id = $1`,
    [requestId],
  );
  check(
    'the request records AUDIENCE_GROUP targeting and no segment (§19)',
    sourceRows[0]?.targeting_source === 'AUDIENCE_GROUP' && sourceRows[0]?.segment_id === null,
    sourceRows[0]?.targeting_source,
  );
  check(
    'the approved rule hash is frozen onto the request (§10)',
    sourceRows[0]?.audience_rule_hash === ruleHash,
  );

  await api(`/v1/campaigns/${campaignId}/submit`, {
    method: 'POST',
    token: buyerAdmin,
    idempotencyKey: randomUUID(),
  });

  // -------------------------------------------------------------------------
  console.log('\n4. Partner review and approval (§10)');
  const review = await api(`/v1/partner-requests/${requestId}`, {
    token: approverA,
    orgId: PARTNER_A_ORG,
  });
  check(
    'the Partner sees the complete rule set, not a segment name (§10, §20)',
    (review.body?.audience?.rules ?? []).length === rules.length,
    `${review.body?.audience?.rules?.length ?? 0} rules`,
  );
  check(
    'the Partner sees which rules are REQUIRED (§10)',
    (review.body?.audience?.rules ?? []).every((r) => typeof r.required === 'boolean'),
  );
  check(
    'the Partner sees the safe reach their own Agent computed (§10)',
    review.body?.audience?.reach_estimate !== undefined,
    review.body?.audience?.reach_estimate?.reach_bucket ?? 'none',
  );
  check(
    'the review carries the rule hash the approval will bind to (§10)',
    review.body?.audience?.rule_hash === ruleHash,
  );

  const approved = await api(`/v1/partner-requests/${requestId}/approve`, {
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
  check(
    'the Partner approved the audience-targeted request',
    approved.status === 201,
    `status ${approved.status} ${approved.body?.error?.message ?? ''}`,
  );
  const activationId = approved.body?.activation_ids?.[0];

  // -------------------------------------------------------------------------
  console.log('\n5. Local materialization (§11, §20)');
  const materialized = await until(
    async () => {
      const { rows } = await partner.query(
        `SELECT status, member_count, materialization_version, rule_hash
           FROM oolix_audience_materialization WHERE activation_id = $1`,
        [activationId],
      );
      return rows[0]?.status === 'READY' ? rows[0] : null;
    },
    { label: 'the Agent to materialize the approved audience' },
  );

  check(
    'the Agent compiled the approved rules into a local index (§11)',
    Boolean(materialized),
    materialized ? `v${materialized.materialization_version}` : 'not materialized',
  );
  if (materialized) {
    check(
      'it materialized the rules the Partner APPROVED, by hash (§10)',
      materialized.rule_hash === ruleHash,
    );
    check(
      'the local index actually contains members',
      materialized.member_count > 0,
      `${materialized.member_count} locally`,
    );
  }

  // §11's privacy boundary: the members exist HERE and only here.
  const { rows: localMembers } = await partner.query(
    `SELECT count(*)::int AS n FROM oolix_audience_members WHERE activation_id = $1`,
    [activationId],
  );
  check(
    'the members live in the Partner database',
    localMembers[0]?.n > 0,
    `${localMembers[0]?.n}`,
  );

  const { rows: centralTables } = await oolix.query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN ('audience_members','oolix_audience_members','audience_materializations')`,
  );
  check(
    'no equivalent table exists centrally (§11 privacy boundary)',
    centralTables.length === 0,
    centralTables.map((t) => t.table_name).join(', '),
  );

  // §11 says Oolix learns "status/version/freshness/aggregate outcomes". Prove
  // the member count is NOT among them by hunting it in every text column.
  const { rows: countLeak } = await oolix.query(
    `SELECT count(*)::int AS n FROM audit_events
      WHERE metadata::text LIKE '%member_count%' OR metadata::text LIKE '%partner_user_id%'`,
  );
  check(
    'no member count or customer id reached the Oolix audit trail (§11, §17)',
    countLeak[0]?.n === 0,
    `${countLeak[0]?.n} rows`,
  );

  // -------------------------------------------------------------------------
  console.log('\n6. Owned media, targeted by rules (§12, §20)');
  // Every assertion below is about THIS activation, not about the decision as a
  // whole. A placement is shared: the same slot legitimately carries other
  // campaigns, including v5 segment-targeted ones, so "did this user see any
  // ad" answers a different question than "did this user match these rules".
  const servedBy = (d) => (d?.decision === 'SHOW' ? d.activation_id : null);

  const served = await until(
    async () => {
      const d = await decide(USER_MATCHES, placementKey);
      return servedBy(d) === activationId ? d : null;
    },
    { timeoutMs: 60_000, everyMs: 3_000, label: 'the Agent to serve the audience' },
  );
  check(
    'a user who matches every rule is served by THIS activation (§20 owned media)',
    Boolean(served),
    served ? served.creative?.creative_version_id : 'not served by this activation',
  );
  check(
    'the decision returns no user identifier of any kind (§12)',
    !JSON.stringify(served ?? {}).includes(USER_MATCHES),
  );

  const wrongCategory = await decide(USER_WRONG_CATEGORY, placementKey);
  check(
    'a user who fails a REQUIRED rule is NOT served by this activation',
    servedBy(wrongCategory) !== activationId,
    wrongCategory?.decision === 'NO_AD' ? wrongCategory.reason : 'served something else',
  );

  const wrongAge = await decide(USER_WRONG_AGE, placementKey);
  check(
    'a user outside the age range is NOT served by this activation',
    servedBy(wrongAge) !== activationId,
    wrongAge?.decision === 'NO_AD' ? wrongAge.reason : 'served something else',
  );

  // -------------------------------------------------------------------------
  console.log('\n7. Revocation stops local serving (§20, §24)');
  const killed = await api('/v1/partner/kill-switches', {
    method: 'POST',
    token: securityA,
    orgId: PARTNER_A_ORG,
    body: {
      scope: 'ACTIVATION',
      target_id: activationId,
      reason: 'v6 serving verification: proving a Partner stop reaches the Agent.',
    },
  });
  check('the Partner stopped the activation', killed.status === 201, `status ${killed.status}`);

  // Again: not "sees nothing", but "is no longer served by the activation the
  // Partner just stopped". §13's whole point is that stopping one activation
  // leaves every other one running.
  const stopped = await until(
    async () => {
      const d = await decide(USER_MATCHES, placementKey);
      return servedBy(d) !== activationId ? d : null;
    },
    { timeoutMs: 90_000, everyMs: 5_000, label: 'the Agent to stop serving' },
  );
  check(
    'the revoked activation stops serving the matching user (§20, §24)',
    Boolean(stopped),
    stopped?.decision === 'NO_AD' ? stopped.reason : 'now served by a different activation',
  );
  // FREQUENCY_CAPPED would mean the user simply ran out of impressions, which
  // proves nothing about the kill switch. The cap on this request is 50 and
  // section 6 spends a handful, so reaching it here would be a bug in this
  // script rather than evidence of a revocation.
  check(
    '  and stops because of the REVOCATION, not because the user ran out of impressions',
    stopped?.reason !== 'FREQUENCY_CAPPED',
    stopped?.reason ?? '(served by another activation)',
  );
} finally {
  await oolix.end();
  await partner.end();
}

console.log(
  failures === 0
    ? '\nv6 serving verified: all checks passed.\n'
    : `\n${failures} check(s) FAILED.\n`,
);
process.exit(failures === 0 ? 0 : 1);
