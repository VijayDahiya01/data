/**
 * Manifest signing key lifecycle -- spec v5 §75.
 *
 * Rotation contract:
 *   "publish new public key before signing switch; accept old + new during
 *    24-hour overlap; revoke immediately on incident."
 *
 * The overlap exists because Agents cache the JWKS. Publishing the new key
 * first, then switching the signer, means no Agent ever meets a `kid` it has
 * not had a chance to fetch.
 */
import { exportJWK, generateKeyPair, importJWK, type JWK } from 'jose';
import { MANIFEST_ALG } from './manifest.js';

/** §75: maximum dual-key overlap during a rotation. */
export const KEY_ROTATION_OVERLAP_HOURS = 24;

export interface ManifestKeyPair {
  kid: string;
  privateJwk: JWK;
  publicJwk: JWK;
}

/**
 * Generate an ES256 (P-256) key pair for manifest signing.
 *
 * Local development only. In production the private key is generated inside
 * cloud KMS/HSM and never exists as an exportable JWK (§75, §82).
 */
export async function generateManifestKeyPair(kid: string): Promise<ManifestKeyPair> {
  const { privateKey, publicKey } = await generateKeyPair(MANIFEST_ALG, { extractable: true });
  const privateJwk = await exportJWK(privateKey);
  const publicJwk = await exportJWK(publicKey);

  privateJwk.kid = kid;
  privateJwk.alg = MANIFEST_ALG;
  privateJwk.use = 'sig';
  publicJwk.kid = kid;
  publicJwk.alg = MANIFEST_ALG;
  publicJwk.use = 'sig';

  return { kid, privateJwk, publicJwk };
}

/**
 * Build the JWKS the Agent fetches.
 *
 * Accepts several keys so a rotation can publish the incoming key before the
 * signer switches to it. Private material is stripped defensively -- a JWKS is
 * a public endpoint, and a leaked `d` parameter would forfeit manifest
 * integrity platform-wide.
 */
export function buildJwks(publicKeys: readonly JWK[]): { keys: JWK[] } {
  return {
    keys: publicKeys.map((k) => {
      const { d: _d, p: _p, q: _q, dp: _dp, dq: _dq, qi: _qi, ...pub } = k;
      return pub;
    }),
  };
}

/** True while a retiring key must still be accepted (§75 24h overlap). */
export function isWithinRotationOverlap(
  rotatedAt: Date,
  now: Date = new Date(),
  overlapHours: number = KEY_ROTATION_OVERLAP_HOURS,
): boolean {
  return now.getTime() - rotatedAt.getTime() < overlapHours * 3_600_000;
}

export async function importPublicJwk(jwk: JWK) {
  return importJWK(jwk, MANIFEST_ALG);
}
