/**
 * Buyer-defined audiences — v6 §4, §6, §7.
 *
 * The v6 change spec inverts the Buyer flow. Instead of browsing Partner
 * segments, a Buyer describes the audience they want and Oolix works out which
 * Partners can EVALUATE that description. The one-sentence version from §22:
 *
 *   "Build the audience rule centrally, match capabilities centrally, but
 *    evaluate and materialize actual people locally inside each Data Partner."
 *
 * Two things in this file carry most of the weight:
 *
 *   * `audienceRuleHash` — approval binds to it (§10), so it must be stable
 *     across languages. The Go Agent recomputes it before materializing, and a
 *     mismatch means it is not serving what the Partner approved.
 *   * `matchPartner` — pure, so the same function decides what a Buyer is shown
 *     and what the API records. §7 is emphatic that this is SCHEMA
 *     compatibility, not audience quality.
 */
import { z } from 'zod';

/* --- taxonomy (§4) --------------------------------------------------------- */

export const ATTRIBUTE_CATEGORIES = [
  'DEMOGRAPHIC',
  'GEOGRAPHY',
  'COMMERCE',
  'PAYMENT_BEHAVIOUR',
  'TRAVEL',
  'ENGAGEMENT',
] as const;
export type AttributeCategory = (typeof ATTRIBUTE_CATEGORIES)[number];

export const ATTRIBUTE_DATA_TYPES = ['NUMBER', 'ENUM', 'BOOLEAN', 'ID'] as const;
export type AttributeDataType = (typeof ATTRIBUTE_DATA_TYPES)[number];

/**
 * §4's MVP operator set.
 *
 * Deliberately small. Every operator here is one a Partner can evaluate against
 * a restricted attribute view without exposing a general query engine — §17:
 * "Do not allow arbitrary SQL, JavaScript or regex rules."
 */
export const RULE_OPERATORS = ['EQ', 'IN', 'LTE', 'GTE', 'BETWEEN'] as const;
export type RuleOperator = (typeof RULE_OPERATORS)[number];
export const RuleOperatorSchema = z.enum(RULE_OPERATORS);

export const POLICY_CLASSES = ['GENERAL', 'RESTRICTED', 'SENSITIVE'] as const;
export type PolicyClass = (typeof POLICY_CLASSES)[number];

/** Which operators are meaningful for which data type (§4). */
export const OPERATORS_FOR_TYPE: Readonly<Record<AttributeDataType, readonly RuleOperator[]>> =
  Object.freeze({
    NUMBER: ['EQ', 'LTE', 'GTE', 'BETWEEN'],
    ENUM: ['EQ', 'IN'],
    BOOLEAN: ['EQ'],
    ID: ['EQ', 'IN'],
  });

export interface AttributeDefinition {
  key: string;
  display_name: string;
  description?: string;
  category: AttributeCategory;
  data_type: AttributeDataType;
  operators: RuleOperator[];
  allowed_values?: string[] | null;
  min_value?: number | null;
  max_value?: number | null;
  unit?: string | null;
  policy_class: PolicyClass;
  version: number;
}

/* --- rules (§6.3) ---------------------------------------------------------- */

/**
 * §6.3 rule weights.
 *
 * A weight only affects the match SCORE — it never makes an optional rule
 * behave like a required one. §7: a missing REQUIRED rule is INCOMPATIBLE
 * regardless of weight.
 */
export const MIN_RULE_WEIGHT = 1;
export const MAX_RULE_WEIGHT = 5;

export const AudienceRuleSchema = z.object({
  attribute: z.string().min(1).max(120),
  operator: RuleOperatorSchema,
  /** Scalar, list, or a two-element [min, max] for BETWEEN. */
  value: z.union([z.string(), z.number(), z.boolean(), z.array(z.union([z.string(), z.number()]))]),
  /** §6.3: REQUIRED gates compatibility; OPTIONAL only lowers the score. */
  required: z.boolean().default(true),
  weight: z.number().int().min(MIN_RULE_WEIGHT).max(MAX_RULE_WEIGHT).default(3),
});
export type AudienceRule = z.infer<typeof AudienceRuleSchema>;

