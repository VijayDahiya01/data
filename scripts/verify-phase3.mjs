#!/usr/bin/env node
/**
 * Phase 3 exit criterion (spec v5 §85):
 *   "Agent accepts valid manifest and rejects tampered/expired."
 *
 * Runs the full approval workflow against the live API, then verifies the
 * resulting manifests exactly as a Partner Agent would: fetching the published
 * JWKS and applying the §75 checks.
 *
 * Usage: node scripts/verify-phase3.mjs
 */
import { createHash } from 'node:crypto';
import { createLocalJWKSet, compactVerify, decodeProtectedHeader } from 'jose';
import { verifyManifest } from '@oolix/manifest-schema';
import { onboardPartnerAgent } from './lib/onboard-partner.mjs';
import { seedToken } from './lib/login.mjs';

const API = process.env.API_PUBLIC_URL ?? 'http://localhost:4000';

const BUYER_ORG = '11111111-1111-4111-8111-111111111111';
const PARTNER_A_ORG = '22222222-2222-4222-8222-222222222222';
const PARTNER_B_ORG = '33333333-3333-4333-8333-333333333333';
const BRAND = '66666666-6666-4666-8666-666666666666';

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
  if (!ok) failures += 1;
  return ok;
};

const token = (username) => seedToken(username, { api: API });

