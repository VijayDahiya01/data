#!/usr/bin/env node
/**
 * Cross-tenant probes, from inside a valid session.
 *
 * `pen-probe.mjs` asks what a stranger can reach. This asks the harder
 * question: what can somebody reach who has a perfectly good token for a
 * DIFFERENT organization. That is the realistic breach -- a real Buyer, a real
 * Partner, or a stolen session, walking sideways into somebody else's data.
 *
 * It is deliberately outside the application. The integration suite asserts
 * the same isolation using the app's own helpers and fixtures, which shares
 * assumptions with the code under test; this drives real HTTP with real tokens
 * and guesses at real identifiers pulled from the database.
 *
 * Every request here SHOULD fail. A 200 is the finding.
 *
 *   node scripts/pen-probe-authed.mjs
 *
 * Local only: it needs the password grant, which production disables.
 */
import pg from 'pg';
import { seedToken } from './lib/onboard-partner.mjs';

const API = process.env.API_PUBLIC_URL ?? 'http://localhost:4000';
const DB =
  process.env.DATABASE_URL ?? 'postgresql://oolix:oolix@localhost:5432/oolix?schema=public';

const BUYER_ORG = '11111111-1111-4111-8111-111111111111';
const PARTNER_A = '22222222-2222-4222-8222-222222222222';
const PARTNER_B = '33333333-3333-4333-8333-333333333333';

let failures = 0;
const results = [];

function record(name, severity, passed, detail) {
  results.push({ name, severity, passed, detail });
  if (!passed) failures += 1;
}