/**
 * §20 acceptance: "Buyer creates versioned audience with >=4 rules".
 *
 * Enforced as a floor rather than a suggestion: a one-rule audience is not an
 * audience, and it would match every Partner trivially while telling a Data
 * Partner almost nothing about what they are being asked to serve (§10).
 */
export const MIN_AUDIENCE_RULES = 4;
export const MAX_AUDIENCE_RULES = 20;

/* --- rule hashing (§10, §16) ------------------------------------------------ */

/**
 * Canonical form of one rule, for hashing.
 *
 * Key order is fixed and values are normalised so that two rules a human would
 * call identical hash identically — `IN ["A","B"]` and `IN ["B","A"]` select
 * the same people, so they must not produce different hashes and force a
 * needless re-approval.
 */
function canonicalRule(rule: AudienceRule): string {
  const value = Array.isArray(rule.value)
    ? // BETWEEN is ordered ([min, max]); every other list is a set.
      rule.operator === 'BETWEEN'
      ? rule.value
      : [...rule.value].map(String).sort()
    : rule.value;

  return JSON.stringify([
    rule.attribute,
    rule.operator,
    value,
    rule.required,
    // Weight is EXCLUDED on purpose: it changes the match score a Buyer sees,
    // not which people a Partner would return. Including it would invalidate a
    // Partner's approval over a cosmetic reweighting (§16).
  ]);
}

/**
 * §10: what a Partner's approval binds to.
 *
 * Rules are sorted by attribute so the hash does not depend on the order a
 * Buyer happened to add them in. The Go Agent implements the same function and
 * recomputes this before materializing — a mismatch means it is about to serve
 * something other than what was approved.
 */
export function canonicalAudienceRules(rules: AudienceRule[]): string {
  const canonical = rules.map(canonicalRule).sort();
  return `[${canonical.join(',')}]`;
}

/* --- capability matching (§7) ---------------------------------------------- */

export interface PartnerCapabilityAttribute {
  attribute_key: string;
  operators: RuleOperator[];
  status: 'AVAILABLE' | 'UNAVAILABLE';
}

export interface PartnerCapability {
  partner_org_id: string;
  capability_version: number;
  attributes: PartnerCapabilityAttribute[];
  geographies: string[];
  channels: string[];
}

export const MATCH_STATUSES = ['COMPATIBLE', 'INCOMPATIBLE'] as const;
export type MatchStatus = (typeof MATCH_STATUSES)[number];

export interface MatchResult {
  status: MatchStatus;
  /** 0-100 weighted coverage. §7: schema compatibility, NOT audience quality. */
  match_score: number;
  supported_rules: string[];
  missing_required_rules: string[];
  missing_optional_rules: string[];
  capability_version: number;
}

/**
 * §7 step 3: "check attribute + operator + geography/policy compatibility".
 *
 * All three in one predicate, because §7 applies the required/optional
 * asymmetry to a single per-rule verdict. Treating geography separately -- as
 * an extra gate that only fires on REQUIRED rules -- invents an asymmetry the
 * spec does not have, and a test caught exactly that.
 */
function supports(capability: PartnerCapability, rule: AudienceRule): boolean {
  const attr = capability.attributes.find((a) => a.attribute_key === rule.attribute);

  // §17 lets a Partner block individual attributes, which is what `status`
  // carries: an UNAVAILABLE attribute is one they have chosen not to answer
  // about, and it counts exactly as if they could not.
  if (!attr || attr.status !== 'AVAILABLE') return false;
  if (!attr.operators.includes(rule.operator)) return false;

  return coversGeography(capability, rule);
}

/**
 * Whether the Partner actually holds the geography this rule asks about.
 *
 * Being able to EVALUATE a `country` rule is not the same as having anyone in
 * that country. Without this, such a Partner is offered to the Buyer, accepts
 * the work, and returns BELOW_THRESHOLD from a query that could never have
 * matched.
 *
 * Deliberately narrow:
 *
 *   - Only `country`. `state_region` and `city` are sub-national while
 *     `geographies` is a country list; comparing them would reject Partners for
 *     a mismatch that does not exist.
 *   - A Partner that declares NO geographies is not gated. Absence of a
 *     declaration is missing metadata, not a claim to cover nowhere, and
 *     excluding them would silently punish an incomplete profile.
 */
