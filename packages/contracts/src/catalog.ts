/**
 * Catalogue and campaign primitives -- spec v5 §38, §40, §43, §70.
 */
import { z } from 'zod';

// --------------------------------------------------------------------------
// §40.1 campaign objectives
// --------------------------------------------------------------------------
export const OBJECTIVES = ['QUALIFIED_LEADS', 'CONVERSIONS', 'CLICKS', 'AWARENESS'] as const;
export type Objective = (typeof OBJECTIVES)[number];
export const ObjectiveSchema = z.enum(OBJECTIVES);

// --------------------------------------------------------------------------
// §38.1 pricing models
// --------------------------------------------------------------------------
export const PRICING_MODELS = ['CPM', 'CPC', 'CPL', 'CPQL', 'FIXED', 'HYBRID'] as const;
export type PricingModel = (typeof PRICING_MODELS)[number];
export const PricingModelSchema = z.enum(PRICING_MODELS);

/**
 * Which pricing models settle on a Buyer-CRM-verified outcome (§50: "Do not
 * calculate Partner payout directly from unverified client-side clicks").
 * These are the only models whose payout basis comes from lead_events.
 */
export const OUTCOME_BASED_PRICING: readonly PricingModel[] = ['CPL', 'CPQL'];

export function isOutcomeBased(model: PricingModel): boolean {
  return OUTCOME_BASED_PRICING.includes(model);
}

// --------------------------------------------------------------------------
// §43 placement surfaces and formats
// --------------------------------------------------------------------------
export const SURFACES = [
  'web',
  'ios',
  'android',
  'react_native',
  'flutter',
  'backend_native',
] as const;
export type Surface = (typeof SURFACES)[number];
export const SurfaceSchema = z.enum(SURFACES);

export const PLACEMENT_FORMATS = ['banner', 'native_card', 'carousel', 'inline', 'modal'] as const;
export type PlacementFormat = (typeof PLACEMENT_FORMATS)[number];
export const PlacementFormatSchema = z.enum(PLACEMENT_FORMATS);

/**
 * §43: "MVP should limit formats". §70 narrows creative types to IMAGE and
 * NATIVE_CARD, so only the placement formats those can fill are enabled.
 * Carousel and modal stay in the enum for schema stability but are not
 * offered until a design Partner needs them.
 */
export const MVP_ENABLED_FORMATS: readonly PlacementFormat[] = ['banner', 'native_card', 'inline'];

// --------------------------------------------------------------------------
// §70 creative types
// --------------------------------------------------------------------------
export const CREATIVE_TYPES = ['IMAGE', 'NATIVE_CARD'] as const;
export type CreativeType = (typeof CREATIVE_TYPES)[number];
export const CreativeTypeSchema = z.enum(CREATIVE_TYPES);

export const CREATIVE_STATUSES = ['UPLOADING', 'READY', 'REJECTED'] as const;
export type CreativeStatus = (typeof CREATIVE_STATUSES)[number];
export const CreativeStatusSchema = z.enum(CREATIVE_STATUSES);

/** §70: PNG/JPEG/WebP, max 5 MiB. */
export const ALLOWED_CREATIVE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
export const MAX_CREATIVE_BYTES = 5 * 1024 * 1024;

/** §93: pre-signed upload URL expiry. */
export const CREATIVE_UPLOAD_URL_TTL_SEC = 15 * 60;

// --------------------------------------------------------------------------
// §38.1 segment metadata
// --------------------------------------------------------------------------
export const REFRESH_FREQUENCIES = ['15m', 'hourly', '6h', 'daily', 'weekly'] as const;
export type RefreshFrequency = (typeof REFRESH_FREQUENCIES)[number];
export const RefreshFrequencySchema = z.enum(REFRESH_FREQUENCIES);