async function api(path, { token, orgId, method = 'GET', body } = {}) {
  const res = await fetch(API + path, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(orgId ? { 'X-Org-Id': orgId } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
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
  return { status: res.status, body: json, text };
}

/** A refusal, a 404, or an empty result. Anything else leaked something. */
function refused(r) {
  if (r.status === 401 || r.status === 403 || r.status === 404) return true;
  if (r.status === 429) return null; // inconclusive: never reached the guard
  if (r.status >= 500) return false;
  // A 200 that returns nothing is also a refusal -- scoping by org rather
  // than erroring is a legitimate design.
  const b = r.body;
  if (b && Array.isArray(b.items) && b.items.length === 0) return true;
  if (b && Array.isArray(b) && b.length === 0) return true;
  return false;
}

function verdict(name, severity, r, note = '') {
  const ok = refused(r);
  if (ok === null) {
    record(name, severity, false, 'INCONCLUSIVE: rate limited before the guard was reached');
    return;
  }
  record(name, severity, ok, ok ? `refused with ${r.status}` : `LEAKED with ${r.status} ${note}`);
}

/**
 * Wait out a rate-limit window before starting.
 *
 * The anonymous probe suite deliberately floods the per-IP budget, so running
 * this straight afterwards would report a wall of INCONCLUSIVE -- honest, and
 * useless. The limit is a rolling 60-second window (§94), so waiting once at
 * the start is enough, and it is far better than reporting nothing twice.
 */
async function waitOutAnyThrottle() {
  const r = await fetch(`${API}/v1/me/context`);
  if (r.status !== 429) return;

  // A FULL window, not a poll for the first free slot. §94's limit is a
  // rolling 60 seconds, so the moment one slot frees there is still almost no
  // headroom -- and this suite makes roughly twenty requests.
  console.log('  (rate limited from a previous run; waiting 65s for the window to clear)');
  await new Promise((resolve) => setTimeout(resolve, 65_000));
}

await waitOutAnyThrottle();

const db = new pg.Client({ connectionString: DB });
await db.connect();

console.log("\nCross-tenant probes -- a valid token, someone else's data\n");

try {
  const buyer = await seedToken('buyer.admin@example.test');
  const partnerA = await seedToken('partner.admin@example.test');
  const partnerB = await seedToken('partnerb.admin@example.test');
  const approverA = await seedToken('partner.approver@example.test');

  // Real identifiers, pulled from the database rather than invented. Guessing
  // a uuid is not the threat; holding one from a shared document, a support
  // ticket or a URL is.
  const ids = {};
  const q = async (key, sql, params = []) => {
    const r = await db.query(sql, params);
    ids[key] = r.rows[0]?.id ?? null;
  };
  await q(
    'campaignBuyer',
    `SELECT id FROM campaigns WHERE buyer_org_id=$1 ORDER BY created_at DESC LIMIT 1`,
    [BUYER_ORG],
  );
  await q(
    'segmentA',
    `SELECT id FROM segments WHERE partner_org_id=$1 ORDER BY created_at DESC LIMIT 1`,
    [PARTNER_A],
  );
  await q(
    'segmentB',
    `SELECT id FROM segments WHERE partner_org_id=$1 ORDER BY created_at DESC LIMIT 1`,
    [PARTNER_B],
  );
  await q(
    'requestA',
    `SELECT id FROM partner_requests WHERE partner_org_id=$1 ORDER BY created_at DESC LIMIT 1`,
    [PARTNER_A],
  );
  await q('agentA', `SELECT id FROM agents WHERE partner_org_id=$1 LIMIT 1`, [PARTNER_A]);
  await q('placementA', `SELECT id FROM placements WHERE partner_org_id=$1 LIMIT 1`, [PARTNER_A]);

  console.log(
    `  (probing with real ids: ${Object.entries(ids).filter(([, v]) => v).length} found)\n`,
  );

  // -------------------------------------------------------------------------
  console.log('1. One Partner reaching another Partner');

  if (ids.segmentA) {
    // Partner B holds a valid token and a real id belonging to Partner A.
    verdict(
      "Partner B cannot read Partner A's segment",
      'critical',
      await api(`/v1/partner/segments/${ids.segmentA}`, { token: partnerB, orgId: PARTNER_B }),
    );
    // And cannot reach it by claiming to be Partner A in the header.
    verdict(
      "Partner B cannot borrow Partner A's org id in a header",
      'critical',
      await api(`/v1/partner/segments/${ids.segmentA}`, { token: partnerB, orgId: PARTNER_A }),
    );
  }

  if (ids.requestA) {
    verdict(
      "Partner B cannot read Partner A's approval request",
      'critical',
      await api(`/v1/partner-requests/${ids.requestA}`, { token: partnerB, orgId: PARTNER_B }),
    );
    // The one that would be theft: approving another Partner's request.
    verdict(
      "Partner B cannot DECIDE on Partner A's request",
      'critical',
      await api(`/v1/partner-requests/${ids.requestA}/approve`, {
        token: partnerB,
        orgId: PARTNER_B,
        method: 'POST',
        body: {
          decision_version: 1,
          approved_channels: ['PARTNER_WEB'],
          approved_creative_version_ids: [],
        },
      }),
    );
  }

  if (ids.agentA) {
    // Revoking a competitor's Agent stops them serving entirely.
    verdict(
      "Partner B cannot revoke Partner A's Agent",
      'critical',
      await api(`/v1/partner/agents/${ids.agentA}/revoke`, {
        token: partnerB,
        orgId: PARTNER_B,
        method: 'POST',
        body: { reason: 'probe' },
      }),
    );
  }

  if (ids.placementA) {
    verdict(
      "Partner B cannot read Partner A's placement",
      'high',
      await api(`/v1/partner/placements/${ids.placementA}`, { token: partnerB, orgId: PARTNER_B }),
    );
  }

  // -------------------------------------------------------------------------
  console.log('\n2. A Buyer reaching Partner-side data');

  verdict(
    'a Buyer cannot list Partner segments',
    'critical',
    await api('/v1/partner/segments', { token: buyer, orgId: BUYER_ORG }),
  );
  verdict(
    'a Buyer cannot read a Partner policy',
    'critical',
    await api('/v1/partner/policies', { token: buyer, orgId: BUYER_ORG }),
  );
  verdict(
    'a Buyer cannot mint a Partner Agent bootstrap token',
    'critical',
    await api('/v1/partner/agents/bootstrap-tokens', {
      token: buyer,
      orgId: BUYER_ORG,
      method: 'POST',
      body: {},
    }),
  );
  verdict(
    'a Buyer cannot switch org context to a Partner they do not belong to',
    'critical',
    await api('/v1/me/context', { token: buyer, orgId: PARTNER_A }),
  );

  // -------------------------------------------------------------------------
  console.log('\n3. A Partner reaching Buyer-side data');

  if (ids.campaignBuyer) {
    verdict(
      "a Partner cannot read the Buyer's full campaign",
      'critical',
      await api(`/v1/campaigns/${ids.campaignBuyer}`, { token: partnerA, orgId: PARTNER_A }),
    );
    verdict(
      "a Partner cannot edit the Buyer's campaign",
      'critical',
      await api(`/v1/campaigns/${ids.campaignBuyer}`, {
        token: partnerA,
        orgId: PARTNER_A,
        method: 'PATCH',
        body: { name: 'owned' },
      }),
    );
  }
  verdict(
    "a Partner cannot read the Buyer's invoices",
    'critical',
    await api('/v1/billing/invoices', { token: partnerA, orgId: BUYER_ORG }),
  );

  // -------------------------------------------------------------------------
  console.log('\n4. Role boundaries inside one organization (§66)');

  // The approver is deliberately not a security admin: §66 separates the
  // commercial decision from the ability to change infrastructure.
  verdict(
    'a campaign approver cannot mint an Agent bootstrap token',
    'high',
    await api('/v1/partner/agents/bootstrap-tokens', {
      token: approverA,
      orgId: PARTNER_A,
      method: 'POST',
      body: {},
    }),
  );
  verdict(
    'a campaign approver cannot change the Partner policy',
    'high',
    await api('/v1/partner/policies', {
      token: approverA,
      orgId: PARTNER_A,
      method: 'POST',
      body: { allowed_categories: ['anything'] },
    }),
  );

  // -------------------------------------------------------------------------
  console.log("\n5. The product's central claim (§54, §73)");

  // Not authorization: whether the API can be made to return a CUSTOMER
  // identifier at all, from a session entitled to see everything it can.
  //
  // The caller's own account is not that. /v1/me/context returns the signed-in
  // user's email because the portal has to say who is signed in, and §54/§73
  // is about the Data Partner's customers -- people Oolix never learns about.
  // An earlier version of this probe flagged the operator's own address and
  // called it a leak, which is the kind of finding that trains people to
  // ignore a report.
  const surfaces = [
    '/v1/me/context',
    '/v1/campaigns',
    '/v1/audiences',
    '/v1/partner/segments',
    '/v1/partner/readiness',
    '/v1/catalogue/segments',
  ];
  const ownAccounts = [
    'buyer.admin@example.test',
    'partner.admin@example.test',
    'partnerb.admin@example.test',
    'partner.approver@example.test',
  ];

  let leaked = null;
  for (const path of surfaces) {
    const token = path.startsWith('/v1/partner') ? partnerA : buyer;
    const org = path.startsWith('/v1/partner') ? PARTNER_A : BUYER_ORG;
    const r = await api(path, { token, orgId: org });
    if (r.status !== 200) continue;

    // Strip the caller's own identity before looking for anyone else's.
    let text = r.text;
    for (const own of ownAccounts) text = text.split(own).join('<self>');

    // A customer identifier, in any of the shapes it could take.
    if (/partner_user_id|customer_id|"msisdn"|phone_e164|"email"\s*:\s*"[^"]+@/i.test(text)) {
      leaked = path;
      break;
    }
  }
  record(
    'no authenticated surface returns a CUSTOMER identifier',
    'critical',
    leaked === null,
    leaked ? `LEAKED from ${leaked}` : `checked ${surfaces.length} surfaces`,
  );
} finally {
  await db.end();
}

// ---------------------------------------------------------------------------
const order = { critical: 0, high: 1, medium: 2, low: 3 };
results.sort((a, b) => order[a.severity] - order[b.severity]);

console.log('');
for (const r of results) {
  if (!r.passed) console.log(`  [FAIL] ${r.severity.padEnd(8)} ${r.name}\n           ${r.detail}`);
}
console.log(`\n${results.length - failures}/${results.length} cross-tenant probes passed`);
if (failures > 0) {
  console.log("A FAIL here means one tenant can reach another tenant's data.\n");
  process.exit(1);
}
console.log('');
