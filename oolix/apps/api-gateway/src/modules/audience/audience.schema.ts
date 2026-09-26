/**
 * Audience Builder contracts — v6 §6, §14.
 *
 * Rules are validated twice on the way in: once for shape here, and once
 * against the live attribute taxonomy in the service. The second pass is the
 * one that matters — §17 forbids arbitrary expressions, so a rule is only legal
 * if the taxonomy says that attribute exists, supports that operator, and
 * permits that value.
 */
import { z } from 'zod';
import { AudienceRuleSchema, MAX_AUDIENCE_RULES, MIN_AUDIENCE_RULES } from '@oolix/contracts';

export const CreateAudienceSchema = z.object({
  name: z.string().min(3).max(120),
  description: z.string().max(1000).optional(),
  /**
   * §20 acceptance requires at least four rules. A one-rule audience matches
   * every Partner trivially and tells a Data Partner almost nothing about what
   * they are being asked to serve (§10).
   */
  rules: z.array(AudienceRuleSchema).min(MIN_AUDIENCE_RULES).max(MAX_AUDIENCE_RULES),
});
export type CreateAudienceInput = z.infer<typeof CreateAudienceSchema>;

export const UpdateAudienceSchema = z.object({
  name: z.string().min(3).max(120).optional(),
  description: z.string().max(1000).optional(),
  rules: z.array(AudienceRuleSchema).min(MIN_AUDIENCE_RULES).max(MAX_AUDIENCE_RULES).optional(),
});
export type UpdateAudienceInput = z.infer<typeof UpdateAudienceSchema>;

/** §8.1: ask selected Partners to evaluate the rules locally. */
export const RequestReachEstimatesSchema = z.object({
  audience_version: z.number().int().positive().optional(),
  partner_org_ids: z.array(z.string().uuid()).min(1).max(20),
});
export type RequestReachEstimatesInput = z.infer<typeof RequestReachEstimatesSchema>;

/**
 * §5.1: what a Partner declares it can evaluate.
 *
 * Note what this cannot carry: there is no field for the Partner's local column
 * name. §5.2 keeps the mapping from `payment_method` to `pay_mode` inside the
 * Partner, and §17 says Oolix stores capability metadata, "not Partner customer
 * records or Partner local field names".
 */
export const PublishCapabilitiesSchema = z.object({
  attributes: z
    .array(
      z.object({
        attribute_key: z.string().min(1).max(120),
        operators: z.array(z.enum(['EQ', 'IN', 'LTE', 'GTE', 'BETWEEN'])).min(1),
        status: z.enum(['AVAILABLE', 'UNAVAILABLE']).default('AVAILABLE'),
      }),
    )
    .min(1)
    .max(100),
  geographies: z.array(z.string().min(2).max(80)).min(1),
  channels: z.array(z.enum(['PARTNER_WEB', 'PARTNER_APP', 'META', 'GOOGLE'])).min(1),
  /** §11: the local mapping version these capabilities were compiled against. */
  mapping_version: z.number().int().positive().optional(),
});
export type PublishCapabilitiesInput = z.infer<typeof PublishCapabilitiesSchema>;

/**
 * How complete a managed Agent's copy is, after a full sync (Partner Connect).
 *
 * Percentages and the reach size bands only. There is no field for a count, a
 * customer or a value, and adding one would be a privacy change rather than a
 * schema change. The Partner sees it in their own portal; no Buyer does.
 */
export const DataQualityReportSchema = z.object({
  synced_at: z.string().refine((v) => !Number.isNaN(Date.parse(v)), 'ISO-8601 date-time'),
  sync_mode: z.enum(['FULL', 'INCREMENTAL']),
  customers_bucket: z.enum([
    'UNDER_10K',
    '10K_50K',
    '50K_100K',
    '100K_250K',
    '250K_500K',
    '500K_1M',
    'OVER_1M',
  ]),
  attributes: z
    .array(
      z.object({
        attribute_key: z.string().min(1).max(120),
        coverage_pct: z.number().int().min(0).max(100),
        unreadable_pct: z.number().int().min(0).max(100),
      }),
    )
    .max(100),
});
export type DataQualityReportInput = z.infer<typeof DataQualityReportSchema>;
