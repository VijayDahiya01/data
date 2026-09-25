/**
 * Bring a seeded Partner to READY_FOR_CAMPAIGNS using the REAL §92 flow.
 *
 * The seed cannot do this: readiness requires a registered Agent that has
 * actually sent a heartbeat (§37), and an Agent's identity is a P-256 keypair
 * it generates itself. Fabricating an Agent row in the seed would make
 * readiness a lie -- which is precisely what §37's "derived from observable
 * facts" framing exists to prevent.
 *
 * So the verification scripts stand up a real Agent identity instead. This is
 * the same sequence a Partner performs during onboarding.
 */
import { generateKeyPair, exportJWK, SignJWT } from 'jose';

// Most scripts import sign-in from here, beside the onboarding it precedes.
export { seedToken } from './login.mjs';

/**
 * @param {object} opts
 * @param {string} opts.api            API base URL
 * @param {string} opts.securityToken  access token for a PARTNER_SECURITY_ADMIN
 * @param {string} opts.orgId          the Partner organization id
 * @returns {Promise<{agentId: string, clientId: string, accessToken: string}>}
 */
export async function onboardPartnerAgent({ api, securityToken, orgId }) {
  const call = async (path, { method = 'GET', token, body, headers = {} } = {}) => {
    const res = await fetch(`${api}${path}`, {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        'X-Org-Id': orgId,
        ...headers,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { raw: text };
    }
    if (!res.ok) {
      throw new Error(`${method} ${path} -> ${res.status} ${json?.error?.message ?? text}`);
    }
    return json;
  };

  // 1. §92.1 -- single-use bootstrap token, minted by PARTNER_SECURITY_ADMIN.
  const { bootstrap_token } = await call('/v1/partner/agents/bootstrap-tokens', {
    method: 'POST',
    token: securityToken,
  });

  // 2. §92.2 -- the Agent generates its own keypair. The private key never
  //    leaves what would, in production, be Partner infrastructure.
  const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true });
  const jwk = await exportJWK(publicKey);

  const reg = await call('/agent/v1/register', {
    method: 'POST',
    body: {
      bootstrap_token,
      agent_public_key_jwk: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y },
      agent_version: '0.1.0',
      capabilities: ['PARTNER_WEB'],
    },
  });

  // 3. §92.3 -- prove possession of the private key, receive a 15-minute token.
  const now = Math.floor(Date.now() / 1000);
  const assertion = await new SignJWT({})
    .setProtectedHeader({ alg: 'ES256' })
    .setIssuer(reg.client_id)
    .setSubject(reg.client_id)
    .setAudience(`${api}/agent/v1/token`)
    .setIssuedAt(now)
    .setExpirationTime(now + 120)
    .setJti(crypto.randomUUID())
    .sign(privateKey);

  const tok = await call('/agent/v1/token', {
    method: 'POST',
    body: {
      client_id: reg.client_id,
      client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
      client_assertion: assertion,
    },
  });

  // 4. §52.4 -- registration alone does not satisfy readiness; the Agent must
  //    actually report in.
  await call('/agent/v1/heartbeat', {
    method: 'POST',
    token: tok.access_token,
    headers: { 'X-Agent-Id': reg.agent_id },
    body: {
      agent_version: '0.1.0',
      config_age_seconds: 5,
      status: 'HEALTHY',
      sent_at: new Date().toISOString(),
    },
  });

  return {
    agentId: reg.agent_id,
    clientId: reg.client_id,
    accessToken: tok.access_token,
    privateKey,
  };
}
