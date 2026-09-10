/**
 * Channel connection payloads -- spec v5 §17.
 *
 * §17 is the constraint these schemas exist to enforce: "Never collect Partner
 * usernames/passwords. Use delegated/OAuth/business account access and store
 * only the minimum required connection metadata centrally... raw audience data
 * and ingestion credentials execute inside Partner Agent; Oolix stores account
 * IDs, authorization state, resource IDs and non-sensitive configuration."
 *
 * So the interesting part of this file is what it REFUSES. A well-meaning
 * integration that posts an access token alongside the account ids would, with
 * a permissive schema, quietly put a long-lived platform credential in the
 * Oolix database, in its backups, and in anything that ever dumps a row. The
 * rejection below is deliberate and tested.
 */
import { z } from 'zod';

/**
 * Key names that indicate a credential rather than an identifier.
 *
 * Matched as substrings against the lower-cased key, so `fb_access_token` and
 * `refreshToken` are both caught. Erring towards over-rejection is correct
 * here: a false positive costs someone a rename, a false negative puts a
 * credential somewhere it can never be fully recalled from.
 */
const CREDENTIAL_HINTS = [
  'token',
  'secret',
  'password',
  'passwd',
  'credential',
  'private_key',
  'privatekey',
  'client_secret',
  'refresh',
  'assertion',
  'api_key',
  'apikey',
  'authorization',
];

function looksLikeCredential(key: string): boolean {
  const k = key.toLowerCase();
  return CREDENTIAL_HINTS.some((h) => k.includes(h));
}

/**
 * Account identifiers: a flat map of short opaque ids.
 *
 * Flat and shallow on purpose. Nested objects are where a whole OAuth response
 * gets pasted in wholesale, and a value long enough to be a JWT is far more
 * likely to be one than to be an account number.
 */
const AccountIds = z
  .record(z.string().min(1).max(64), z.string().min(1).max(256))
  .refine((obj) => !Object.keys(obj).some(looksLikeCredential), {
    message:
      'Account identifiers must not include credentials. §17: ingestion credentials belong in the Partner Agent, never in Oolix.',
  });

const CapabilityFlags = z
  .record(z.string().min(1).max(64), z.boolean())
  .refine((obj) => !Object.keys(obj).some(looksLikeCredential), {
    message: 'Capability flags must not include credentials.',
  });

export const UpsertConnectionSchema = z
  .object({
    /**
     * What the provider says this connection can do, discovered rather than
     * asserted. §15: "it must never assume universal eligibility."
     */
    account_ids: AccountIds,
    scopes: z.array(z.string().min(1).max(200)).max(50).default([]),
    capability_flags: CapabilityFlags.default({}),
    /** When the delegated authorization lapses, if the provider says. */
    expires_at: z.string().datetime().optional().nullable(),
    status_reason: z.string().max(500).optional().nullable(),
  })
  // Unknown keys are rejected rather than stripped: silently dropping a field
  // an integrator believed was saved is how a connection ends up half
  // configured with nobody aware of it.
  .strict();

export type UpsertConnectionInput = z.infer<typeof UpsertConnectionSchema>;

export const ProviderParamSchema = z.enum(['META', 'GOOGLE']);
export type ProviderParam = z.infer<typeof ProviderParamSchema>;

/** Exported for the test that pins the refusal. */
export const __internal = { looksLikeCredential, CREDENTIAL_HINTS };
