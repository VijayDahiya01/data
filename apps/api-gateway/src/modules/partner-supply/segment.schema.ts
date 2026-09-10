/**
 * Segment publication contracts -- spec v5 §38, §72.
 *
 * The defining constraint of this module, from §38.1:
 *
 *   "A segment is a Partner-defined, locally evaluated group. Oolix receives
 *    only metadata. The exact member list remains local."
 *
 * So there is no field here for members, and `reach_exact_local` is accepted
 * ONLY to compute a bucket -- it is never persisted and never returned.
 */
import { z } from 'zod';
import { ChannelSchema, ConsentEligibilitySchema, RefreshFrequencySchema } from '@oolix/contracts';

export const CreateSegmentSchema = z.object({
  /**
   * §38.1: the Partner's own segment key, e.g. RECENT_TRAVELLER_60D. The
   * Partner Agent resolves membership by this value locally; Oolix only ever
   * passes it back inside a signed manifest.
   */
  internal_segment_id: z
    .string()
    .min(2)
    .max(120)
    .regex(/^[A-Za-z0-9_.:-]+$/, 'alphanumeric, dot, colon, dash or underscore'),
  display_name: z.string().min(2).max(120),
  description: z.string().min(2).max(1000),
  category: z.string().min(2).max(80),
  geographies: z.array(z.string().min(2).max(80)).min(1),
  refresh_frequency: RefreshFrequencySchema,
  consent_eligibility: ConsentEligibilitySchema.default('ELIGIBLE'),
  allowed_channels: z.array(ChannelSchema).min(1),
  allowed_categories: z.array(z.string().max(80)).default([]),
  blocked_categories: z.array(z.string().max(80)).default([]),
  source_event: z.string().max(200).optional(),
  active_user_window: z.string().max(40).optional(),

  /**
   * Exact local count, used ONLY to derive the published bucket (§72).
   *
   * §72: "Exact reach is never buyer-visible in MVP." This value is not
   * stored on the segment row and never appears in any Buyer-facing response.
   * Reported by the Partner Agent or entered by the Partner Admin.
   */
  reach_exact_local: z.number().int().nonnegative(),

  pricing: z
    .object({
      model: z.enum(['CPM', 'CPC', 'CPL', 'CPQL', 'FIXED', 'HYBRID']),
      unit_price_minor: z.number().int().nonnegative(),
      currency: z.string().length(3),
      visibility: z.enum(['PRIVATE_NETWORK', 'CURATED', 'MARKETPLACE']).default('PRIVATE_NETWORK'),
      network_id: z.string().uuid().nullable().default(null),
    })
    .optional(),
});

export type CreateSegmentInput = z.infer<typeof CreateSegmentSchema>;

export const UpdateSegmentSchema = CreateSegmentSchema.partial().omit({
  internal_segment_id: true,
});

export type UpdateSegmentInput = z.infer<typeof UpdateSegmentSchema>;

/**
 * Freshness report (§38.1 `freshness_at`, §58 connector health).
 *
 * Posted by the Partner (or its Agent) after a segment refresh. The exact
 * count is re-bucketed here and then discarded.
 */
export const SegmentFreshnessSchema = z.object({
  freshness_at: z.string().refine((v) => !Number.isNaN(Date.parse(v)), 'ISO-8601 date-time'),
  reach_exact_local: z.number().int().nonnegative(),
});

export type SegmentFreshnessInput = z.infer<typeof SegmentFreshnessSchema>;