function coversGeography(capability: PartnerCapability, rule: AudienceRule): boolean {
  if (rule.attribute !== 'country') return true;
  if (capability.geographies.length === 0) return true;

  const wanted = (Array.isArray(rule.value) ? rule.value : [rule.value]).map((v) =>
    String(v).toUpperCase(),
  );
  const covered = capability.geographies.map((g) => g.toUpperCase());
  return wanted.some((w) => covered.includes(w));
}

/**
 * §7's matching algorithm, exactly as written.
 *
 * The asymmetry is the point: a missing REQUIRED rule makes the Partner
 * INCOMPATIBLE and unselectable, while a missing OPTIONAL rule only lowers the
 * score. A Buyer who wants that Partner has to relax the requirement
 * deliberately — the system will not quietly serve a narrower audience than
 * they asked for.
 */
export function matchPartner(rules: AudienceRule[], capability: PartnerCapability): MatchResult {
  const supported: string[] = [];
  const missingRequired: string[] = [];
  const missingOptional: string[] = [];

  let supportedWeight = 0;
  let totalWeight = 0;

  for (const rule of rules) {
    totalWeight += rule.weight;

    if (supports(capability, rule)) {
      supported.push(rule.attribute);
      supportedWeight += rule.weight;
    } else if (rule.required) {
      missingRequired.push(rule.attribute);
    } else {
      missingOptional.push(rule.attribute);
    }
  }

  return {
    status: missingRequired.length > 0 ? 'INCOMPATIBLE' : 'COMPATIBLE',
    // A rules array cannot be empty in practice (MIN_AUDIENCE_RULES), but
    // dividing by zero would be a silent NaN rather than an obvious error.
    match_score: totalWeight === 0 ? 0 : Math.round((100 * supportedWeight) / totalWeight),
    supported_rules: supported,
    missing_required_rules: missingRequired,
    missing_optional_rules: missingOptional,
    capability_version: capability.capability_version,
  };
}

/* --- reach estimates (§8, §16) ---------------------------------------------- */

export const REACH_ESTIMATE_STATUSES = [
  'REQUESTED',
  'PROCESSING',
  'READY',
  'BELOW_THRESHOLD',
  'UNAVAILABLE',
  'FAILED',
  'EXPIRED',
] as const;
export type ReachEstimateStatus = (typeof REACH_ESTIMATE_STATUSES)[number];

/**
 * §8: how long an estimate stays usable.
 *
 * Bounded because an estimate describes a population that moves. §16 also ties
 * validity to the audience version, rule hash and the Partner's capability and
 * mapping versions — time is only one of the ways it can go stale.
 */
export const REACH_ESTIMATE_TTL_HOURS = 24;

/**
 * §17: repeated estimate requests for the same audience, Partner and version
 * are cached and rate-limited. Asking again inside this window returns the
 * stored answer rather than re-running the Partner's query — which also stops
 * repeated requests being used to watch a cohort change (§72 anti-differencing).
 */
export const REACH_ESTIMATE_MIN_REFRESH_MINUTES = 60;

export const AUDIENCE_GROUP_STATUSES = ['DRAFT', 'READY', 'ARCHIVED'] as const;
export type AudienceGroupStatus = (typeof AUDIENCE_GROUP_STATUSES)[number];

export const AUDIENCE_VERSION_STATUSES = ['DRAFT', 'READY', 'SUPERSEDED'] as const;
export type AudienceVersionStatus = (typeof AUDIENCE_VERSION_STATUSES)[number];

/** §19: which model a Partner request was built from. */
export const TARGETING_SOURCES = ['AUDIENCE_GROUP', 'PREBUILT_SEGMENT'] as const;
export type TargetingSource = (typeof TARGETING_SOURCES)[number];