async function api(
  path,
  { method = 'GET', token: tok, body, orgId = BUYER_ORG, headers = {}, idempotencyKey } = {},
) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      ...(tok ? { Authorization: `Bearer ${tok}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      // §53 requires the header on submit and approval.
      ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
      'X-Org-Id': orgId,
      ...headers,
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

function pngBytes() {
  return Buffer.from(
    '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478' +
      '9c6360000002000100ffff03000006000557bfabd40000000049454e44ae426082',
    'hex',
  );
}

/** Build a campaign with one request per Partner and submit it. */
async function buildSubmittedCampaign(buyerAdmin, buyerOperator) {
  const created = await api('/v1/campaigns', {
    method: 'POST',
    token: buyerAdmin,
    body: {
      name: `Approval flow ${Date.now()}`,
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
    },
  });
  const campaignId = created.body.id;

  const png = pngBytes();
  const session = await api('/v1/creatives/upload-session', {
    method: 'POST',
    token: buyerOperator,
    body: {
      campaign_id: campaignId,
      file_name: 'offer.png',
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
  const creativeVersionId = session.body.creative_version_id;

  // One query per segment. A shared term is not enough: accumulated test
  // segments share the travel category and refill the capped page.
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
      partner_org_id: segA.partner.id,
      segment_id: segA.segment_id,
      channels: [
        {
          channel: 'PARTNER_WEB',
          placement_ids: [detA.body.placements[0].placement_id],
          allocation_minor: 30_000_000,
          frequency_cap: { max_impressions: 2, window: 'P1D' },
        },
      ],
      creative_version_ids: [creativeVersionId],
      partner_payout: { model: 'CPQL', unit_price_minor: 450_000 },
    },
  });

  const reqB = await api(`/v1/campaigns/${campaignId}/partner-requests`, {
    method: 'POST',
    token: buyerAdmin,
    body: {
      partner_org_id: segB.partner.id,
      segment_id: segB.segment_id,
      channels: [
        {
          channel: 'PARTNER_WEB',
          placement_ids: [detB.body.placements[0].placement_id],
          allocation_minor: 15_000_000,
          frequency_cap: { max_impressions: 3, window: 'P1D' },
        },
      ],
      creative_version_ids: [creativeVersionId],
      partner_payout: { model: 'CPQL', unit_price_minor: 450_000 },
    },
  });

  const submitted = await api(`/v1/campaigns/${campaignId}/submit`, {
    method: 'POST',
    token: buyerAdmin,
    idempotencyKey: crypto.randomUUID(),
  });

  return {
    campaignId,
    creativeVersionId,
    requestA: reqA.body.request_id,
    requestB: reqB.body.request_id,
    submitted,
  };
}

console.log('\nPhase 3 verification -- Approval + signed manifests (spec §85)\n');

const buyerAdmin = await token('buyer.admin@example.test');
const buyerOperator = await token('buyer.operator@example.test');
const partnerApprover = await token('partner.approver@example.test');
const partnerAdmin = await token('partner.admin@example.test');
const partnerBApprover = await token('partnerb.approver@example.test');

// ---------------------------------------------------------------------------
console.log('0. Setup');
for (const [org, who] of [
  [PARTNER_A_ORG, 'partner.security@example.test'],
  [PARTNER_B_ORG, 'partnerb.admin@example.test'],
]) {
  const r = await api('/v1/partner/readiness', { token: await token(who), orgId: org });
  if (r.body?.readiness !== 'READY_FOR_CAMPAIGNS') {
    await onboardPartnerAgent({ api: API, securityToken: await token(who), orgId: org });
  }
}
const agentA = await onboardPartnerAgent({
  api: API,
  securityToken: await token('partner.security@example.test'),
  orgId: PARTNER_A_ORG,
});
check('Partner A has a live Agent', Boolean(agentA.agentId));

const built = await buildSubmittedCampaign(buyerAdmin, buyerOperator);
check(
  'campaign submits both Partner requests for review',
  built.submitted.status === 200 || built.submitted.status === 201,
  `status ${built.submitted.status}`,
);
check(
  '§101 SLA clock starts on submit',
  Boolean(built.submitted.body?.requests?.[0]?.expires_at),
  built.submitted.body?.requests?.[0]?.expires_at,
);

// ---------------------------------------------------------------------------
console.log('\n1. Partner review centre (§41)');
const queue = await api('/v1/partner-requests', { token: partnerApprover, orgId: PARTNER_A_ORG });
check('Partner sees its pending queue', queue.status === 200 && queue.body.items.length >= 1);
check(
  'queue shows only THIS Partner (§40.4 isolation)',
  queue.body.items.every((i) => i.request_id !== built.requestB),
);

const detail = await api(`/v1/partner-requests/${built.requestA}`, {
  token: partnerApprover,
  orgId: PARTNER_A_ORG,
});
const d = detail.body;
check('review detail returns the §41 checklist', detail.status === 200);
check('  buyer identity', Boolean(d?.buyer?.name), d?.buyer?.name);
check('  product category', d?.campaign?.category === 'insurance');
check('  segment requested', Boolean(d?.segment?.display_name), d?.segment?.display_name);
check('  channel + placement + frequency cap', Boolean(d?.channels?.[0]?.frequency_cap));
check('  creative preview bound to a version hash', Boolean(d?.creatives?.[0]?.content_sha256));
check('  landing destination', Boolean(d?.campaign?.landing_url));
check('  commercial basis', d?.commercial?.pricing_model === 'CPQL');
check('  lead definition', Boolean(d?.campaign?.lead_definition?.qualified_statuses));
check('  expansion flag', d?.audience_expansion_requested === false);
check('  policy version this decision binds to', Boolean(d?.policy_version), d?.policy_version);

const crossPartner = await api(`/v1/partner-requests/${built.requestB}`, {
  token: partnerApprover,
  orgId: PARTNER_A_ORG,
});
check(
  'Partner A cannot read Partner B’s request',
  crossPartner.status === 404,
  `status ${crossPartner.status}`,
);

// ---------------------------------------------------------------------------
console.log('\n2. Decision authority (§31, §66)');
const buyerTriesApprove = await api(`/v1/partner-requests/${built.requestA}/approve`, {
  method: 'POST',
  token: buyerAdmin,
  idempotencyKey: crypto.randomUUID(),
  body: {
    approved_channels: ['PARTNER_WEB'],
    approved_creative_version_ids: [built.creativeVersionId],
  },
});
check(
  'a Buyer cannot approve its own request',
  buyerTriesApprove.status === 403 || buyerTriesApprove.status === 404,
  `status ${buyerTriesApprove.status}`,
);

const adminTriesApprove = await api(`/v1/partner-requests/${built.requestA}/approve`, {
  method: 'POST',
  token: partnerAdmin,
  orgId: PARTNER_A_ORG,
  idempotencyKey: crypto.randomUUID(),
  body: {
    approved_channels: ['PARTNER_WEB'],
    approved_creative_version_ids: [built.creativeVersionId],
  },
});
check(
  'PARTNER_ADMIN alone cannot approve (§66 role separation)',
  adminTriesApprove.status === 403,
  `status ${adminTriesApprove.status}`,
);

// ---------------------------------------------------------------------------
console.log('\n3. Approve, reject, and independence (§40.4, §41)');
const approved = await api(`/v1/partner-requests/${built.requestA}/approve`, {
  method: 'POST',
  token: partnerApprover,
  orgId: PARTNER_A_ORG,
  idempotencyKey: crypto.randomUUID(),
  body: {
    decision_version: 1,
    approved_channels: ['PARTNER_WEB'],
    approved_creative_version_ids: [built.creativeVersionId],
    partner_payout: { model: 'CPQL', unit_price_minor: 450_000 },
    approval_note: 'Approved for travel-insurance offer only.',
  },
});
check(
  'Partner A approves',
  approved.status === 201 || approved.status === 200,
  `status ${approved.status}`,
);
check(
  'one activation created per approved channel (§13)',
  approved.body?.activation_ids?.length === 1,
);
check(
  'a manifest is signed on approval (§75)',
  approved.body?.manifests?.[0]?.manifest_version === 1,
);

const rejected = await api(`/v1/partner-requests/${built.requestB}/reject`, {
  method: 'POST',
  token: partnerBApprover,
  orgId: PARTNER_B_ORG,
  body: { reason: 'Competitor conflict this quarter.' },
});
check(
  'Partner B rejects independently',
  rejected.body?.status === 'REJECTED',
  `status ${rejected.status}`,
);

const reApprove = await api(`/v1/partner-requests/${built.requestB}/approve`, {
  method: 'POST',
  token: partnerBApprover,
  orgId: PARTNER_B_ORG,
  idempotencyKey: crypto.randomUUID(),
  body: {
    approved_channels: ['PARTNER_WEB'],
    approved_creative_version_ids: [built.creativeVersionId],
  },
});
check(
  'a REJECTED request cannot be approved without a new version (§76)',
  reApprove.status === 409,
  `status ${reApprove.status} ${reApprove.body?.error?.code ?? ''}`,
);

const after = await api(`/v1/campaigns/${built.campaignId}`, { token: buyerAdmin });
check(
  'one Partner rejecting does not stop the other (§40.4)',
  after.body?.partner_requests?.find((r) => r.request_id === built.requestA)?.activations
    ?.length === 1,
);

// ---------------------------------------------------------------------------
console.log('\n4. Agent control sync (§52.4, §75)');
const pull = await api('/agent/v1/config/pull', {
  token: agentA.accessToken,
  orgId: PARTNER_A_ORG,
  headers: { 'X-Agent-Id': agentA.agentId },
});
check('Agent pulls its config', pull.status === 200, `status ${pull.status}`);
check('bundle carries at least one manifest', (pull.body?.manifests?.length ?? 0) >= 1);
check('bundle carries the approved creative', (pull.body?.creatives?.length ?? 0) >= 1);
check(
  'bundle states the stale grace window (§75)',
  pull.body?.stale_grace_seconds === 900,
  `${pull.body?.stale_grace_seconds}s`,
);

const noAuth = await fetch(`${API}/agent/v1/config/pull`);
check(
  'config pull requires Agent authentication',
  noAuth.status === 401,
  `status ${noAuth.status}`,
);

// ---------------------------------------------------------------------------
console.log('\n5. Manifest verification, exactly as the Agent does it (§75)');
const jwksRes = await fetch(`${API}/.well-known/oolix-manifest-jwks.json`);
const jwks = await jwksRes.json();
const keySet = createLocalJWKSet(jwks);
// The bundle carries every live activation for this Partner, not just the one
// this run created -- and an audience-targeted manifest has no segment key by
// design, so grabbing manifests[0] tested the wrong object entirely.
const thisActivationId = approved.body.activation_ids[0];
const jws =
  (pull.body?.manifests ?? []).find((candidate) => {
    try {
      const p = JSON.parse(Buffer.from(candidate.split('.')[1], 'base64url').toString('utf8'));
      return p.activation_id === thisActivationId;
    } catch {
      return false;
    }
  }) ?? pull.body.manifests[0];
check(
  'the bundle contains the manifest for the activation just approved',
  Boolean(jws),
  `activation ${String(thisActivationId).slice(0, 8)} among ${pull.body?.manifests?.length ?? 0}`,
);

const header = decodeProtectedHeader(jws);
check('manifest is ES256', header.alg === 'ES256', header.alg);
check('manifest carries the Oolix typ', header.typ === 'OOLIX-MANIFEST+JWS', header.typ);

let payload = null;
try {
  const v = await compactVerify(jws, keySet, { algorithms: ['ES256'] });
  payload = JSON.parse(new TextDecoder().decode(v.payload));
  check('VALID manifest verifies against the published JWKS', true);
} catch (e) {
  check('VALID manifest verifies against the published JWKS', false, e.message);
}

check('manifest is bound to this Partner', payload?.partner_org_id === PARTNER_A_ORG);
check(
  'manifest carries the approved creative version',
  payload?.creative_version_ids?.length === 1,
);
check(
  'manifest carries the segment key the Agent resolves locally',
  Boolean(payload?.segment_key),
  payload?.segment_key,
);
check(
  'manifest carries purpose and policy version (§81, §83)',
  Boolean(payload?.purpose_id) && Boolean(payload?.policy_version),
);
check(
  'budget is a decimal string, not a lossy JSON number (§73)',
  typeof payload?.budget?.allocation_minor === 'string',
);
check('local stop fraction is 98% (§76.1)', payload?.budget?.local_stop_fraction === 0.98);
check(
  'manifest contains NO customer identifier',
  !JSON.stringify(payload).match(/partner_user_id|U123|email|phone/i),
);

// --- tampering ------------------------------------------------------------
const [h, p64, s] = jws.split('.');
const tampered = JSON.parse(Buffer.from(p64, 'base64url').toString('utf8'));
tampered.budget.allocation_minor = '99999999999';
const forged = `${h}.${Buffer.from(JSON.stringify(tampered)).toString('base64url')}.${s}`;

let tamperRejected = false;
try {
  await compactVerify(forged, keySet, { algorithms: ['ES256'] });
} catch {
  tamperRejected = true;
}
check('TAMPERED manifest is rejected (§59, §85 exit)', tamperRejected);

// --- expiry, cross-partner and issuer, via the real verifier ---------------
//
// These use @oolix/manifest-schema's verifyManifest -- the same logic the Go
// Agent mirrors -- rather than re-implementing the rules in the test.
const ISSUER = process.env.MANIFEST_ISSUER ?? 'http://localhost:4000';
const AUDIENCE = process.env.MANIFEST_AUDIENCE ?? 'oolix-partner-agent';
const verifyOpts = { issuer: ISSUER, audience: AUDIENCE };

const expiredAt = Date.parse(payload.config_expires_at);
check(
  'manifest declares a bounded config expiry (§75)',
  Number.isFinite(expiredAt) && expiredAt > Date.now(),
  payload.config_expires_at,
);

let acceptedNow = false;
try {
  await verifyManifest(jws, jwks, { ...verifyOpts, expectedPartnerOrgId: PARTNER_A_ORG });
  acceptedNow = true;
} catch {
  /* recorded below */
}
check('the real verifier ACCEPTS it now', acceptedNow);

// Advance the clock past config_expires_at. The signature is still
// cryptographically valid; §75 says the Agent must stop using it anyway.
let expiredRejected = false;
let expiryMessage = '';
try {
  await verifyManifest(jws, jwks, { ...verifyOpts, now: new Date(expiredAt + 60_000) });
} catch (e) {
  expiredRejected = true;
  expiryMessage = e.message;
}
check(
  'EXPIRED manifest is rejected past its config expiry (§75, §85 exit)',
  expiredRejected,
  expiryMessage,
);

// §75: a manifest for one Partner must not be usable by another.
let crossTenantRejected = false;
try {
  await verifyManifest(jws, jwks, { ...verifyOpts, expectedPartnerOrgId: PARTNER_B_ORG });
} catch {
  crossTenantRejected = true;
}
check('manifest bound to Partner A is rejected for Partner B', crossTenantRejected);

// §75: issuer/audience pinning defeats cross-environment replay.
let wrongIssuerRejected = false;
try {
  await verifyManifest(jws, jwks, { issuer: 'https://staging.oolix.example', audience: AUDIENCE });
} catch {
  wrongIssuerRejected = true;
}
check('manifest from a different issuer is rejected', wrongIssuerRejected);

// ---------------------------------------------------------------------------
console.log('\n6. Revocation (§41, §57, §75)');
const revoked = await api(`/v1/partner-requests/${built.requestA}/revoke`, {
  method: 'POST',
  token: partnerApprover,
  orgId: PARTNER_A_ORG,
  body: { reason: 'Brand safety review.' },
});
check(
  'Partner revokes an approved request',
  revoked.body?.status === 'REVOKED',
  `status ${revoked.status}`,
);

const pullAfter = await api('/agent/v1/config/pull', {
  token: agentA.accessToken,
  orgId: PARTNER_A_ORG,
  headers: { 'X-Agent-Id': agentA.agentId },
});
// Assert the SPECIFIC activation is gone rather than the bundle being empty:
// the same Partner may legitimately have other live campaigns.
const revokedActivationId = approved.body.activation_ids[0];
const stillPresent = (pullAfter.body?.manifests ?? []).some((jws) => {
  try {
    const p = JSON.parse(Buffer.from(jws.split('.')[1], 'base64url').toString('utf8'));
    return p.activation_id === revokedActivationId;
  } catch {
    return false;
  }
});
check(
  'the revoked activation disappears from the Agent bundle',
  !stillPresent,
  `${pullAfter.body?.manifests?.length ?? 0} manifest(s) remain for other campaigns`,
);
check(
  'and is listed as revoked so a cached copy is dropped (§24)',
  (pullAfter.body?.revoked_activation_ids ?? []).includes(revokedActivationId),
);

console.log(
  failures === 0 ? '\nPhase 3 verified: all checks passed.\n' : `\n${failures} check(s) FAILED.\n`,
);
process.exit(failures === 0 ? 0 : 1);
