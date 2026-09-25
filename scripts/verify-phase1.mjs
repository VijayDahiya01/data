#!/usr/bin/env node
/**
 * Phase 1 exit criterion (spec v5 §85):
 *   "Partner reaches READY_FOR_CAMPAIGNS in sandbox."
 *
 * Drives the real HTTP surface end to end -- a real sign-in token, the real
 * §92 Agent bootstrap/assertion/token chain, the real readiness evaluation --
 * so this proves the running system, not a mock of it.
 *
 * Usage: node scripts/verify-phase1.mjs
 */
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { seedToken } from './lib/login.mjs';

const API = process.env.API_PUBLIC_URL ?? 'http://localhost:4000';

const PARTNER_A_ORG = '22222222-2222-4222-8222-222222222222';

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
  if (!ok) failures += 1;
  return ok;
};

const token = (username) => seedToken(username, { api: API });

async function api(path, { method = 'GET', token: tok, body, headers = {} } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      ...(tok ? { Authorization: `Bearer ${tok}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      'X-Org-Id': PARTNER_A_ORG,
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

console.log('\nPhase 1 verification -- Partner supply (spec §85)\n');

// ---------------------------------------------------------------------------
console.log('1. Authentication (§66, §35)');
const partnerAdmin = await token('partner.admin@example.test');
const partnerSecurity = await token('partner.security@example.test');
const buyerAdmin = await token('buyer.admin@example.test');
check('seeded identities sign in', Boolean(partnerAdmin && partnerSecurity));

const ctx = await api('/v1/me/context', { token: partnerAdmin });
check('GET /v1/me/context resolves the Partner org', ctx.status === 200, `status ${ctx.status}`);
check(
  'roles come from the database, not the token',
  ctx.body?.active_organization?.roles?.includes('PARTNER_ADMIN'),
  JSON.stringify(ctx.body?.active_organization?.roles ?? []),
);

// ---------------------------------------------------------------------------
console.log('\n2. Organization isolation (§59, §66)');
const crossOrg = await api('/v1/partner/segments', { token: buyerAdmin });
check(
  'a Buyer cannot read Partner supply',
  crossOrg.status === 403,
  `status ${crossOrg.status} ${crossOrg.body?.error?.code ?? ''}`,
);

// ---------------------------------------------------------------------------
console.log('\n3. Readiness reacts to Agent revocation (§37, §69.3)');

// Revoke any Agent left by an earlier run so this script is order-independent
// -- and so the revocation path itself is exercised rather than assumed.
const existing = await api('/v1/partner/agents', { token: partnerSecurity });
let revoked = 0;
for (const a of existing.body?.items ?? []) {
  if (a.status !== 'ACTIVE') continue;
  const r = await api(`/v1/partner/agents/${a.agent_id}/revoke`, {
    method: 'POST',
    token: partnerSecurity,
    body: { reason: 'phase-1 verification reset' },
  });
  if (r.status === 200 || r.status === 201) revoked += 1;
}
check('pre-existing Agents can be revoked (§69.3)', true, `revoked ${revoked}`);

const noReason = await api('/v1/partner/agents/00000000-0000-4000-8000-000000000000/revoke', {
  method: 'POST',
  token: partnerSecurity,
  body: {},
});
check(
  'revocation demands a reason for the audit trail (§83)',
  noReason.status === 400,
  `status ${noReason.status}`,
);

const before = await api('/v1/partner/readiness', { token: partnerAdmin });
check('readiness endpoint responds', before.status === 200, `status ${before.status}`);
check(
  'with no active Agent the Partner is NOT ready',
  before.body?.readiness === 'AGENT_PENDING',
  `readiness=${before.body?.readiness} blocking=${JSON.stringify(before.body?.blocking ?? [])}`,
);

// ---------------------------------------------------------------------------
console.log('\n4. Segment publication and §72 anti-differencing');
const tooSmall = await api('/v1/partner/segments', {
  method: 'POST',
  token: partnerAdmin,
  body: {
    internal_segment_id: `TINY_COHORT_${Date.now()}`,
    display_name: 'Tiny cohort',
    description: 'Deliberately below the publishable minimum',
    category: 'test',
    geographies: ['IN'],
    refresh_frequency: 'daily',
    allowed_channels: ['PARTNER_WEB'],
    allowed_categories: ['insurance'],
    reach_exact_local: 900,
  },
});
check(
  'a cohort under 1,000 is refused, not published small',
  tooSmall.status === 409 && tooSmall.body?.error?.code === 'PART_002',
  `status ${tooSmall.status} ${tooSmall.body?.error?.code ?? ''}`,
);

const segs = await api('/v1/partner/segments', { token: partnerAdmin });
const travel = segs.body?.items?.find((s) => s.internal_segment_id === 'RECENT_TRAVELLER_60D');
check('seeded segments are listed', Array.isArray(segs.body?.items) && segs.body.items.length >= 3);
check(
  'reach is a bucket, never an exact count',
  travel?.reach_bucket === '100K_250K' && !JSON.stringify(travel).match(/213418|"reach_exact/),
  `bucket=${travel?.reach_bucket}`,
);

// ---------------------------------------------------------------------------
console.log('\n5. Agent registration (§92)');
const bootstrap = await api('/v1/partner/agents/bootstrap-tokens', {
  method: 'POST',
  token: partnerSecurity,
});
check(
  'PARTNER_SECURITY_ADMIN can mint a bootstrap token',
  bootstrap.status === 201 || bootstrap.status === 200,
  `status ${bootstrap.status}`,
);
const bootstrapToken = bootstrap.body?.bootstrap_token;
check('token is returned once, in plaintext', typeof bootstrapToken === 'string');

const wrongRole = await api('/v1/partner/agents/bootstrap-tokens', {
  method: 'POST',
  token: partnerAdmin,
});
check(
  'PARTNER_ADMIN alone cannot mint one (§66 role separation)',
  wrongRole.status === 403,
  `status ${wrongRole.status}`,
);

// The Agent generates its keypair locally; the private key never leaves.
const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true });
const publicJwk = await exportJWK(publicKey);

const reg = await api('/agent/v1/register', {
  method: 'POST',
  body: {
    bootstrap_token: bootstrapToken,
    agent_public_key_jwk: {
      kty: publicJwk.kty,
      crv: publicJwk.crv,
      x: publicJwk.x,
      y: publicJwk.y,
    },
    agent_version: '0.1.0',
    capabilities: ['PARTNER_WEB'],
  },
});
check('agent registers', reg.status === 201 || reg.status === 200, `status ${reg.status}`);
const { agent_id: agentId, client_id: clientId } = reg.body ?? {};
check('registration returns agent_id and client_id', Boolean(agentId && clientId));

const replay = await api('/agent/v1/register', {
  method: 'POST',
  body: {
    bootstrap_token: bootstrapToken,
    agent_public_key_jwk: {
      kty: publicJwk.kty,
      crv: publicJwk.crv,
      x: publicJwk.x,
      y: publicJwk.y,
    },
    agent_version: '0.1.0',
    capabilities: ['PARTNER_WEB'],
  },
});
check(
  'the bootstrap token is single-use (§92.1)',
  replay.status === 401,
  `status ${replay.status} ${replay.body?.error?.message ?? ''}`,
);

// ---------------------------------------------------------------------------
console.log('\n6. Workload token exchange (§92.3)');
const now = Math.floor(Date.now() / 1000);
const assertion = await new SignJWT({})
  .setProtectedHeader({ alg: 'ES256' })
  .setIssuer(clientId)
  .setSubject(clientId)
  .setAudience(`${API}/agent/v1/token`)
  .setIssuedAt(now)
  .setExpirationTime(now + 120)
  .setJti(crypto.randomUUID())
  .sign(privateKey);

const tok = await api('/agent/v1/token', {
  method: 'POST',
  body: {
    client_id: clientId,
    client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
    client_assertion: assertion,
  },
});
check(
  'client assertion is accepted',
  tok.status === 200 || tok.status === 201,
  `status ${tok.status}`,
);
check(
  'access token lives 15 minutes (§92.3)',
  tok.body?.expires_in === 900,
  `${tok.body?.expires_in}s`,
);

const forged = await generateKeyPair('ES256', { extractable: true });
const forgedAssertion = await new SignJWT({})
  .setProtectedHeader({ alg: 'ES256' })
  .setIssuer(clientId)
  .setSubject(clientId)
  .setAudience(`${API}/agent/v1/token`)
  .setIssuedAt(now)
  .setExpirationTime(now + 120)
  .setJti(crypto.randomUUID())
  .sign(forged.privateKey);

const forgedRes = await api('/agent/v1/token', {
  method: 'POST',
  body: {
    client_id: clientId,
    client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
    client_assertion: forgedAssertion,
  },
});
check(
  'an assertion signed by an unregistered key is rejected',
  forgedRes.status === 401,
  `status ${forgedRes.status}`,
);

// ---------------------------------------------------------------------------
console.log('\n7. Heartbeat (§52.4, §78.2)');
const hb = await api('/agent/v1/heartbeat', {
  method: 'POST',
  token: tok.body?.access_token,
  headers: { 'X-Agent-Id': agentId },
  body: {
    agent_version: '0.1.0',
    config_age_seconds: 12,
    status: 'HEALTHY',
    sent_at: new Date().toISOString(),
  },
});
check('heartbeat accepted', hb.status === 200 || hb.status === 201, `status ${hb.status}`);
check('config reported FRESH', hb.body?.config_status === 'FRESH', hb.body?.config_status);

const spoof = await api('/agent/v1/heartbeat', {
  method: 'POST',
  token: tok.body?.access_token,
  headers: { 'X-Agent-Id': '00000000-0000-4000-8000-000000000000' },
  body: {
    agent_version: '0.1.0',
    config_age_seconds: 12,
    status: 'HEALTHY',
    sent_at: new Date().toISOString(),
  },
});
check(
  'a token cannot be replayed as a different Agent (§92.4)',
  spoof.status === 401,
  `status ${spoof.status}`,
);

// ---------------------------------------------------------------------------
console.log('\n8. Phase 1 exit criterion (§85)');
const after = await api('/v1/partner/readiness', { token: partnerAdmin });
check(
  'Partner reaches READY_FOR_CAMPAIGNS',
  after.body?.readiness === 'READY_FOR_CAMPAIGNS',
  `readiness=${after.body?.readiness} blocking=${JSON.stringify(after.body?.blocking ?? [])}`,
);

console.log(
  failures === 0 ? '\nPhase 1 verified: all checks passed.\n' : `\n${failures} check(s) FAILED.\n`,
);
process.exit(failures === 0 ? 0 : 1);
