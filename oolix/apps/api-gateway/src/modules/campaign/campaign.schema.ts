/**
 * Campaign builder contracts -- spec v5 §40, §67.1, §67.2, §97.
 *
 * The shapes here mirror §67's worked examples exactly, because §86 makes the
 * OpenAPI file canonical for HTTP shapes and a drift between the two is a
 * contract break for every client.
 */
import { z } from 'zod';
import { ChannelSchema, ObjectiveSchema } from '@oolix/contracts';

const isoDateTime = z
  .string()
  .refine((v) => !Number.isNaN(Date.parse(v)), { message: 'must be an ISO-8601 date-time' });

const MoneyInput = z.object({
  amount_minor: z.number().int().positive(),
  currency: z
    .string()
    .length(3)
    .regex(/^[A-Za-z]{3}$/)
    .transform((c) => c.toUpperCase()),
});

/**
 * §40.8 lead definition.
 *
 * Required for outcome objectives: §50 forbids paying a Partner on unverified
 * clicks, so a CPQL campaign that never defines "qualified" has no settleable
 * basis. The duplicate window is Buyer-defined (§40.8 example: 30 days).
 */
export const LeadDefinitionSchema = z.object({
  qualified_statuses: z.array(z.enum(['VALID', 'QUALIFIED', 'CONVERTED'])).min(1),
  duplicate_window_days: z.number().int().min(1).max(365).default(30),
  valid_lead_rule: z.string().max(500).optional(),
  qualified_lead_rule: z.string().max(500).optional(),
  conversion_event: z.string().max(200).optional(),
});

/** §40.1-40.2: campaign objective and basics. */
export const CreateCampaignSchema = z
  .object({
    name: z.string().min(3).max(120),
    objective: ObjectiveSchema,
    brand_id: z.string().uuid(),
    category: z.string().min(2).max(80),
    /** §81: explicit, versioned purpose -- never a permanent eligible flag. */
    purpose_id: z.string().min(2).max(120),
    budget: MoneyInput,
    start_at: isoDateTime,
    end_at: isoDateTime,
    geographies: z.array(z.string().min(2).max(80)).min(1),
    /** §40.2: required for click/lead objectives; must be an allow-listed domain. */
    landing_url: z.string().url().optional(),
    lead_definition: LeadDefinitionSchema.optional(),
  })
  .refine((v) => Date.parse(v.end_at) > Date.parse(v.start_at), {
    message: 'end_at must be after start_at',
    path: ['end_at'],
  })
  .refine(
    (v) =>
      !['QUALIFIED_LEADS', 'CONVERSIONS', 'CLICKS'].includes(v.objective) || Boolean(v.landing_url),
    {
      message: 'landing_url is required for click, lead and conversion objectives',
      path: ['landing_url'],
    },
  )
  .refine(
    (v) => !['QUALIFIED_LEADS', 'CONVERSIONS'].includes(v.objective) || Boolean(v.lead_definition),
    {
      // §40.8 / §50: an outcome campaign with no definition of the outcome
      // cannot be settled or disputed.
      message: 'lead_definition is required for QUALIFIED_LEADS and CONVERSIONS objectives',
      path: ['lead_definition'],
    },
  );

export type CreateCampaignInput = z.infer<typeof CreateCampaignSchema>;

export const UpdateCampaignSchema = z.object({
  name: z.string().min(3).max(120).optional(),
  category: z.string().min(2).max(80).optional(),
  budget: MoneyInput.optional(),
  start_at: isoDateTime.optional(),
  end_at: isoDateTime.optional(),
  geographies: z.array(z.string().min(2).max(80)).min(1).optional(),
  landing_url: z.string().url().optional(),
  lead_definition: LeadDefinitionSchema.optional(),
});
export type UpdateCampaignInput = z.infer<typeof UpdateCampaignSchema>;

/**
 * §67.2 / §40.5: one requested channel within a Partner request.
 *
 * §40.5: "Hybrid creates separate activation records per channel; never a
 * single ambiguous activation." So channels are a list of discrete requests,
 * each with its own placements, allocation and cap.
 */
export const ChannelRequestSchema = z.object({
  channel: ChannelSchema,
  placement_ids: z.array(z.string().uuid()).default([]),
  allocation_minor: z.number().int().positive(),
  frequency_cap: z.object({
    max_impressions: z.number().int().positive().max(100),
    window: z.string().regex(/^P(?:\d+D)?(?:T(?:\d+H)?(?:\d+M)?(?:\d+S)?)?$/, 'ISO-8601 duration'),
  }),
});

/**
 * v6 §9 step 3: freeze an Audience Group onto a campaign.
 *
 * The version is frozen deliberately. §9: "Campaign request freezes Audience
 * Group version, rule hash and selected reach-estimate version." Without that,
 * a Buyer could edit the audience after a Partner approved it and the Partner's
 * approval would silently come to mean something else (§10).
 */
export const LinkAudienceSchema = z.object({
  audience_group_id: z.string().uuid(),
  /** Omitted means "the version that is current right now", frozen at link time. */
  audience_version: z.number().int().positive().optional(),
});

export type LinkAudienceInput = z.infer<typeof LinkAudienceSchema>;

export const CreatePartnerRequestSchema = z
  .object({
    partner_org_id: z.string().uuid(),
    /**
     * v6 §19: the legacy prebuilt-segment path. Optional now -- the primary
     * path is the campaign's linked Audience Group.
     */
    segment_id: z.string().uuid().optional(),
    /**
     * v6 §9: which reach estimate the Buyer was looking at when they chose this
     * Partner. Frozen onto the request so the Partner approves against the same
     * number the Buyer saw.
     */
    reach_estimate_id: z.string().uuid().optional(),
    channels: z.array(ChannelRequestSchema).min(1),
    creative_version_ids: z.array(z.string().uuid()).min(1),
    /** §40.4 / §41: off unless the Partner explicitly approves it. */
    audience_expansion_allowed: z.boolean().default(false),
    /** §41: what the Partner will be paid, agreed at request time. */
    partner_payout: z
      .object({
        model: z.enum(['CPM', 'CPC', 'CPL', 'CPQL', 'FIXED', 'HYBRID']),
        unit_price_minor: z.number().int().nonnegative(),
      })
      .optional(),
  })
  .refine((v) => !(v.segment_id && v.reach_estimate_id), {
    // §19: a request targets EITHER a prebuilt segment or the campaign's
    // Audience Group. Accepting both would leave two answers to "who is this
    // for", and the manifest can only carry one.
    message: 'A request targets either a prebuilt segment or the campaign audience, not both.',
    path: ['segment_id'],
  });

export type CreatePartnerRequestInput = z.infer<typeof CreatePartnerRequestSchema>;
export type ChannelRequestInput = z.infer<typeof ChannelRequestSchema>;
