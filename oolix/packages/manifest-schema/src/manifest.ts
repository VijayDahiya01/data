/**
 * Activation manifest schema -- spec v5 §11.2, §75.
 *
 * The manifest is the ONLY thing that authorises a Partner Agent to serve an
 * ad or to start an external upload. §11.2 states the rule plainly:
 *
 *   "No valid signature + no valid approval + no current policy = no ad and
 *    no external upload."
 *
 * Every field here exists because the Agent must be able to enforce the
 * Partner's decision offline, without calling back to Oolix (§75 stale grace).
 */
import { z } from 'zod';
import { ChannelSchema, FrequencyCapSchema, IsoDateTimeSchema } from '@oolix/contracts';

/** §75 JWS protected header type. */
export const MANIFEST_JWS_TYP = 'OOLIX-MANIFEST+JWS';

/** §75: manifests are signed ES256. No other algorithm is accepted. */
export const MANIFEST_ALG = 'ES256';

export const ManifestBudgetSchema = z.object({
  /**
   * Minor units as a string. §73 stores budgets as BIGINT; JSON numbers lose
   * precision past 2^53, and a truncated budget is a financial defect, so the
   * wire format is a decimal string.
   */
  allocation_minor: z.string().regex(/^\d+$/, 'decimal minor units'),
  currency: z.string().length(3),
  /**
   * §76.1: the Agent stops locally at this fraction of the allocation. The
   * reserve absorbs reporting lag so the Partner cannot overdeliver against a
   * budget the control plane has not yet confirmed.
   */
  local_stop_fraction: z.number().min(0).max(1).default(0.98),
});

export const ManifestPayloadSchema = z.object({
  manifest_version: z.number().int().nonnegative(),
  activation_id: z.string().min(1),
  partner_org_id: z.string().min(1),
  /**
   * v6 §19: legacy prebuilt-segment targeting.
   *
   * Nullable because the primary path is now an Audience Group. A Partner with
   * an existing CDP audience can still be activated this way, and an Agent in
   * the field must accept both shapes -- §80 keeps N-1 compatibility during a
   * rollout, so a manifest carrying either must verify.
   */
  segment_id: z.string().min(1).nullable().optional(),
  /** Partner-internal segment key the Agent resolves locally (§38.1). */
  segment_key: z.string().min(1).nullable().optional(),

  /**
   * v6 Appendix B: the approved audience.
   *
   * `rule_hash` is the load-bearing field. §11 has the Agent compile the rules
   * locally and materialize the matching members; recomputing the hash before
   * it does so is how it confirms it is about to serve exactly what the Partner
   * approved (§10) rather than something edited since.
   */
  audience: z
    .object({
      audience_group_id: z.string().min(1),
      audience_version: z.number().int().positive(),
      rule_hash: z.string().length(64),
      /** The rules themselves, so the Agent can compile without calling back. */
      rules: z
        .array(
          z.object({
            attribute: z.string().min(1),
            operator: z.enum(['EQ', 'IN', 'LTE', 'GTE', 'BETWEEN']),
            value: z.unknown(),
            required: z.boolean(),
            weight: z.number().int().min(1).max(5),
          }),
        )
        .min(1),
      reach_estimate_id: z.string().min(1).nullable().optional(),
      capability_version: z.number().int().positive().nullable().optional(),
      mapping_version: z.number().int().positive().nullable().optional(),
    })
    .nullable()
    .optional(),
  channel: ChannelSchema,
  placement_ids: z.array(z.string().min(1)),
  /** Partner-published placement keys, so the Agent matches without a lookup. */
  placement_keys: z.array(z.string().min(1)),
  creative_version_ids: z.array(z.string().min(1)).min(1),
  budget: ManifestBudgetSchema,
  frequency_cap: FrequencyCapSchema,
  /** §81: explicit, versioned purpose -- never a permanent eligible boolean. */
  purpose_id: z.string().min(1),
  policy_version: z.string().min(1),
  /** Category constraints the Agent enforces locally (§41). */
  allowed_categories: z.array(z.string()).default([]),
  blocked_categories: z.array(z.string()).default([]),
  campaign_category: z.string().min(1),
  issued_at: IsoDateTimeSchema,
  /**
   * §75: after this instant the Agent must stop serving from this manifest,
   * even if Oolix is unreachable. This is what makes the offline cache safe.
   */
  config_expires_at: IsoDateTimeSchema,
  start_at: IsoDateTimeSchema,
  end_at: IsoDateTimeSchema,
  /** Points at the approval row that authorised this (§83 auditability). */
  approval_reference: z.string().min(1),
  /** §40.4 / §41: audience expansion is off unless the Partner allowed it. */
  audience_expansion_allowed: z.boolean().default(false),
});

export type ManifestPayload = z.infer<typeof ManifestPayloadSchema>;
export type ManifestBudget = z.infer<typeof ManifestBudgetSchema>;

/**
 * Creative bundle delivered alongside the manifest.
 *
 * Kept OUT of the signed payload deliberately: creative assets are large and
 * cacheable, while the manifest must stay small enough to re-sign cheaply on
 * every budget or policy change. Integrity is preserved by binding each
 * creative to its content hash, which the Agent verifies against the asset it
 * actually fetched (§70: "Partner approval binds to the content hash").
 */
export const ManifestCreativeSchema = z.object({
  creative_version_id: z.string().min(1),
  type: z.enum(['IMAGE', 'NATIVE_CARD']),
  asset_url: z.string().url().nullable(),
  content_sha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/, 'lowercase hex sha-256')
    .nullable(),
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
  headline: z.string().nullable(),
  body: z.string().nullable(),
  cta: z.string().nullable(),
  destination_url: z.string().url(),
  legal_disclaimer: z.string().nullable(),
});

export type ManifestCreative = z.infer<typeof ManifestCreativeSchema>;

/** What GET /agent/v1/config/pull returns (§52.4). */
export const AgentConfigBundleSchema = z.object({
  config_version: z.number().int().nonnegative(),
  issued_at: IsoDateTimeSchema,
  partner_org_id: z.string().min(1),
  /** Compact JWS strings, one per active activation. */
  manifests: z.array(z.string().min(1)),
  creatives: z.array(ManifestCreativeSchema),
  /** Activation IDs the Agent must stop serving immediately (§24). */
  revoked_activation_ids: z.array(z.string()),
  /** §24 / §56: partner-scoped kill switches the Agent enforces locally. */
  kill_switches: z.array(
    z.object({
      scope: z.enum(['AGENT', 'PLACEMENT', 'ACTIVATION', 'CHANNEL', 'PARTNER_ALL']),
      target_id: z.string().nullable(),
    }),
  ),
  /** Seconds the Agent may keep serving this bundle if Oolix is unreachable. */
  stale_grace_seconds: z.number().int().positive(),
});

export type AgentConfigBundle = z.infer<typeof AgentConfigBundleSchema>;
