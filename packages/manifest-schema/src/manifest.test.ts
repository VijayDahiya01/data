import { describe, it, expect, beforeAll } from 'vitest';
import {
  canonicalJsonStringify,
  generateManifestKeyPair,
  buildJwks,
  signManifest,
  verifyManifest,
  importSigningKey,
  isWithinRotationOverlap,
  type ManifestKeyPair,
  type ManifestPayload,
} from './index.js';

const ISSUER = 'https://api.oolix.example';
const AUDIENCE = 'oolix-partner-agent';
const PARTNER = 'org_partner_a';

function payload(over: Partial<ManifestPayload> = {}): ManifestPayload {
  const now = new Date('2026-09-01T00:00:00Z');
  return {
    manifest_version: 1,
    activation_id: 'act_a_web',
    partner_org_id: PARTNER,
    segment_id: 'seg_recent_travellers',
    segment_key: 'RECENT_TRAVELLER_60D',
    channel: 'PARTNER_WEB',
    placement_ids: ['pl_booking_success'],
    placement_keys: ['booking_success_offer'],
    creative_version_ids: ['crv_10'],
    budget: { allocation_minor: '30000000', currency: 'INR', local_stop_fraction: 0.98 },
    frequency_cap: { max_impressions: 2, window: 'P1D' },
    purpose_id: 'travel_insurance_offer',
    policy_version: 'P-21',
    allowed_categories: ['insurance'],
    blocked_categories: [],
    campaign_category: 'insurance',
    issued_at: now.toISOString(),
    config_expires_at: new Date(now.getTime() + 15 * 60_000).toISOString(),
    start_at: now.toISOString(),
    end_at: new Date('2026-10-31T23:59:59Z').toISOString(),
    approval_reference: 'apr_1',
    audience_expansion_allowed: false,
    ...over,
  };
}

