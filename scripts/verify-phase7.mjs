#!/usr/bin/env node
/**
 * Phase 7 exit criterion (spec v5 §85):
 *   "Pilot settlement reproducible."
 *
 * §102 gives exact worked arithmetic, so this checks the implementation
 * against those literal figures rather than against itself:
 *
 *   CPQL INR 4,500 x 100 qualified  = INR 450,000 media
 *   platform fee 10%                = INR  45,000
 *   Buyer invoice subtotal          = INR 495,000
 *   Partner payout basis            = INR 450,000
 *   §102.2 dispute 100 -> 98        = INR 441,000
 *
 * Then it proves reproducibility (§50) and that a correction APPENDS an
 * adjustment rather than editing history (§83.1).
 *
 * Usage: node scripts/verify-phase7.mjs
 */
import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { seedToken, onboardPartnerAgent } from './lib/onboard-partner.mjs';

const API = process.env.API_PUBLIC_URL ?? 'http://localhost:4000';

const BUYER_ORG = '11111111-1111-4111-8111-111111111111';
const PARTNER_A_ORG = '22222222-2222-4222-8222-222222222222';
const BRAND = '66666666-6666-4666-8666-666666666666';

const OOLIX_DB =
  process.env.DATABASE_URL ?? 'postgresql://oolix:oolix@localhost:5432/oolix?schema=public';

// §102 figures, in minor units (paise).
const CPQL_UNIT_MINOR = 450_000; // INR 4,500
const QUALIFIED_LEADS = 100;
const EXPECTED_MEDIA = 45_000_000; // INR 450,000
const EXPECTED_FEE = 4_500_000; // INR  45,000  (10%)
const EXPECTED_SUBTOTAL = 49_500_000; // INR 495,000
const CORRECTED_LEADS = 98;
const EXPECTED_CORRECTED = 44_100_000; // INR 441,000

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

const inr = (minor) => `INR ${(minor / 100).toLocaleString('en-IN')}`;

const oolix = new pg.Client({ connectionString: OOLIX_DB });
await oolix.connect();

console.log('\nPhase 7 verification -- Billing and payout (spec §85, §102)\n');

