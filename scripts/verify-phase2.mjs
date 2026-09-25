#!/usr/bin/env node
/**
 * Phase 2 exit criterion (spec v5 §85):
 *   "Buyer can create multi-Partner draft."
 *
 * Drives audience discovery (§39), the campaign builder steps 1-9 (§40) and
 * the creative upload flow (§93) against the running system.
 *
 * Usage: node scripts/verify-phase2.mjs
 */
import { createHash } from 'node:crypto';
import { onboardPartnerAgent } from './lib/onboard-partner.mjs';
import { seedToken } from './lib/login.mjs';

const API = process.env.API_PUBLIC_URL ?? 'http://localhost:4000';

const BUYER_ORG = '11111111-1111-4111-8111-111111111111';
const BRAND = '66666666-6666-4666-8666-666666666666';

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
  if (!ok) failures += 1;
  return ok;
};

const token = (username) => seedToken(username, { api: API });

async function api(path, { method = 'GET', token: tok, body, orgId = BUYER_ORG } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      ...(tok ? { Authorization: `Bearer ${tok}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
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

/** Smallest valid PNG, so the §93 magic-byte check has something real to verify. */
function pngBytes() {
  return Buffer.from(
    '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478' +
      '9c6360000002000100ffff03000006000557bfabd40000000049454e44ae426082',
    'hex',
  );
}

console.log('\nPhase 2 verification -- Catalogue + campaign builder (spec §85)\n');

const buyerAdmin = await token('buyer.admin@example.test');
const buyerOperator = await token('buyer.operator@example.test');
const partnerAdmin = await token('partner.admin@example.test');

const PARTNER_A_ORG = '22222222-2222-4222-8222-222222222222';
const PARTNER_B_ORG = '33333333-3333-4333-8333-333333333333';

// Setup: both Partners need a live Agent before a Buyer may request their
// supply (§37). Done through the real §92 flow rather than seeded, because
// readiness must reflect an Agent that genuinely exists and has reported in.
console.log('0. Partner onboarding setup (§37, §92)');
for (const [label, org, who] of [
  ['Partner A', PARTNER_A_ORG, 'partner.security@example.test'],
  ['Partner B', PARTNER_B_ORG, 'partnerb.admin@example.test'],
]) {
  const readiness = await api('/v1/partner/readiness', {
    token: await token(who),
    orgId: org,
  });
  if (readiness.body?.readiness !== 'READY_FOR_CAMPAIGNS') {
    await onboardPartnerAgent({ api: API, securityToken: await token(who), orgId: org });
  }
  const after = await api('/v1/partner/readiness', { token: await token(who), orgId: org });
  check(
    `${label} is READY_FOR_CAMPAIGNS`,
    after.body?.readiness === 'READY_FOR_CAMPAIGNS',
    `${after.body?.readiness}`,
  );
}
console.log('');

// ---------------------------------------------------------------------------
console.log('1. Audience discovery (§39, §67.5)');
const all = await api('/v1/catalogue/segments', { token: buyerAdmin });
check('catalogue search responds', all.status === 200, `status ${all.status}`);
check(
  'seeded segments are discoverable',
  (all.body?.items?.length ?? 0) >= 3,
  `${all.body?.items?.length ?? 0} items`,
);
check(
  'response carries the §72 do-not-sum notice',
  /must not be summed/i.test(all.body?.notice ?? ''),
);

const first = all.body?.items?.[0];
check(
  'a result card exposes a bucket and never an exact count',
  Boolean(first?.reach_bucket) && !JSON.stringify(first).match(/reach_exact|213418|64207/),
  `bucket=${first?.reach_bucket}`,
);
check(
  'partner trust status is shown (§39.2)',
  first?.partner?.trust_status === 'VERIFIED',
  first?.partner?.trust_status,
);

const filtered = await api('/v1/catalogue/segments?query=traveller&geo=IN&channel=PARTNER_WEB', {
  token: buyerAdmin,
});
check(
  'keyword + geo + channel filters apply',
  filtered.status === 200 && Array.isArray(filtered.body?.items),
);

const tinyReach = await api('/v1/catalogue/segments?reach_min=900000000', { token: buyerAdmin });
check(
  'an impossible reach filter returns nothing rather than a tiny cohort',
  (tinyReach.body?.items?.length ?? 0) === 0,
);

const external = all.body?.items?.flatMap((i) => i.channels ?? []).filter((c) => c.type === 'META');
check(
  'META is never AVAILABLE from the catalogue alone (§32, §84)',
  external.every((c) => c.status !== 'AVAILABLE'),
  external.map((c) => c.status).join(',') || '(none offered)',
);

// ---------------------------------------------------------------------------
console.log('\n2. Campaign creation (§40.1-40.2)');
const badDomain = await api('/v1/campaigns', {
  method: 'POST',
  token: buyerAdmin,
  body: {
    name: 'Wrong landing domain',
    objective: 'QUALIFIED_LEADS',
    brand_id: BRAND,
    category: 'insurance',
    purpose_id: 'travel_insurance_offer',
    budget: { amount_minor: 50_000_000, currency: 'INR' },
    start_at: '2026-09-01T00:00:00Z',
    end_at: '2026-10-31T23:59:59Z',
    geographies: ['IN'],
    landing_url: 'https://not-the-brand.example/quote',
    lead_definition: { qualified_statuses: ['QUALIFIED'], duplicate_window_days: 30 },
  },
});
check(
  'landing_url must be on the verified brand domain (§40.2)',
  badDomain.status === 400,
  `status ${badDomain.status}`,
);

const piiUrl = await api('/v1/campaigns', {
  method: 'POST',
  token: buyerAdmin,
  body: {
    name: 'PII in landing url',
    objective: 'CLICKS',
    brand_id: BRAND,
    category: 'insurance',
    purpose_id: 'travel_insurance_offer',
    budget: { amount_minor: 1_000_000, currency: 'INR' },
    start_at: '2026-09-01T00:00:00Z',
    end_at: '2026-10-31T23:59:59Z',
    geographies: ['IN'],
    landing_url: 'https://insurance.example/quote?email=a@b.c',
  },
});
check(
  'landing_url must not carry PII parameters (§40.7)',
  piiUrl.status === 400,
  `status ${piiUrl.status}`,
);

const noLeadDef = await api('/v1/campaigns', {
  method: 'POST',
  token: buyerAdmin,
  body: {
    name: 'No lead definition',
    objective: 'QUALIFIED_LEADS',
    brand_id: BRAND,
    category: 'insurance',
    purpose_id: 'travel_insurance_offer',
    budget: { amount_minor: 1_000_000, currency: 'INR' },
    start_at: '2026-09-01T00:00:00Z',
    end_at: '2026-10-31T23:59:59Z',
    geographies: ['IN'],
    landing_url: 'https://insurance.example/quote',
  },
});
check(
  'an outcome campaign must define its outcome (§40.8, §50)',
  noLeadDef.status === 400,
  `status ${noLeadDef.status}`,
);

const created = await api('/v1/campaigns', {
  method: 'POST',
  token: buyerAdmin,
  body: {
    name: `Summer Travel Insurance ${Date.now()}`,
    objective: 'QUALIFIED_LEADS',
    brand_id: BRAND,
    category: 'insurance',
    purpose_id: 'travel_insurance_offer',
    budget: { amount_minor: 50_000_000, currency: 'INR' },
    start_at: '2026-09-01T00:00:00Z',
    end_at: '2026-10-31T23:59:59Z',
    geographies: ['IN'],
    landing_url: 'https://insurance.example/quote',
    lead_definition: { qualified_statuses: ['QUALIFIED'], duplicate_window_days: 30 },
  },
});
check(
  'campaign created as DRAFT',
  created.status === 201 && created.body?.status === 'DRAFT',
  `status ${created.status}`,
);
const campaignId = created.body?.id;

// ---------------------------------------------------------------------------
console.log('\n3. Creative upload and versioning (§70, §93)');
const png = pngBytes();
const session = await api('/v1/creatives/upload-session', {
  method: 'POST',
  token: buyerOperator,
  body: {
    campaign_id: campaignId,
    file_name: 'travel_insurance.png',
    mime_type: 'image/png',
    file_size_bytes: png.length,
    creative_type: 'NATIVE_CARD',
    headline: 'Protect your trip',
    body: 'Get travel insurance in minutes.',
    cta: 'GET_QUOTE',
    destination_url: 'https://insurance.example/quote',
  },
});
check('upload session issued', session.status === 201, `status ${session.status}`);
check('pre-signed PUT URL returned', typeof session.body?.upload_url === 'string');

const put = await fetch(session.body.upload_url, {
  method: 'PUT',
  headers: session.body.upload_headers,
  body: png,
});
check('direct upload to object storage succeeds', put.ok, `status ${put.status}`);

const wrongHash = await api(`/v1/creatives/${session.body.creative_version_id}/finalize`, {
  method: 'POST',
  token: buyerOperator,
  body: { content_sha256: 'f'.repeat(64) },
});
check(
  'finalize rejects a hash that does not match the bytes (§70)',
  wrongHash.status === 400,
  `status ${wrongHash.status}`,
);

const sha = createHash('sha256').update(png).digest('hex');
const finalized = await api(`/v1/creatives/${session.body.creative_version_id}/finalize`, {
  method: 'POST',
  token: buyerOperator,
  body: { content_sha256: sha },
});
check(
  'creative becomes READY',
  finalized.body?.status === 'READY',
  `status ${finalized.body?.status}`,
);
check('content hash is recorded for approval binding', finalized.body?.content_sha256 === sha);
const creativeVersionId = session.body.creative_version_id;

// ---------------------------------------------------------------------------
console.log('\n4. Multi-Partner requests (§13, §40.4-40.6)');
// Searched by name rather than read off the first page: accumulated test
// segments push the seeded ones out of a capped listing.
const catA = await api('/v1/catalogue/segments?query=Recent%20Travellers', {
  token: buyerAdmin,
});
const catB = await api('/v1/catalogue/segments?query=Travel%20Rewards%20Members', {
  token: buyerAdmin,
});
const partnerASeg = catA.body.items.find((i) => i.display_name === 'Recent Travellers');
const partnerBSeg = catB.body.items.find((i) => i.display_name === 'Travel Rewards Members');
check('two different Partners are discoverable', Boolean(partnerASeg && partnerBSeg));

const detail = await api(`/v1/catalogue/segments/${partnerASeg.segment_id}`, { token: buyerAdmin });
const placementA = detail.body?.placements?.[0];
check('segment detail lists Partner placements', Boolean(placementA), placementA?.placement_key);

const reqA = await api(`/v1/campaigns/${campaignId}/partner-requests`, {
  method: 'POST',
  token: buyerAdmin,
  body: {
    partner_org_id: partnerASeg.partner.id,
    segment_id: partnerASeg.segment_id,
    channels: [
      {
        channel: 'PARTNER_WEB',
        placement_ids: [placementA.placement_id],
        allocation_minor: 30_000_000,
        frequency_cap: { max_impressions: 2, window: 'P1D' },
      },
    ],
    creative_version_ids: [creativeVersionId],
    partner_payout: { model: 'CPQL', unit_price_minor: 450_000 },
  },
});
check(
  'Partner A request created',
  reqA.status === 201,
  `status ${reqA.status} ${reqA.body?.error?.message ?? ''}`,
);

const detailB = await api(`/v1/catalogue/segments/${partnerBSeg.segment_id}`, {
  token: buyerAdmin,
});
const placementB = detailB.body?.placements?.[0];

const reqB = await api(`/v1/campaigns/${campaignId}/partner-requests`, {
  method: 'POST',
  token: buyerAdmin,
  body: {
    partner_org_id: partnerBSeg.partner.id,
    segment_id: partnerBSeg.segment_id,
    channels: [
      {
        channel: 'PARTNER_WEB',
        placement_ids: [placementB.placement_id],
        allocation_minor: 15_000_000,
        frequency_cap: { max_impressions: 3, window: 'P1D' },
      },
    ],
    creative_version_ids: [creativeVersionId],
    partner_payout: { model: 'CPQL', unit_price_minor: 450_000 },
  },
});
check(
  'Partner B request created',
  reqB.status === 201,
  `status ${reqB.status} ${reqB.body?.error?.message ?? ''}`,
);

// ---------------------------------------------------------------------------
console.log('\n5. Guardrails (§40.6, §84, §41)');
const overBudget = await api(`/v1/campaigns/${campaignId}/partner-requests`, {
  method: 'POST',
  token: buyerAdmin,
  body: {
    partner_org_id: partnerASeg.partner.id,
    segment_id: partnerASeg.segment_id,
    channels: [
      {
        channel: 'PARTNER_WEB',
        placement_ids: [placementA.placement_id],
        allocation_minor: 40_000_000,
        frequency_cap: { max_impressions: 2, window: 'P1D' },
      },
    ],
    creative_version_ids: [creativeVersionId],
  },
});
check(
  'allocations cannot exceed the campaign budget (§40.6)',
  overBudget.status === 409 && ['CAMP_003', 'CAMP_002'].includes(overBudget.body?.error?.code),
  `status ${overBudget.status} ${overBudget.body?.error?.code ?? ''}`,
);

const metaRequest = await api(`/v1/campaigns/${campaignId}/partner-requests`, {
  method: 'POST',
  token: buyerAdmin,
  body: {
    partner_org_id: partnerBSeg.partner.id,
    segment_id: partnerBSeg.segment_id,
    channels: [
      {
        channel: 'META',
        placement_ids: [],
        allocation_minor: 1_000_000,
        frequency_cap: { max_impressions: 2, window: 'P1D' },
      },
    ],
    creative_version_ids: [creativeVersionId],
  },
});
check(
  'META cannot be requested while its feature flag is off (§84)',
  // The segment DOES list META, so this must be the feature-flag gate firing
  // rather than a segment-channel mismatch.
  metaRequest.status === 409 && metaRequest.body?.error?.code === 'CHAN_001',
  `status ${metaRequest.status} ${metaRequest.body?.error?.code ?? ''}`,
);

// ---------------------------------------------------------------------------
console.log('\n6. Phase 2 exit criterion (§85)');
const full = await api(`/v1/campaigns/${campaignId}`, { token: buyerAdmin });
check(
  'one campaign holds requests for 2+ independent Partners',
  (full.body?.partner_requests?.length ?? 0) >= 2,
  `${full.body?.partner_requests?.length ?? 0} partner requests`,
);
check(
  'budget allocation is tracked against the total',
  full.body?.budget?.allocated_minor === 45_000_000 &&
    full.body?.budget?.unallocated_minor === 5_000_000,
  `allocated=${full.body?.budget?.allocated_minor} unallocated=${full.body?.budget?.unallocated_minor}`,
);
check(
  'parent status is DRAFT and derived separately from activations (§42)',
  full.body?.status === 'DRAFT' && full.body?.derived_status === 'DRAFT',
  `status=${full.body?.status} derived=${full.body?.derived_status}`,
);

const partnerPeek = await api(`/v1/campaigns/${campaignId}`, {
  token: partnerAdmin,
  orgId: '22222222-2222-4222-8222-222222222222',
});
check(
  'a Partner cannot read the Buyer-facing parent campaign (§40.4 isolation)',
  partnerPeek.status === 403 || partnerPeek.status === 404,
  `status ${partnerPeek.status}`,
);

console.log(
  failures === 0 ? '\nPhase 2 verified: all checks passed.\n' : `\n${failures} check(s) FAILED.\n`,
);
process.exit(failures === 0 ? 0 : 1);
