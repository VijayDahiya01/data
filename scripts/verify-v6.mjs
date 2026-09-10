#!/usr/bin/env node
/**
 * v6 acceptance criteria (§20).
 *
 * Walks the new Buyer journey end to end against a live API: define an
 * audience, publish Partner capabilities, match them, and check the privacy
 * boundary holds at every step.
 *
 * The §20 table is the spec's own list of what "done" means for this change,
 * so each check below names the row it covers.
 *
 * Usage: node scripts/verify-v6.mjs
 */
import { createHash } from 'node:crypto';
import pg from 'pg';
import { seedToken } from './lib/onboard-partner.mjs';

const API = process.env.API_PUBLIC_URL ?? 'http://localhost:4000';

const BUYER_ORG = '11111111-1111-4111-8111-111111111111';
const PARTNER_A_ORG = '22222222-2222-4222-8222-222222222222';
const PARTNER_B_ORG = '33333333-3333-4333-8333-333333333333';

const OOLIX_DB =
  process.env.DATABASE_URL ?? 'postgresql://oolix:oolix@localhost:5432/oolix?schema=public';

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
  if (!ok) failures += 1;
  return ok;
};

async function api(path, { method = 'GET', token, body, orgId } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(orgId ? { 'X-Org-Id': orgId } : {}),
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

const db = new pg.Client({ connectionString: OOLIX_DB });
await db.connect();

console.log('\nv6 verification -- Audience Builder and Partner matching (§20)\n');

try {
  // -------------------------------------------------------------------------
  console.log('0. Setup');
  const buyer = await seedToken('buyer.admin@example.test');
  const partnerA = await seedToken('partner.admin@example.test');
  const partnerB = await seedToken('partnerb.admin@example.test');
  check('signed in as Buyer and both Partners', true);

  // -------------------------------------------------------------------------
  console.log('\n1. Attribute taxonomy (§4)');
  const taxonomy = await api('/v1/audiences/taxonomy', { token: buyer, orgId: BUYER_ORG });
  const attributes = taxonomy.body?.items ?? [];
  check('the taxonomy is published', attributes.length > 0, `${attributes.length} attributes`);

  check(
    'every attribute declares a type, operators and a policy class',
    attributes.every((a) => a.data_type && a.operators?.length > 0 && a.policy_class),
  );

  // §4: sensitive classes need explicit legal design first, so none should be
  // targetable in the MVP.
  check(
    'no sensitive attribute is targetable (§4)',
    attributes.every((a) => a.policy_class === 'GENERAL'),
    attributes
      .filter((a) => a.policy_class !== 'GENERAL')
      .map((a) => a.key)
      .join(', '),
  );

  // -------------------------------------------------------------------------
  console.log('\n2. Partner capability publication (§5)');

  // §5.1 has a Partner publish capabilities AGAINST this taxonomy, and §18.2
  // has them read a request's rules by display name. Both need read access.
  // `campaign:read` is Buyer-only and the guard requires EVERY listed
  // permission, so gating the taxonomy on it made the Partner capability page
  // unusable — while every Buyer-side check kept passing.
  const partnerTaxonomy = await api('/v1/audiences/taxonomy', {
    token: partnerA,
    orgId: PARTNER_A_ORG,
  });
  check(
    'a Data Partner can read the taxonomy it publishes against (§5.1, §18.2)',
    partnerTaxonomy.status === 200 && (partnerTaxonomy.body?.items?.length ?? 0) > 0,
    `status ${partnerTaxonomy.status}`,
  );

  // Partner A can evaluate everything the §6.3 example asks for.
  const capA = await api('/v1/partner/capabilities', {
    method: 'PUT',
    token: partnerA,
    orgId: PARTNER_A_ORG,
    body: {
      attributes: [
        { attribute_key: 'age', operators: ['BETWEEN'], status: 'AVAILABLE' },
        { attribute_key: 'gender', operators: ['IN'], status: 'AVAILABLE' },
        { attribute_key: 'online_shopper', operators: ['EQ'], status: 'AVAILABLE' },
        { attribute_key: 'purchase_category', operators: ['IN'], status: 'AVAILABLE' },
        { attribute_key: 'purchase_recency_days', operators: ['LTE'], status: 'AVAILABLE' },
        { attribute_key: 'payment_method', operators: ['IN'], status: 'AVAILABLE' },
      ],
      geographies: ['IN'],
      channels: ['PARTNER_WEB', 'PARTNER_APP'],
      mapping_version: 8,
    },
  });
  check(
    'Partner A publishes capabilities',
    capA.status === 200,
    `v${capA.body?.capability_version}`,
  );

  // Partner B lacks payment_method — an OPTIONAL rule in the audience below.
  const capB = await api('/v1/partner/capabilities', {
    method: 'PUT',
    token: partnerB,
    orgId: PARTNER_B_ORG,
    body: {
      attributes: [
        { attribute_key: 'age', operators: ['BETWEEN'], status: 'AVAILABLE' },
        { attribute_key: 'gender', operators: ['IN'], status: 'AVAILABLE' },
        { attribute_key: 'online_shopper', operators: ['EQ'], status: 'AVAILABLE' },
        { attribute_key: 'purchase_category', operators: ['IN'], status: 'AVAILABLE' },
        { attribute_key: 'purchase_recency_days', operators: ['LTE'], status: 'AVAILABLE' },
      ],
      geographies: ['IN'],
      channels: ['PARTNER_WEB'],
    },
  });
  check('Partner B publishes a narrower capability set', capB.status === 200);

  // §5.2 / §17: Oolix must never learn the Partner's local column names.
  const { rows: capRows } = await db.query(
    `SELECT attributes_json::text AS a FROM partner_capabilities WHERE partner_org_id = $1`,
    [PARTNER_A_ORG],
  );
  const capText = capRows.map((r) => r.a).join(' ');
  check(
    'capability metadata carries no Partner-local field names (§5.2, §17)',
    !/pay_mode|sex_code|dob|last_order_at|product_class/i.test(capText),
  );

  // A Partner cannot claim an operator the taxonomy does not define.
  const badOperator = await api('/v1/partner/capabilities', {
    method: 'PUT',
    token: partnerA,
    orgId: PARTNER_A_ORG,
    body: {
      attributes: [{ attribute_key: 'gender', operators: ['BETWEEN'], status: 'AVAILABLE' }],
      geographies: ['IN'],
      channels: ['PARTNER_WEB'],
    },
  });
  check(
    'a Partner cannot claim an operator the taxonomy forbids',
    badOperator.status === 400,
    `status ${badOperator.status}`,
  );

  // -------------------------------------------------------------------------
  console.log('\n3. Audience Builder (§6, §20)');

  const audienceName = `Urban Shoe Shoppers ${Date.now()}`;
  const created = await api('/v1/audiences', {
    method: 'POST',
    token: buyer,
    orgId: BUYER_ORG,
    body: {
      name: audienceName,
      description: 'Likely footwear buyers',
      rules: [
        { attribute: 'age', operator: 'BETWEEN', value: [18, 35], required: true, weight: 5 },
        { attribute: 'online_shopper', operator: 'EQ', value: true, required: true, weight: 5 },
        {
          attribute: 'purchase_category',
          operator: 'IN',
          value: ['FOOTWEAR'],
          required: true,
          weight: 5,
        },
        {
          attribute: 'purchase_recency_days',
          operator: 'LTE',
          value: 90,
          required: true,
          weight: 4,
        },
        {
          attribute: 'gender',
          operator: 'IN',
          value: ['MALE', 'FEMALE'],
          required: false,
          weight: 1,
        },
        {
          attribute: 'payment_method',
          operator: 'IN',
          value: ['UPI', 'CREDIT_CARD'],
          required: false,
          weight: 2,
        },
      ],
    },
  });
  check('Buyer creates a versioned audience', created.status === 201, `v${created.body?.version}`);
  const audienceId = created.body?.id;
  const firstHash = created.body?.rule_hash;
  check('the audience has a rule hash (§10)', /^[0-9a-f]{64}$/.test(firstHash ?? ''));

  // §20: ">=4 rules with REQUIRED/OPTIONAL semantics".
  const tooFew = await api('/v1/audiences', {
    method: 'POST',
    token: buyer,
    orgId: BUYER_ORG,
    body: {
      name: `Too thin ${Date.now()}`,
      rules: [
        { attribute: 'age', operator: 'BETWEEN', value: [18, 35], required: true, weight: 5 },
      ],
    },
  });
  check('an audience with too few rules is refused (§20)', tooFew.status === 400);

  // §17: allowed fields come from the taxonomy. Nothing else is expressible.
  const unknownAttr = await api('/v1/audiences', {
    method: 'POST',
    token: buyer,
    orgId: BUYER_ORG,
    body: {
      name: `Unknown ${Date.now()}`,
      rules: [
        { attribute: 'salary_band', operator: 'IN', value: ['HIGH'], required: true, weight: 5 },
        { attribute: 'age', operator: 'BETWEEN', value: [18, 35], required: true, weight: 5 },
        { attribute: 'gender', operator: 'IN', value: ['MALE'], required: true, weight: 5 },
        { attribute: 'online_shopper', operator: 'EQ', value: true, required: true, weight: 5 },
      ],
    },
  });
  check(
    'an attribute outside the taxonomy is refused (§17)',
    unknownAttr.status === 400,
    unknownAttr.body?.error?.field_errors?.[0]?.message ?? '',
  );

  const badValue = await api('/v1/audiences', {
    method: 'POST',
    token: buyer,
    orgId: BUYER_ORG,
    body: {
      name: `Bad value ${Date.now()}`,
      rules: [
        {
          attribute: 'purchase_category',
          operator: 'IN',
          value: ['FIREARMS'],
          required: true,
          weight: 5,
        },
        { attribute: 'age', operator: 'BETWEEN', value: [18, 35], required: true, weight: 5 },
        { attribute: 'gender', operator: 'IN', value: ['MALE'], required: true, weight: 5 },
        { attribute: 'online_shopper', operator: 'EQ', value: true, required: true, weight: 5 },
      ],
    },
  });
  check('a value outside the allowed list is refused (§17)', badValue.status === 400);

  await api(`/v1/audiences/${audienceId}/publish`, {
    method: 'POST',
    token: buyer,
    orgId: BUYER_ORG,
  });

  // -------------------------------------------------------------------------
  console.log('\n4. Capability matching (§7, §20)');

  const matches = await api(`/v1/audiences/${audienceId}/partner-matches`, {
    token: buyer,
    orgId: BUYER_ORG,
  });
  check('matches are returned', matches.status === 200, `${matches.body?.items?.length} Partners`);

  const byId = Object.fromEntries((matches.body?.items ?? []).map((m) => [m.partner_org_id, m]));
  const a = byId[PARTNER_A_ORG];
  const b = byId[PARTNER_B_ORG];

  check(
    'Partner A supports everything and scores 100',
    a?.status === 'COMPATIBLE' && a?.match_score === 100,
    `${a?.match_score}%`,
  );
  check(
    'Partner B is still COMPATIBLE with only an OPTIONAL rule missing (§7)',
    b?.status === 'COMPATIBLE' && b?.match_score < 100,
    `${b?.match_score}% missing ${b?.missing_optional_rules?.join(', ')}`,
  );
  check(
    'the missing optional rule is named for the Buyer (§6.3)',
    b?.missing_optional_rules?.includes('payment_method'),
  );

  // §20: "Missing required rule => INCOMPATIBLE".
  const strictName = `Strict payers ${Date.now()}`;
  const strict = await api('/v1/audiences', {
    method: 'POST',
    token: buyer,
    orgId: BUYER_ORG,
    body: {
      name: strictName,
      rules: [
        { attribute: 'age', operator: 'BETWEEN', value: [18, 35], required: true, weight: 5 },
        { attribute: 'online_shopper', operator: 'EQ', value: true, required: true, weight: 5 },
        {
          attribute: 'purchase_category',
          operator: 'IN',
          value: ['FOOTWEAR'],
          required: true,
          weight: 5,
        },
        // REQUIRED this time. Partner B cannot evaluate it.
        {
          attribute: 'payment_method',
          operator: 'IN',
          value: ['UPI'],
          required: true,
          weight: 5,
        },
      ],
    },
  });
  const strictMatches = await api(`/v1/audiences/${strict.body?.id}/partner-matches`, {
    token: buyer,
    orgId: BUYER_ORG,
  });
  const strictB = (strictMatches.body?.items ?? []).find((m) => m.partner_org_id === PARTNER_B_ORG);
  check(
    'the SAME missing field makes a Partner INCOMPATIBLE when REQUIRED (§7, §20)',
    strictB?.status === 'INCOMPATIBLE',
    `missing ${strictB?.missing_required_rules?.join(', ')}`,
  );

  check(
    'match score is labelled as compatibility, not audience quality (§7)',
    /not a measure of audience quality/i.test(matches.body?.notice ?? ''),
  );

  // -------------------------------------------------------------------------
  console.log('\n5. Versioning (§16)');

  const edited = await api(`/v1/audiences/${audienceId}`, {
    method: 'PATCH',
    token: buyer,
    orgId: BUYER_ORG,
    body: {
      rules: [
        { attribute: 'age', operator: 'BETWEEN', value: [25, 45], required: true, weight: 5 },
        { attribute: 'online_shopper', operator: 'EQ', value: true, required: true, weight: 5 },
        {
          attribute: 'purchase_category',
          operator: 'IN',
          value: ['FOOTWEAR'],
          required: true,
          weight: 5,
        },
        {
          attribute: 'purchase_recency_days',
          operator: 'LTE',
          value: 90,
          required: true,
          weight: 4,
        },
      ],
    },
  });
  check(
    'editing a READY audience forks a new version (§16)',
    edited.body?.forked === true && edited.body?.version === 2,
    `v${edited.body?.version}`,
  );
  check('the new version has a different rule hash', edited.body?.rule_hash !== firstHash);

  const detail = await api(`/v1/audiences/${audienceId}`, { token: buyer, orgId: BUYER_ORG });
  const v1 = detail.body?.versions?.find((v) => v.version === 1);
  check(
    'the earlier version is retained and marked superseded (§16)',
    v1?.status === 'SUPERSEDED' && v1?.rule_hash === firstHash,
    v1?.status,
  );

  // -------------------------------------------------------------------------
  console.log('\n6. Rule hash stability (§10)');

  // The hash must not depend on the order a Buyer happened to type things in,
  // or a Partner would be asked to re-approve an audience that had not changed.
  const orderA = await api('/v1/audiences', {
    method: 'POST',
    token: buyer,
    orgId: BUYER_ORG,
    body: {
      name: `Order one ${Date.now()}`,
      rules: [
        { attribute: 'age', operator: 'BETWEEN', value: [18, 35], required: true, weight: 5 },
        {
          attribute: 'gender',
          operator: 'IN',
          value: ['MALE', 'FEMALE'],
          required: true,
          weight: 3,
        },
        { attribute: 'online_shopper', operator: 'EQ', value: true, required: true, weight: 5 },
        {
          attribute: 'purchase_category',
          operator: 'IN',
          value: ['FOOTWEAR'],
          required: true,
          weight: 5,
        },
      ],
    },
  });
  const orderB = await api('/v1/audiences', {
    method: 'POST',
    token: buyer,
    orgId: BUYER_ORG,
    body: {
      name: `Order two ${Date.now()}`,
      rules: [
        {
          attribute: 'purchase_category',
          operator: 'IN',
          value: ['FOOTWEAR'],
          required: true,
          weight: 5,
        },
        { attribute: 'online_shopper', operator: 'EQ', value: true, required: true, weight: 5 },
        // Same set, listed the other way round.
        {
          attribute: 'gender',
          operator: 'IN',
          value: ['FEMALE', 'MALE'],
          required: true,
          weight: 3,
        },
        { attribute: 'age', operator: 'BETWEEN', value: [18, 35], required: true, weight: 5 },
      ],
    },
  });
  check(
    'the same rules hash identically however they are ordered (§10)',
    orderA.body?.rule_hash === orderB.body?.rule_hash,
  );

  // -------------------------------------------------------------------------
  console.log('\n7. Privacy boundary (§17, §20)');

  const { rows: audienceRows } = await db.query(
    `SELECT rules_json::text AS r FROM audience_group_versions`,
  );
  const allRules = audienceRows.map((r) => r.r).join(' ');
  check(
    'no customer identifier appears in any stored audience rule (§17)',
    !/partner_user_id|U123|U456/.test(allRules),
  );

  const { rows: estimateCols } = await db.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema='public' AND table_name='reach_estimates'`,
  );
  const cols = estimateCols.map((c) => c.column_name);
  check(
    'reach_estimates has no exact-count column (§8.2, §17)',
    !cols.some((c) => /exact|count|members|size/i.test(c)),
    cols.filter((c) => /exact|count/i.test(c)).join(', '),
  );
  check('reach_estimates stores a bucket', cols.includes('reach_bucket'));

  const { rows: forbidden } = await db.query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema='public'
        AND table_name IN ('audience_members','audience_materializations','customers')`,
  );
  check(
    'no local materialization table exists centrally (§11 privacy boundary)',
    forbidden.length === 0,
    forbidden.map((f) => f.table_name).join(', '),
  );

  // §17: a Buyer cannot reach another Buyer's audiences.
  const otherBuyer = await api(`/v1/audiences/${audienceId}`, {
    token: partnerA,
    orgId: PARTNER_A_ORG,
  });
  check(
    'a Partner cannot read a Buyer audience group (§66)',
    otherBuyer.status === 403 || otherBuyer.status === 404,
    `status ${otherBuyer.status}`,
  );

  // -------------------------------------------------------------------------
  console.log('\n8. Reach estimation request (§8)');

  const estimates = await api(`/v1/audiences/${audienceId}/reach-estimates`, {
    method: 'POST',
    token: buyer,
    orgId: BUYER_ORG,
    body: { partner_org_ids: [PARTNER_A_ORG] },
  });
  check(
    'an estimate can be requested from a compatible Partner',
    // §8.1: 202, because nothing has been evaluated when this returns.
    estimates.status === 202,
    `status ${estimates.status}`,
  );
  check(
    'the estimate starts as REQUESTED, with no bucket yet (§8.1)',
    estimates.body?.requests?.[0]?.status === 'REQUESTED',
  );

  // §7: asking an INCOMPATIBLE Partner would waste their query and mislead the
  // Buyer, so it is refused up front.
  const strictEstimate = await api(`/v1/audiences/${strict.body?.id}/reach-estimates`, {
    method: 'POST',
    token: buyer,
    orgId: BUYER_ORG,
    body: { partner_org_ids: [PARTNER_B_ORG] },
  });
  check(
    'an INCOMPATIBLE Partner cannot be asked for an estimate (§7)',
    strictEstimate.status === 409,
    `status ${strictEstimate.status}`,
  );

  // §17: repeated requests are cached rather than re-run.
  const again = await api(`/v1/audiences/${audienceId}/reach-estimates`, {
    method: 'POST',
    token: buyer,
    orgId: BUYER_ORG,
    body: { partner_org_ids: [PARTNER_A_ORG] },
  });
  check(
    'a repeated request is cached, not re-run (§17 anti-differencing)',
    again.body?.requests?.[0]?.cached === true,
  );
  check(
    'the cached request returns the same estimate id',
    again.body?.requests?.[0]?.reach_estimate_id ===
      estimates.body?.requests?.[0]?.reach_estimate_id,
  );

  // -------------------------------------------------------------------------
  console.log('\n9. Rule hash is reproducible from what was stored (§10)');

  const { rows: hashRows } = await db.query(
    `SELECT rules_json::text AS rules, rule_hash FROM audience_group_versions
      WHERE audience_group_id = $1 AND version = 1`,
    [audienceId],
  );
  if (hashRows[0]) {
    const stored = JSON.parse(hashRows[0].rules);
    // Recompute the way the Agent will: sort each rule canonically, sort the
    // set, hash. A Partner is entitled to check this themselves.
    const canonical = stored
      .map((r) => {
        const value = Array.isArray(r.value)
          ? r.operator === 'BETWEEN'
            ? r.value
            : [...r.value].map(String).sort()
          : r.value;
        return JSON.stringify([r.attribute, r.operator, value, r.required]);
      })
      .sort();
    const recomputed = createHash('sha256')
      .update(`[${canonical.join(',')}]`)
      .digest('hex');
    check(
      'the stored hash recomputes from the stored rules (§10)',
      recomputed === hashRows[0].rule_hash,
    );
  } else {
    check('the stored hash recomputes from the stored rules (§10)', false, 'no version row');
  }

  // -------------------------------------------------------------------------
  console.log('\n10. Campaign to audience link (§9)');

  const brands = await api('/v1/brands', { token: buyer, orgId: BUYER_ORG });
  const brandId = brands.body?.items?.[0]?.id;

  const campaign = await api('/v1/campaigns', {
    method: 'POST',
    token: buyer,
    orgId: BUYER_ORG,
    body: {
      name: `v6 audience campaign ${Date.now()}`,
      brand_id: brandId,
      objective: 'AWARENESS',
      category: 'insurance',
      purpose_id: 'footwear_offer',
      budget: { amount_minor: 5_000_000, currency: 'INR' },
      start_at: new Date(Date.now() + 86_400_000).toISOString(),
      end_at: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      geographies: ['IN'],
    },
  });
  const campaignId = campaign.body?.id;
  check('a campaign can be drafted', campaign.status === 201, `status ${campaign.status}`);

  // §6/§10: only a READY version can be linked. Section 5 above forked v2 by
  // editing, so publish it first -- binding a Partner's approval to rules the
  // Buyer had not finished writing is exactly what that guard prevents.
  await api(`/v1/audiences/${audienceId}/publish`, {
    method: 'POST',
    token: buyer,
    orgId: BUYER_ORG,
  });

  const linked = await api(`/v1/campaigns/${campaignId}/audience-link`, {
    method: 'POST',
    token: buyer,
    orgId: BUYER_ORG,
    body: { audience_group_id: audienceId },
  });
  check(
    'an audience can be linked to a campaign (§9 step 3)',
    linked.status === 200 || linked.status === 201,
    `status ${linked.status} ${linked.body?.error?.message ?? ''}`,
  );
  check(
    'the link freezes the audience version and rule hash (§9, §10)',
    typeof linked.body?.audience_version === 'number' &&
      /^[0-9a-f]{64}$/.test(linked.body?.rule_hash ?? ''),
  );

  // §9/§10: the frozen hash is the Partner's approval anchor. If editing the
  // audience moved it, a Partner would end up bound to rules they never saw.
  const frozenHash = linked.body?.rule_hash;
  const frozenVersion = linked.body?.audience_version;

  await api(`/v1/audiences/${audienceId}`, {
    method: 'PATCH',
    token: buyer,
    orgId: BUYER_ORG,
    body: {
      rules: [
        { attribute: 'online_shopper', operator: 'EQ', value: true, required: true, weight: 5 },
        {
          attribute: 'purchase_category',
          operator: 'IN',
          value: ['FOOTWEAR'],
          required: true,
          weight: 5,
        },
        { attribute: 'age', operator: 'BETWEEN', value: [21, 40], required: true, weight: 5 },
      ],
    },
  });

  const afterEdit = await api(`/v1/campaigns/${campaignId}/audience-link`, {
    token: buyer,
    orgId: BUYER_ORG,
  });
  check(
    "editing the audience does NOT move the campaign's frozen version (§9)",
    typeof frozenVersion === 'number' &&
      /^[0-9a-f]{64}$/.test(frozenHash ?? '') &&
      afterEdit.body?.audience?.audience_version === frozenVersion &&
      afterEdit.body?.audience?.rule_hash === frozenHash,
    `frozen v${frozenVersion}, reads back v${afterEdit.body?.audience?.audience_version}`,
  );

  // §19: a request now targets the linked audience with no segment at all.
  const audienceRequest = await api(`/v1/campaigns/${campaignId}/partner-requests`, {
    method: 'POST',
    token: buyer,
    orgId: BUYER_ORG,
    body: {
      partner_org_id: PARTNER_A_ORG,
      channels: [
        {
          channel: 'PARTNER_APP',
          placement_ids: [],
          allocation_minor: 1_000_000,
          frequency_cap: { max_impressions: 2, window: 'P1D' },
        },
      ],
      creative_version_ids: [],
    },
  });
  // The creative list is empty here, so this must fail on CREATIVES, not on
  // missing targeting -- that is what proves the audience path resolved.
  const audienceRequestFields = (audienceRequest.body?.error?.field_errors ?? [])
    .map((f) => f.field)
    .join(',');
  check(
    'a Partner request needs no segment when an audience is linked (§19)',
    audienceRequestFields.includes('creative_version_ids') &&
      !audienceRequestFields.includes('segment_id'),
    `rejected on: ${audienceRequestFields || '(none)'}`,
  );

  // §19: both at once leaves two answers to "who is this for".
  const both = await api(`/v1/campaigns/${campaignId}/partner-requests`, {
    method: 'POST',
    token: buyer,
    orgId: BUYER_ORG,
    body: {
      partner_org_id: PARTNER_A_ORG,
      segment_id: '00000000-0000-4000-8000-000000000001',
      reach_estimate_id: '00000000-0000-4000-8000-000000000002',
      channels: [
        {
          channel: 'PARTNER_APP',
          placement_ids: [],
          allocation_minor: 1_000_000,
          frequency_cap: { max_impressions: 2, window: 'P1D' },
        },
      ],
      creative_version_ids: [],
    },
  });
  check(
    'a request cannot target both a segment and the audience (§19)',
    both.status === 400,
    `status ${both.status}`,
  );

  // §9: one campaign, one Audience Group.
  const { rows: linkRows } = await db.query(
    'SELECT count(*)::int AS n FROM campaign_audience_links WHERE campaign_id = $1',
    [campaignId],
  );
  check(
    'a campaign links exactly one Audience Group (§9)',
    linkRows[0]?.n === 1,
    `${linkRows[0]?.n}`,
  );
} finally {
  await db.end();
}

console.log(
  failures === 0 ? '\nv6 verified: all checks passed.\n' : `\n${failures} check(s) FAILED.\n`,
);
process.exit(failures === 0 ? 0 : 1);
