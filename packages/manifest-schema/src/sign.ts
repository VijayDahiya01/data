/**
 * Manifest signing and verification -- spec v5 §75.
 *
 * Signing happens only in Oolix Cloud (private key in KMS/HSM in production).
 * Verification happens in the Partner Agent. This module holds both so the two
 * sides cannot drift; the Go Agent mirrors the verification rules and is
 * cross-checked against these test vectors.
 */
import { CompactSign, compactVerify, importJWK, createLocalJWKSet, type JWK } from 'jose';
import { OolixError } from '@oolix/contracts';
import { canonicalJsonBytes, canonicalJsonStringify } from './canonical-json.js';
import {
  MANIFEST_ALG,
  MANIFEST_JWS_TYP,
  ManifestPayloadSchema,
  type ManifestPayload,
} from './manifest.js';

/**
 * Key material jose accepts. Derived from jose's own signatures: v6 removed
 * the exported `KeyLike` alias, and naming CryptoKey/KeyObject directly would
 * tie this package to a particular TypeScript lib set.
 */
export type ManifestSigningKey = Parameters<CompactSign['sign']>[0];

export interface SignOptions {
  /** Key id published in the JWKS, so the Agent can select the right key. */
  kid: string;
  issuer: string;
  audience: string;
}

/**
 * Sign a manifest payload as compact JWS (ES256).
 *
 * The payload is serialized canonically BEFORE signing, so the bytes the
 * Agent verifies are byte-identical to what the control plane produced.
 */
export async function signManifest(
  payload: ManifestPayload,
  privateKey: ManifestSigningKey,
  opts: SignOptions,
): Promise<string> {
  const validated = ManifestPayloadSchema.parse(payload);

  return new CompactSign(canonicalJsonBytes(validated))
    .setProtectedHeader({
      alg: MANIFEST_ALG,
      kid: opts.kid,
      typ: MANIFEST_JWS_TYP,
      iss: opts.issuer,
      aud: opts.audience,
    })
    .sign(privateKey);
}

export interface VerifyOptions {
  issuer: string;
  audience: string;
  /** The Agent's own partner id. A manifest for another Partner is rejected. */
  expectedPartnerOrgId?: string;
  /** Injectable for deterministic tests. */
  now?: Date;
  /**
   * §75: grace beyond config_expires_at. Non-zero ONLY where the spec allows a
   * stale cache; the ad-decision path passes 0 because §75 forbids serving
   * past expiry.
   */
  clockToleranceSeconds?: number;
}

export interface VerifiedManifest {
  payload: ManifestPayload;
  kid: string;
}

/**
 * Verify a manifest JWS against a JWKS.
 *
 * Enforces every check §75 and §82 require, in this order:
 *   1. alg is ES256 and typ is the Oolix manifest type  (algorithm confusion)
 *   2. signature verifies against a key in the JWKS      (authenticity)
 *   3. issuer and audience are pinned                    (cross-env replay)
 *   4. partner binding matches this Agent                (cross-tenant replay)
 *   5. time bounds: issued_at <= now < config_expires_at (staleness)
 *   6. campaign window has not ended                     (§24 expired campaign)
 *
 * Any failure throws. §11.2: no valid signature means no ad and no upload --
 * there is no partial-trust path.
 */
export async function verifyManifest(
  jws: string,
  jwks: { keys: JWK[] },
  opts: VerifyOptions,
): Promise<VerifiedManifest> {
  const now = opts.now ?? new Date();
  const tolerance = (opts.clockToleranceSeconds ?? 0) * 1000;

  const keySet = createLocalJWKSet(jwks);

  let result: Awaited<ReturnType<typeof compactVerify>>;
  try {
    result = await compactVerify(jws, keySet, { algorithms: [MANIFEST_ALG] });
  } catch (cause) {
    throw new OolixError('AUTH_001', 'Manifest signature verification failed.', { cause });
  }

  const header = result.protectedHeader;

  // compactVerify has no `typ` option (unlike jwtVerify), so the check is
  // explicit. It is not cosmetic: without it, any ES256 JWS this key ever
  // signed -- an agent access token, for instance -- would be accepted as a
  // manifest.
  if (header.typ !== MANIFEST_JWS_TYP) {
    throw new OolixError('AUTH_001', `Unexpected manifest token type: ${String(header.typ)}`);
  }

  if (header.iss !== opts.issuer) {
    throw new OolixError('AUTH_001', `Manifest issuer mismatch: ${String(header.iss)}`);
  }
  if (header.aud !== opts.audience) {
    throw new OolixError('AUTH_001', `Manifest audience mismatch: ${String(header.aud)}`);
  }

  let parsed: ManifestPayload;
  try {
    parsed = ManifestPayloadSchema.parse(JSON.parse(new TextDecoder().decode(result.payload)));
  } catch (cause) {
    throw new OolixError('VAL_001', 'Manifest payload is not a valid manifest.', { cause });
  }

  // Re-serializing canonically must reproduce the signed bytes exactly. This
  // catches a payload that verifies but was not canonically encoded, which
  // would otherwise let two different byte strings claim the same meaning.
  const reserialized = canonicalJsonStringify(parsed);
  const signedText = new TextDecoder().decode(result.payload);
  if (reserialized !== signedText) {
    throw new OolixError('VAL_001', 'Manifest payload is not canonically serialized.');
  }

  if (opts.expectedPartnerOrgId && parsed.partner_org_id !== opts.expectedPartnerOrgId) {
    throw new OolixError('PERM_002', 'Manifest is bound to a different Partner organization.');
  }

  const issuedAt = Date.parse(parsed.issued_at);
  const configExpiresAt = Date.parse(parsed.config_expires_at);
  const endAt = Date.parse(parsed.end_at);
  const t = now.getTime();

  if (t + tolerance < issuedAt) {
    throw new OolixError('VAL_001', 'Manifest is not yet valid.');
  }
  if (t - tolerance >= configExpiresAt) {
    throw new OolixError('VAL_001', 'Manifest config has expired.');
  }
  // §24: "Agent automatically stops serving even if Oolix is temporarily
  // unreachable" once the campaign end passes.
  if (t >= endAt) {
    throw new OolixError('VAL_001', 'Campaign has ended.');
  }

  return { payload: parsed, kid: String(header.kid ?? '') };
}

/** Load an ES256 private key from a JWK for signing. */
export async function importSigningKey(jwk: JWK): Promise<ManifestSigningKey> {
  return (await importJWK(jwk, MANIFEST_ALG)) as ManifestSigningKey;
}
