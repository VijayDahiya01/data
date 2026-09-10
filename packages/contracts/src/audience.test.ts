/**
 * v6 §7 capability matching and §10 rule hashing.
 *
 * These two functions decide things that are hard to walk back. The match
 * result decides which Data Partners a Buyer may even ask; the rule hash is
 * what a Partner's approval binds to, so a Partner is entitled to assume that
 * an unchanged hash means an unchanged audience.
 */
import { describe, expect, it } from 'vitest';
import {
  canonicalAudienceRules,
  matchPartner,
  MIN_AUDIENCE_RULES,
  OPERATORS_FOR_TYPE,
  type AudienceRule,
  type PartnerCapability,
} from './audience.js';

const rule = (over: Partial<AudienceRule> & Pick<AudienceRule, 'attribute'>): AudienceRule => ({
  operator: 'EQ',
  value: true,
  required: true,
  weight: 3,
  ...over,
});

/** §6.3's worked example: the Urban Shoe Shoppers audience. */
const SHOE_RULES: AudienceRule[] = [
  { attribute: 'age', operator: 'BETWEEN', value: [18, 35], required: true, weight: 5 },
  { attribute: 'online_shopper', operator: 'EQ', value: true, required: true, weight: 5 },
  {
    attribute: 'purchase_category',
    operator: 'IN',
    value: ['FOOTWEAR'],
    required: true,
    weight: 5,
  },
  {
    attribute: 'purchase_recency_days',
    operator: 'LTE',
    value: 90,
    required: true,
    weight: 4,
  },
  { attribute: 'gender', operator: 'IN', value: ['MALE', 'FEMALE'], required: false, weight: 1 },
  {
    attribute: 'payment_method',
    operator: 'IN',
    value: ['UPI', 'CREDIT_CARD'],
    required: false,
    weight: 2,
  },
];

const capability = (
  attrs: Array<[string, string[]]>,
  over: Partial<PartnerCapability> = {},
): PartnerCapability => ({
  partner_org_id: 'org_partner_a',
  capability_version: 4,
  attributes: attrs.map(([attribute_key, operators]) => ({
    attribute_key,
    operators: operators as never,
    status: 'AVAILABLE',
  })),
  geographies: ['IN'],
  channels: ['PARTNER_WEB'],
  ...over,
});

/** Everything the §6.3 audience asks for. §7's "Commerce A" row. */
const FULL = capability([
  ['age', ['BETWEEN']],
  ['online_shopper', ['EQ']],
  ['purchase_category', ['IN']],
  ['purchase_recency_days', ['LTE']],
  ['gender', ['IN']],
  ['payment_method', ['IN']],
]);