export const CONSENT_ELIGIBILITY = ['ELIGIBLE', 'MIXED', 'UNAVAILABLE'] as const;
export type ConsentEligibility = (typeof CONSENT_ELIGIBILITY)[number];
export const ConsentEligibilitySchema = z.enum(CONSENT_ELIGIBILITY);

export const SEGMENT_STATUSES = ['DRAFT', 'PUBLISHED', 'SUSPENDED', 'ARCHIVED'] as const;
export type SegmentStatus = (typeof SEGMENT_STATUSES)[number];
export const SegmentStatusSchema = z.enum(SEGMENT_STATUSES);

export const PLACEMENT_STATUSES = ['DRAFT', 'ACTIVE', 'DISABLED'] as const;
export type PlacementStatus = (typeof PLACEMENT_STATUSES)[number];
export const PlacementStatusSchema = z.enum(PLACEMENT_STATUSES);

/** §43: what the Partner's ad slot does when no ad is served. */
export const PLACEMENT_FALLBACKS = ['NO_AD', 'HOUSE_CONTENT'] as const;
export type PlacementFallback = (typeof PLACEMENT_FALLBACKS)[number];
export const PlacementFallbackSchema = z.enum(PLACEMENT_FALLBACKS);

// --------------------------------------------------------------------------
// §37 partner readiness
// --------------------------------------------------------------------------
export const PARTNER_READINESS = [
  'PROFILE_INCOMPLETE',
  'POLICY_PENDING',
  'AGENT_PENDING',
  'CONNECTOR_PENDING',
  'SEGMENTS_PENDING',
  'PLACEMENTS_PENDING',
  'TEST_CAMPAIGN_PENDING',
  'READY_FOR_CAMPAIGNS',
  'SUSPENDED',
] as const;
export type PartnerReadiness = (typeof PARTNER_READINESS)[number];
export const PartnerReadinessSchema = z.enum(PARTNER_READINESS);

// --------------------------------------------------------------------------
// §36 buyer onboarding status
// --------------------------------------------------------------------------
export const BUYER_ONBOARDING_STATUS = [
  'PROFILE_INCOMPLETE',
  'VERIFICATION_PENDING',
  'BILLING_REQUIRED',
  'READY',
] as const;
export type BuyerOnboardingStatus = (typeof BUYER_ONBOARDING_STATUS)[number];
export const BuyerOnboardingStatusSchema = z.enum(BUYER_ONBOARDING_STATUS);

// --------------------------------------------------------------------------
// §41 partner decisions
// --------------------------------------------------------------------------
export const PARTNER_DECISIONS = ['APPROVE', 'REQUEST_CHANGE', 'REJECT', 'REVOKE'] as const;
export type PartnerDecision = (typeof PARTNER_DECISIONS)[number];
export const PartnerDecisionSchema = z.enum(PARTNER_DECISIONS);

// --------------------------------------------------------------------------
// §11.2 / §67.2 frequency cap
//
// `window` is an ISO-8601 duration (§67.2 uses "P1D") so the Agent and the
// control plane agree on the window without a bespoke unit enum.
// --------------------------------------------------------------------------
export const FrequencyCapSchema = z.object({
  max_impressions: z.number().int().positive(),
  window: z.string().regex(/^P(?:\d+D)?(?:T(?:\d+H)?(?:\d+M)?(?:\d+S)?)?$/, 'ISO-8601 duration'),
});
export type FrequencyCap = z.infer<typeof FrequencyCapSchema>;

/** Parse the subset of ISO-8601 durations frequency caps use, into seconds. */
export function durationToSeconds(iso: string): number {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(iso);
  if (!m) throw new Error(`unsupported duration: ${iso}`);
  const [, d, h, min, s] = m;
  const total =
    Number(d ?? 0) * 86_400 + Number(h ?? 0) * 3_600 + Number(min ?? 0) * 60 + Number(s ?? 0);
  if (total <= 0) throw new Error(`duration must be positive: ${iso}`);
  return total;
}