try {
  // -------------------------------------------------------------------------
  console.log('0. Setup: an approved activation with 100 qualified leads');
  const buyerAdmin = await seedToken('buyer.admin@example.test');
  const buyerOperator = await seedToken('buyer.operator@example.test');
  const approverA = await seedToken('partner.approver@example.test');
  const finance = await seedToken('finance@example.test');
  const partnerAdmin = await seedToken('partner.admin@example.test');

  // Billing is hidden for the starter set and answers 404 unless the API runs
  // with FEATURE_BILLING_ENABLED=true. Say so and stop, rather than report a
  // wall of failures about a feature that is deliberately off.
  const billing = await api('/v1/billing/payouts', { token: finance });
  if (billing.status === 404) {
    console.log('  SKIPPED  billing is switched off (FEATURE_BILLING_ENABLED=false on the API)\n');
    await oolix.end();
    process.exit(0);
  }

  const r = await api('/v1/partner/readiness', {
    token: await seedToken('partner.security@example.test'),
    orgId: PARTNER_A_ORG,
  });
  if (r.body?.readiness !== 'READY_FOR_CAMPAIGNS') {
    await onboardPartnerAgent({
      api: API,
      securityToken: await seedToken('partner.security@example.test'),
      orgId: PARTNER_A_ORG,
    });
  }

  const campaign = await api('/v1/campaigns', {
    method: 'POST',
    token: buyerAdmin,
    idempotencyKey: randomUUID(),
    body: {
      name: `Settlement ${Date.now()}`,
      objective: 'QUALIFIED_LEADS',
      brand_id: BRAND,
      category: 'insurance',
      purpose_id: 'travel_insurance_offer',
      // §102: maximum campaign budget INR 500,000.
      budget: { amount_minor: 50_000_000, currency: 'INR' },
      start_at: new Date(Date.now() - 3_600_000).toISOString(),
      end_at: new Date(Date.now() + 60 * 86_400_000).toISOString(),
      geographies: ['IN'],
      landing_url: 'https://insurance.example/quote',
      lead_definition: { qualified_statuses: ['QUALIFIED'], duplicate_window_days: 30 },
    },
  });
  const campaignId = campaign.body.id;

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

  // Searched by name: the listing is capped and accumulated test segments
  // otherwise push the seeded one off the page.
  const cat = await api('/v1/catalogue/segments?query=Recent%20Travellers', {
    token: buyerAdmin,
  });
  const seg = cat.body.items.find((i) => i.display_name === 'Recent Travellers');
  if (!seg) {
    throw new Error('seeded catalogue segment is not discoverable -- is the seed loaded?');
  }
  const det = await api(`/v1/catalogue/segments/${seg.segment_id}`, { token: buyerAdmin });

  const req = await api(`/v1/campaigns/${campaignId}/partner-requests`, {
    method: 'POST',
    token: buyerAdmin,
    body: {
      partner_org_id: PARTNER_A_ORG,
      segment_id: seg.segment_id,
      channels: [
        {
          channel: 'PARTNER_WEB',
          placement_ids: [det.body.placements[0].placement_id],
          allocation_minor: 50_000_000,
          frequency_cap: { max_impressions: 2, window: 'P1D' },
        },
      ],
      creative_version_ids: [session.body.creative_version_id],
      // §102: CPQL at INR 4,500.
      partner_payout: { model: 'CPQL', unit_price_minor: CPQL_UNIT_MINOR },
    },
  });

  await api(`/v1/campaigns/${campaignId}/submit`, {
    method: 'POST',
    token: buyerAdmin,
    idempotencyKey: randomUUID(),
  });
  const approved = await api(`/v1/partner-requests/${req.body.request_id}/approve`, {
    method: 'POST',
    token: approverA,
    orgId: PARTNER_A_ORG,
    idempotencyKey: randomUUID(),
    body: {
      approved_channels: ['PARTNER_WEB'],
      approved_creative_version_ids: [session.body.creative_version_id],
      partner_payout: { model: 'CPQL', unit_price_minor: CPQL_UNIT_MINOR },
    },
  });
  const activationId = approved.body.activation_ids[0];
  check(
    'activation approved with CPQL terms',
    Boolean(activationId),
    `unit ${inr(CPQL_UNIT_MINOR)}`,
  );

  // Plant exactly 100 QUALIFIED attribution tokens.
  //
  // Written directly because generating 100 real ad decisions would take the
  // frequency cap into account and is not what this phase is testing; the
  // outcome-state shape is identical to what the Agent and CRM produce.
  const periodStart = new Date(Date.now() - 86_400_000);
  const periodEnd = new Date(Date.now() + 86_400_000);
  await oolix.query(`DELETE FROM attribution_tokens WHERE activation_id = $1`, [activationId]);
  for (let i = 0; i < QUALIFIED_LEADS; i += 1) {
    await oolix.query(
      `INSERT INTO attribution_tokens
         (token_hash, activation_id, partner_org_id, issued_at, expires_at, lead_state)
       VALUES (decode($1,'hex'), $2, $3, NOW(), NOW() + INTERVAL '7 days', 'QUALIFIED')`,
      [
        createHash('sha256').update(`settle-${activationId}-${i}`).digest('hex'),
        activationId,
        PARTNER_A_ORG,
      ],
    );
  }
  check(`planted ${QUALIFIED_LEADS} QUALIFIED leads`, true);

  // -------------------------------------------------------------------------
  console.log('\n1. §102 settlement arithmetic');
  const calc = await api('/v1/billing/payouts/calculate', {
    method: 'POST',
    token: finance,
    idempotencyKey: randomUUID(),
    body: {
      activation_id: activationId,
      period_start: periodStart.toISOString(),
      period_end: periodEnd.toISOString(),
    },
  });
  check('payout calculated', calc.status === 201 || calc.status === 200, `status ${calc.status}`);

  const s = calc.body?.settlement;
  check(
    'payable count is the verified qualified count',
    s?.payable_count === QUALIFIED_LEADS,
    `${s?.payable_count}`,
  );
  check(
    `media amount = ${inr(EXPECTED_MEDIA)} (§102)`,
    s?.media_amount_minor === EXPECTED_MEDIA,
    inr(s?.media_amount_minor ?? 0),
  );
  check(
    `platform fee = ${inr(EXPECTED_FEE)} (10%)`,
    s?.platform_fee_minor === EXPECTED_FEE,
    inr(s?.platform_fee_minor ?? 0),
  );
  check(
    `Buyer invoice subtotal = ${inr(EXPECTED_SUBTOTAL)}`,
    s?.invoice_subtotal_minor === EXPECTED_SUBTOTAL,
    inr(s?.invoice_subtotal_minor ?? 0),
  );
  check(
    `Partner payout basis = ${inr(EXPECTED_MEDIA)}`,
    s?.partner_payout_basis_minor === EXPECTED_MEDIA,
    inr(s?.partner_payout_basis_minor ?? 0),
  );
  check(
    'settlement is flagged as outcome-verified (§50)',
    s?.settles_on_verified_outcomes === true,
  );

  // -------------------------------------------------------------------------
  console.log('\n2. Immutable FinancialEvents (§50, §73)');
  const { rows: events } = await oolix.query(
    `SELECT event_type, quantity, amount_minor, source_ref
       FROM financial_events WHERE activation_id = $1 ORDER BY event_type`,
    [activationId],
  );
  check('FinancialEvents were written', events.length >= 3, `${events.length} events`);
  check(
    'OUTCOME_ACCRUAL records the media amount',
    events.some(
      (e) => e.event_type === 'OUTCOME_ACCRUAL' && Number(e.amount_minor) === EXPECTED_MEDIA,
    ),
  );
  check(
    'PLATFORM_FEE is a SEPARATE event, not netted off',
    events.some((e) => e.event_type === 'PLATFORM_FEE' && Number(e.amount_minor) === EXPECTED_FEE),
  );
  check(
    'PARTNER_PAYOUT_BASIS is recorded distinctly from Buyer spend (§50)',
    events.some(
      (e) => e.event_type === 'PARTNER_PAYOUT_BASIS' && Number(e.amount_minor) === EXPECTED_MEDIA,
    ),
  );

  const rerun = await api('/v1/billing/payouts/calculate', {
    method: 'POST',
    token: finance,
    idempotencyKey: randomUUID(),
    body: {
      activation_id: activationId,
      period_start: periodStart.toISOString(),
      period_end: periodEnd.toISOString(),
    },
  });
  const { rows: afterRerun } = await oolix.query(
    `SELECT count(*)::int AS n FROM financial_events WHERE activation_id = $1`,
    [activationId],
  );
  check(
    'recalculating does NOT duplicate accruals',
    afterRerun[0].n === events.length,
    `${events.length} -> ${afterRerun[0].n}`,
  );
  check(
    'and returns the same figure',
    rerun.body?.settlement?.media_amount_minor === EXPECTED_MEDIA,
  );

  const payoutId = calc.body.payout_id;

  // -------------------------------------------------------------------------
  console.log('\n3. Reproducibility (§50 rule 4 -- §85 exit)');
  const repro = await api(`/v1/billing/payouts/${payoutId}/reproduce`, { token: finance });
  check('settlement recomputes from its immutable inputs', repro.body?.reproducible === true);
  check(
    '  and matches the recorded payout basis',
    repro.body?.recomputed?.partner_payout_basis_minor === EXPECTED_MEDIA,
    inr(repro.body?.recomputed?.partner_payout_basis_minor ?? 0),
  );
  check(
    '  the inputs themselves are retained for audit',
    Boolean(repro.body?.inputs?.unit_price_minor),
  );

  // -------------------------------------------------------------------------
  console.log('\n4. Invoice preview (§19)');
  const invoice = await api(`/v1/billing/invoices/preview/${campaignId}`, { token: finance });
  check('invoice preview responds', invoice.status === 200, `status ${invoice.status}`);
  check(
    `media total = ${inr(EXPECTED_MEDIA)}`,
    invoice.body?.totals?.media_minor === EXPECTED_MEDIA,
    inr(invoice.body?.totals?.media_minor ?? 0),
  );
  check(
    `subtotal = ${inr(EXPECTED_SUBTOTAL)}`,
    invoice.body?.totals?.subtotal_minor === EXPECTED_SUBTOTAL,
    inr(invoice.body?.totals?.subtotal_minor ?? 0),
  );
  check(
    `remaining headroom = ${inr(500_000)} (§102)`,
    invoice.body?.remaining_headroom_minor === 500_000,
    inr(invoice.body?.remaining_headroom_minor ?? 0),
  );
  check(
    'tax is present but not assumed for a jurisdiction (§81)',
    invoice.body?.totals?.tax_minor === 0,
  );

  // -------------------------------------------------------------------------
  console.log('\n5. Payout state machine (§76)');
  const badJump = await api(`/v1/billing/payouts/${payoutId}/mark-paid`, {
    method: 'POST',
    token: finance,
    idempotencyKey: randomUUID(),
  });
  check(
    'CALCULATED cannot jump straight to PAID (§76)',
    badJump.status === 409,
    `status ${badJump.status} ${badJump.body?.error?.code ?? ''}`,
  );

  const reviewed = await api(`/v1/billing/payouts/${payoutId}/review`, {
    method: 'POST',
    token: finance,
  });
  check('CALCULATED -> REVIEWED', reviewed.body?.status === 'REVIEWED', reviewed.body?.status);

  const analystTries = await api(`/v1/billing/payouts/${payoutId}/approve`, {
    method: 'POST',
    token: await seedToken('analyst@example.test'),
  });
  check(
    'an ANALYST cannot approve a payout (§66)',
    analystTries.status === 403,
    `status ${analystTries.status}`,
  );

  // -------------------------------------------------------------------------
  console.log('\n6. Dispute and adjustment (§83.1, §102.2, §102.3)');
  const dispute = await api(`/v1/billing/payouts/${payoutId}/dispute`, {
    method: 'POST',
    token: partnerAdmin,
    orgId: PARTNER_A_ORG,
    body: {
      reason_code: 'QUALIFIED_COUNT_DISPUTED',
      reason: 'Two leads were duplicates under the 30-day rule.',
      claimed_qualified_count: CORRECTED_LEADS,
    },
  });
  check('a dispute can be opened', dispute.body?.status === 'DISPUTED', `status ${dispute.status}`);
  check('the payout is held while disputed (§83.1)', dispute.body?.on_hold === true);

  const paidWhileDisputed = await api(`/v1/billing/payouts/${payoutId}/mark-paid`, {
    method: 'POST',
    token: finance,
    idempotencyKey: randomUUID(),
  });
  check(
    'a DISPUTED payout cannot be paid',
    paidWhileDisputed.status === 409,
    `status ${paidWhileDisputed.status}`,
  );

  const resolved = await api(`/v1/billing/payouts/${payoutId}/resolve-dispute`, {
    method: 'POST',
    token: finance,
    body: {
      outcome: 'ADJUSTED',
      corrected_qualified_count: CORRECTED_LEADS,
      resolution_note: 'Two duplicate contacts confirmed and removed from the qualified count.',
    },
  });
  check(
    'dispute resolved as ADJUSTED',
    resolved.body?.status === 'ADJUSTED',
    `status ${resolved.status}`,
  );
  check(
    `corrected basis = ${inr(EXPECTED_CORRECTED)} (§102.3: 98 x INR 4,500)`,
    resolved.body?.corrected_basis_minor === EXPECTED_CORRECTED,
    inr(resolved.body?.corrected_basis_minor ?? 0),
  );
  check(
    `the adjustment is the delta, ${inr(EXPECTED_CORRECTED - EXPECTED_MEDIA)}`,
    resolved.body?.adjustment_minor === EXPECTED_CORRECTED - EXPECTED_MEDIA,
    inr(resolved.body?.adjustment_minor ?? 0),
  );

  const { rows: afterAdjust } = await oolix.query(
    `SELECT event_type, amount_minor FROM financial_events
      WHERE activation_id = $1 ORDER BY created_at`,
    [activationId],
  );
  check(
    'the ORIGINAL accrual is untouched (§83.1)',
    afterAdjust.some(
      (e) => e.event_type === 'OUTCOME_ACCRUAL' && Number(e.amount_minor) === EXPECTED_MEDIA,
    ),
  );
  check(
    'an ADJUSTMENT event was APPENDED rather than history edited (§83.1)',
    afterAdjust.some(
      (e) =>
        e.event_type === 'ADJUSTMENT' &&
        Number(e.amount_minor) === EXPECTED_CORRECTED - EXPECTED_MEDIA,
    ),
  );

  const payouts = await api('/v1/billing/payouts', { token: partnerAdmin, orgId: PARTNER_A_ORG });
  const row = payouts.body?.items?.find((i) => i.payout_id === payoutId);
  check(
    `net payable after adjustment = ${inr(EXPECTED_CORRECTED)}`,
    row?.net_payable_minor === EXPECTED_CORRECTED,
    inr(row?.net_payable_minor ?? 0),
  );
  check(
    'the Partner can audit every contributing event',
    (row?.financial_events?.length ?? 0) >= 4,
    `${row?.financial_events?.length} events`,
  );

  const finalApprove = await api(`/v1/billing/payouts/${payoutId}/approve`, {
    method: 'POST',
    token: finance,
  });
  check(
    'ADJUSTED -> APPROVED (§83.1)',
    finalApprove.body?.status === 'APPROVED',
    finalApprove.body?.status,
  );

  const paid = await api(`/v1/billing/payouts/${payoutId}/mark-paid`, {
    method: 'POST',
    token: finance,
    idempotencyKey: randomUUID(),
  });
  check('APPROVED -> PAID', paid.body?.status === 'PAID', paid.body?.status);

  // -------------------------------------------------------------------------
  console.log('\n7. Settlement never derives from unverified clicks (§50)');
  const { rows: clickDerived } = await oolix.query(
    `SELECT count(*)::int AS n FROM financial_events fe
       WHERE fe.activation_id = $1 AND fe.event_type IN ('OUTCOME_ACCRUAL','PARTNER_PAYOUT_BASIS')
         AND fe.quantity > 0
         AND fe.quantity <> (SELECT count(*) FROM attribution_tokens
                              WHERE activation_id = $1
                                AND lead_state IN ('QUALIFIED','CONVERTED'))`,
    [activationId],
  );
  check(
    'every payable quantity equals the VERIFIED outcome count, not clicks',
    clickDerived[0].n === 0,
    `${clickDerived[0].n} mismatched`,
  );
} finally {
  await oolix.end();
}

console.log(
  failures === 0 ? '\nPhase 7 verified: all checks passed.\n' : `\n${failures} check(s) FAILED.\n`,
);
process.exit(failures === 0 ? 0 : 1);