describe('matchPartner (§7)', () => {
  it('scores a Partner that supports everything at 100', () => {
    const result = matchPartner(SHOE_RULES, FULL);

    expect(result.status).toBe('COMPATIBLE');
    expect(result.match_score).toBe(100);
    expect(result.missing_required_rules).toEqual([]);
    expect(result.missing_optional_rules).toEqual([]);
    expect(result.capability_version).toBe(4);
  });

  it('stays COMPATIBLE when only an OPTIONAL rule is missing, but scores lower', () => {
    // §7's "Rewards B" row: 4/4 required, 1/2 optional.
    const partial = capability([
      ['age', ['BETWEEN']],
      ['online_shopper', ['EQ']],
      ['purchase_category', ['IN']],
      ['purchase_recency_days', ['LTE']],
      ['gender', ['IN']],
    ]);

    const result = matchPartner(SHOE_RULES, partial);

    expect(result.status).toBe('COMPATIBLE');
    // 20 of 22 weight: the missing payment_method carries weight 2.
    expect(result.match_score).toBe(91);
    expect(result.missing_optional_rules).toEqual(['payment_method']);
    expect(result.missing_required_rules).toEqual([]);
  });

  it('is INCOMPATIBLE when a REQUIRED rule is missing, however high the score', () => {
    // §7's "Retail C" row: 3/4 required, 2/2 optional. Most of the weight is
    // covered, and it still cannot be selected — that asymmetry is the whole
    // point of marking a rule required.
    const missingRequired = capability([
      ['age', ['BETWEEN']],
      ['online_shopper', ['EQ']],
      ['purchase_category', ['IN']],
      ['gender', ['IN']],
      ['payment_method', ['IN']],
    ]);

    const result = matchPartner(SHOE_RULES, missingRequired);

    expect(result.status).toBe('INCOMPATIBLE');
    expect(result.missing_required_rules).toEqual(['purchase_recency_days']);
    expect(result.match_score).toBeGreaterThan(80);
  });

  it('treats a supported attribute with the wrong operator as unsupported', () => {
    // A Partner that can test `purchase_recency_days` for equality cannot
    // answer "within the last 90 days". Claiming the attribute is not the same
    // as being able to evaluate the rule (§7 step 3).
    const wrongOperator = capability([
      ['age', ['BETWEEN']],
      ['online_shopper', ['EQ']],
      ['purchase_category', ['IN']],
      ['purchase_recency_days', ['EQ']],
    ]);

    const result = matchPartner(SHOE_RULES, wrongOperator);

    expect(result.status).toBe('INCOMPATIBLE');
    expect(result.missing_required_rules).toEqual(['purchase_recency_days']);
  });

  it('treats an attribute the Partner marked UNAVAILABLE as unsupported', () => {
    // §17: "Partner may block attributes, Buyers, categories, purposes or
    // channels." Publishing an attribute as UNAVAILABLE is how a Partner
    // declines to be matched on it.
    const blocked = capability([
      ['age', ['BETWEEN']],
      ['online_shopper', ['EQ']],
      ['purchase_category', ['IN']],
      ['purchase_recency_days', ['LTE']],
    ]);
    blocked.attributes[3]!.status = 'UNAVAILABLE';

    expect(matchPartner(SHOE_RULES, blocked).status).toBe('INCOMPATIBLE');
  });

  it('scores by weight, not by how many rules matched', () => {
    const rules: AudienceRule[] = [
      rule({ attribute: 'a', weight: 5, required: false }),
      rule({ attribute: 'b', weight: 1, required: false }),
    ];

    // Supporting the single heavy rule beats supporting the light one.
    expect(matchPartner(rules, capability([['a', ['EQ']]])).match_score).toBe(83);
    expect(matchPartner(rules, capability([['b', ['EQ']]])).match_score).toBe(17);
  });

  it('reports a Partner that supports nothing as INCOMPATIBLE at zero', () => {
    const result = matchPartner(SHOE_RULES, capability([]));

    expect(result.status).toBe('INCOMPATIBLE');
    expect(result.match_score).toBe(0);
    expect(result.supported_rules).toEqual([]);
  });

  it('never returns NaN for an empty rule set', () => {
    // MIN_AUDIENCE_RULES makes this unreachable through the API, but a silent
    // NaN score would be far worse than an obvious zero.
    expect(matchPartner([], capability([])).match_score).toBe(0);
  });
});

describe('canonicalAudienceRules (§10, §16)', () => {
  it('is stable regardless of the order rules were added in', () => {
    const reordered = [...SHOE_RULES].reverse();
    expect(canonicalAudienceRules(reordered)).toBe(canonicalAudienceRules(SHOE_RULES));
  });

  it('is stable regardless of the order of values within an IN list', () => {
    // `IN [UPI, CREDIT_CARD]` and `IN [CREDIT_CARD, UPI]` select the same
    // people. Hashing them differently would force a Partner to re-approve an
    // audience that had not changed.
    const a = [
      rule({ attribute: 'payment_method', operator: 'IN', value: ['UPI', 'CREDIT_CARD'] }),
    ];
    const b = [
      rule({ attribute: 'payment_method', operator: 'IN', value: ['CREDIT_CARD', 'UPI'] }),
    ];

    expect(canonicalAudienceRules(a)).toBe(canonicalAudienceRules(b));
  });

  it('preserves the order of a BETWEEN range', () => {
    // [18, 35] and [35, 18] are not the same rule, so they must not collide.
    const a = [rule({ attribute: 'age', operator: 'BETWEEN', value: [18, 35] })];
    const b = [rule({ attribute: 'age', operator: 'BETWEEN', value: [35, 18] })];

    expect(canonicalAudienceRules(a)).not.toBe(canonicalAudienceRules(b));
  });

  it('changes when a value changes', () => {
    const a = [rule({ attribute: 'purchase_recency_days', operator: 'LTE', value: 90 })];
    const b = [rule({ attribute: 'purchase_recency_days', operator: 'LTE', value: 30 })];

    expect(canonicalAudienceRules(a)).not.toBe(canonicalAudienceRules(b));
  });

  it('changes when a rule moves between REQUIRED and OPTIONAL', () => {
    // This changes which Partners are compatible, so it is a different
    // audience and needs a fresh approval.
    const required = [
      rule({ attribute: 'gender', operator: 'IN', value: ['MALE'], required: true }),
    ];
    const optional = [
      rule({ attribute: 'gender', operator: 'IN', value: ['MALE'], required: false }),
    ];

    expect(canonicalAudienceRules(required)).not.toBe(canonicalAudienceRules(optional));
  });

  it('does NOT change when only a weight changes', () => {
    // Weight moves the match score a Buyer sees; it does not change which
    // people a Partner would return. Invalidating an approval over a cosmetic
    // reweighting would make Partners re-approve for nothing (§16).
    const light = [rule({ attribute: 'gender', operator: 'IN', value: ['MALE'], weight: 1 })];
    const heavy = [rule({ attribute: 'gender', operator: 'IN', value: ['MALE'], weight: 5 })];

    expect(canonicalAudienceRules(light)).toBe(canonicalAudienceRules(heavy));
  });
});