describe('§75 canonical JSON', () => {
  it('sorts keys recursively so both sides sign identical bytes', () => {
    const a = canonicalJsonStringify({ b: 1, a: { z: 1, y: 2 } });
    const b = canonicalJsonStringify({ a: { y: 2, z: 1 }, b: 1 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":{"y":2,"z":1},"b":1}');
  });

  it('preserves array order, which carries meaning', () => {
    expect(canonicalJsonStringify({ p: ['b', 'a'] })).toBe('{"p":["b","a"]}');
  });

  it('omits undefined but keeps explicit null', () => {
    expect(canonicalJsonStringify({ a: undefined, b: null })).toBe('{"b":null}');
  });

  it('refuses a bigint rather than silently losing precision', () => {
    expect(() => canonicalJsonStringify({ budget: 10n })).toThrow(/bigint/);
  });

  it('refuses non-finite numbers rather than emitting null', () => {
    expect(() => canonicalJsonStringify({ x: NaN })).toThrow(/non-finite/);
  });
});

describe('§75 manifest signing and verification', () => {
  let kp: ManifestKeyPair;
  let jwks: { keys: import('jose').JWK[] };
  let signingKey: Awaited<ReturnType<typeof importSigningKey>>;

  beforeAll(async () => {
    kp = await generateManifestKeyPair('manifest-2026-08-1');
    jwks = buildJwks([kp.publicJwk]);
    signingKey = await importSigningKey(kp.privateJwk);
  });

  const at = (iso: string) => ({ now: new Date(iso) });

  it('round-trips a valid manifest', async () => {
    const jws = await signManifest(payload(), signingKey, {
      kid: kp.kid,
      issuer: ISSUER,
      audience: AUDIENCE,
    });
    const v = await verifyManifest(jws, jwks, {
      issuer: ISSUER,
      audience: AUDIENCE,
      expectedPartnerOrgId: PARTNER,
      ...at('2026-09-01T00:05:00Z'),
    });
    expect(v.payload.activation_id).toBe('act_a_web');
    expect(v.kid).toBe('manifest-2026-08-1');
  });

  it('rejects a tampered payload -- §59 "Agent rejects tampered manifest"', async () => {
    const jws = await signManifest(payload(), signingKey, {
      kid: kp.kid,
      issuer: ISSUER,
      audience: AUDIENCE,
    });
    const [h, p, s] = jws.split('.');
    const decoded = JSON.parse(Buffer.from(p!, 'base64url').toString('utf8'));
    decoded.budget.allocation_minor = '99999999999';
    const forged = `${h}.${Buffer.from(JSON.stringify(decoded)).toString('base64url')}.${s}`;

    await expect(
      verifyManifest(forged, jwks, {
        issuer: ISSUER,
        audience: AUDIENCE,
        ...at('2026-09-01T00:05:00Z'),
      }),
    ).rejects.toThrow(/signature verification failed/i);
  });

  it('rejects an expired config -- §75 stale grace is bounded', async () => {
    const jws = await signManifest(payload(), signingKey, {
      kid: kp.kid,
      issuer: ISSUER,
      audience: AUDIENCE,
    });
    await expect(
      verifyManifest(jws, jwks, {
        issuer: ISSUER,
        audience: AUDIENCE,
        ...at('2026-09-01T00:20:00Z'), // config_expires_at was +15m
      }),
    ).rejects.toThrow(/config has expired/i);
  });

  it('stops serving after campaign end even when config is fresh (§24)', async () => {
    const jws = await signManifest(
      payload({
        issued_at: '2026-10-31T23:50:00Z',
        config_expires_at: '2026-11-01T00:05:00Z',
        end_at: '2026-10-31T23:59:59Z',
      }),
      signingKey,
      { kid: kp.kid, issuer: ISSUER, audience: AUDIENCE },
    );
    await expect(
      verifyManifest(jws, jwks, {
        issuer: ISSUER,
        audience: AUDIENCE,
        ...at('2026-11-01T00:00:30Z'),
      }),
    ).rejects.toThrow(/campaign has ended/i);
  });

  it('refuses a manifest bound to another Partner', async () => {
    const jws = await signManifest(payload(), signingKey, {
      kid: kp.kid,
      issuer: ISSUER,
      audience: AUDIENCE,
    });
    await expect(
      verifyManifest(jws, jwks, {
        issuer: ISSUER,
        audience: AUDIENCE,
        expectedPartnerOrgId: 'org_partner_b',
        ...at('2026-09-01T00:05:00Z'),
      }),
    ).rejects.toThrow(/different Partner/i);
  });

  it('pins issuer and audience against cross-environment replay', async () => {
    const jws = await signManifest(payload(), signingKey, {
      kid: kp.kid,
      issuer: 'https://staging.oolix.example',
      audience: AUDIENCE,
    });
    await expect(
      verifyManifest(jws, jwks, {
        issuer: ISSUER,
        audience: AUDIENCE,
        ...at('2026-09-01T00:05:00Z'),
      }),
    ).rejects.toThrow(/issuer mismatch/i);
  });

  it('rejects an ES256 JWS of a different token type signed by the same key', async () => {
    // Without an explicit typ check, any ES256 JWS the manifest key ever
    // produced would be accepted as a manifest.
    const { CompactSign } = await import('jose');
    const jws = await new CompactSign(new TextEncoder().encode(JSON.stringify(payload())))
      .setProtectedHeader({ alg: 'ES256', kid: kp.kid, typ: 'JWT', iss: ISSUER, aud: AUDIENCE })
      .sign(signingKey);

    await expect(
      verifyManifest(jws, jwks, {
        issuer: ISSUER,
        audience: AUDIENCE,
        ...at('2026-09-01T00:05:00Z'),
      }),
    ).rejects.toThrow(/token type/i);
  });

  it('rejects a manifest signed by an unknown key', async () => {
    const other = await generateManifestKeyPair('attacker-key');
    const otherKey = await importSigningKey(other.privateJwk);
    const jws = await signManifest(payload(), otherKey, {
      kid: other.kid,
      issuer: ISSUER,
      audience: AUDIENCE,
    });
    await expect(
      verifyManifest(jws, jwks, {
        issuer: ISSUER,
        audience: AUDIENCE,
        ...at('2026-09-01T00:05:00Z'),
      }),
    ).rejects.toThrow();
  });
});

describe('§75 key rotation', () => {
  it('accepts both keys during the 24h overlap and neither after', async () => {
    const oldKp = await generateManifestKeyPair('manifest-old');
    const newKp = await generateManifestKeyPair('manifest-new');
    // §75: publish the new public key BEFORE switching the signer.
    const jwks = buildJwks([oldKp.publicJwk, newKp.publicJwk]);

    for (const kp of [oldKp, newKp]) {
      const key = await importSigningKey(kp.privateJwk);
      const jws = await signManifest(payload(), key, {
        kid: kp.kid,
        issuer: ISSUER,
        audience: AUDIENCE,
      });
      const v = await verifyManifest(jws, jwks, {
        issuer: ISSUER,
        audience: AUDIENCE,
        now: new Date('2026-09-01T00:05:00Z'),
      });
      expect(v.payload.activation_id).toBe('act_a_web');
    }

    const rotatedAt = new Date('2026-09-01T00:00:00Z');
    expect(isWithinRotationOverlap(rotatedAt, new Date('2026-09-01T23:00:00Z'))).toBe(true);
    expect(isWithinRotationOverlap(rotatedAt, new Date('2026-09-02T01:00:00Z'))).toBe(false);
  });

  it('never leaks private material into the published JWKS', async () => {
    const kp = await generateManifestKeyPair('k1');
    const jwks = buildJwks([kp.privateJwk]); // deliberately passed the private key
    expect(jwks.keys[0]).not.toHaveProperty('d');
  });
});