describe('taxonomy guards (§4)', () => {
  it('offers only operators that make sense for each data type', () => {
    expect(OPERATORS_FOR_TYPE.BOOLEAN).toEqual(['EQ']);
    expect(OPERATORS_FOR_TYPE.ENUM).not.toContain('BETWEEN');
    expect(OPERATORS_FOR_TYPE.NUMBER).toContain('BETWEEN');
  });

  it('requires an audience to say something (§20)', () => {
    expect(MIN_AUDIENCE_RULES).toBeGreaterThanOrEqual(4);
  });
});

/**
 * §7 step 3: "check attribute + operator + geography/policy compatibility".
 *
 * Being able to evaluate a `country` rule is not the same as holding anyone in
 * that country. Without this gate such a Partner is offered to the Buyer,
 * accepts the work, and comes back BELOW_THRESHOLD having run a query that
 * could never have matched.
 */
describe('matchPartner geography compatibility (§7)', () => {
  const INDIA_RULES: AudienceRule[] = [
    ...SHOE_RULES,
    { attribute: 'country', operator: 'IN', value: ['IN'], required: true, weight: 5 },
  ];

  const withCountry = (geographies: string[]) =>
    capability(
      [
        ['age', ['BETWEEN']],
        ['online_shopper', ['EQ']],
        ['purchase_category', ['IN']],
        ['purchase_recency_days', ['LTE']],
        ['gender', ['IN']],
        ['payment_method', ['IN']],
        ['country', ['IN']],
      ],
      { geographies },
    );

  it('accepts a Partner covering the required country', () => {
    const result = matchPartner(INDIA_RULES, withCountry(['IN']));

    expect(result.status).toBe('COMPATIBLE');
    expect(result.supported_rules).toContain('country');
  });

  it('excludes a Partner that cannot reach the required country', () => {
    const result = matchPartner(INDIA_RULES, withCountry(['AE']));

    expect(result.status).toBe('INCOMPATIBLE');
    expect(result.missing_required_rules).toContain('country');
    // Named once, not in both lists: the Buyer is told which rule failed, and a
    // rule cannot be simultaneously supported and missing.
    expect(result.supported_rules).not.toContain('country');
  });

  it('matches on any one of several requested countries', () => {
    const multi: AudienceRule[] = [
      ...SHOE_RULES,
      { attribute: 'country', operator: 'IN', value: ['IN', 'AE'], required: true, weight: 5 },
    ];

    expect(matchPartner(multi, withCountry(['AE'])).status).toBe('COMPATIBLE');
  });

  it('compares countries case-insensitively', () => {
    expect(matchPartner(INDIA_RULES, withCountry(['in'])).status).toBe('COMPATIBLE');
  });

  it('does not exclude on an OPTIONAL country rule', () => {
    // §7 is explicit that a missing optional rule lowers the score rather than
    // excluding, and geography is checked the same way as any other rule.
    const optional: AudienceRule[] = [
      ...SHOE_RULES,
      { attribute: 'country', operator: 'IN', value: ['IN'], required: false, weight: 1 },
    ];
    const result = matchPartner(optional, withCountry(['AE']));

    expect(result.status).toBe('COMPATIBLE');
    expect(result.missing_optional_rules).toContain('country');
    expect(result.match_score).toBeLessThan(100);
  });

  it('does not exclude a Partner who declared no geographies at all', () => {
    // Absence of a declaration is missing metadata, not a claim to cover
    // nowhere. Excluding them would silently punish an incomplete profile.
    expect(matchPartner(INDIA_RULES, withCountry([])).status).toBe('COMPATIBLE');
  });

  it('ignores geography when the audience does not constrain country', () => {
    // SHOE_RULES has no country rule, so a Partner's declared geography is not
    // something to test against.
    expect(matchPartner(SHOE_RULES, withCountry(['AE'])).status).toBe('COMPATIBLE');
  });
});
