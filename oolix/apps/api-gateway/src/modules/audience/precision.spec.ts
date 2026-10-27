/**
 * Precision notes: a rule narrower than how a Partner holds an attribute
 * reaches none of its customers, and the Buyer is told how to widen it.
 */
import type { AudienceRule, PartnerCapabilityAttribute } from '@oolix/contracts';
import { precisionNotes } from './precision.js';
import { CapabilityPrecisionSchema } from './audience.schema.js';

const rule = (
  attribute: string,
  operator: AudienceRule['operator'],
  value: unknown,
): AudienceRule => ({ attribute, operator, value, required: true, weight: 1 }) as AudienceRule;

const names = (key: string) =>
  ({ age: 'Age', purchase_recency_days: 'Days since last purchase' })[key] ?? key;

const bands: PartnerCapabilityAttribute = {
  attribute_key: 'age',
  operators: ['BETWEEN'],
  status: 'AVAILABLE',
  precision: {
    kind: 'BANDS',
    unit: 'YEARS',
    bands: [
      { lo: 18, hi: 24 },
      { lo: 25, hi: 45 },
      { lo: 46, hi: null },
    ],
  },
};

describe('precisionNotes', () => {
  it('says nothing for a Partner that knows the attribute exactly', () => {
    const exact = { ...bands, precision: undefined };
    expect(precisionNotes([rule('age', 'BETWEEN', [30, 40])], [exact], names)).toEqual([]);
  });

  it('says nothing when a whole group fits inside the rule', () => {
    expect(precisionNotes([rule('age', 'BETWEEN', [25, 50])], [bands], names)).toEqual([]);
  });

  it('suggests the groups to widen to when none fits', () => {
    const [note] = precisionNotes([rule('age', 'BETWEEN', [30, 40])], [bands], names);
    expect(note).toContain('18-24, 25-45, 46+');
    expect(note).toContain('Widen the rule to 25-45');
  });

  it('widens to an open group as "or older"', () => {
    const [note] = precisionNotes([rule('age', 'BETWEEN', [40, 60])], [bands], names);
    expect(note).toContain('Widen the rule to 25 or older');
  });

  it('flags a recency rule shorter than a yes/no window', () => {
    const within: PartnerCapabilityAttribute = {
      attribute_key: 'purchase_recency_days',
      operators: ['LTE'],
      status: 'AVAILABLE',
      precision: { kind: 'WITHIN', days: 30 },
    };
    expect(precisionNotes([rule('purchase_recency_days', 'LTE', 7)], [within], names)[0]).toContain(
      'Allow 30 or more',
    );
    expect(precisionNotes([rule('purchase_recency_days', 'LTE', 30)], [within], names)).toEqual([]);
  });

  it('ignores attributes the Partner withdrew', () => {
    expect(
      precisionNotes(
        [rule('age', 'BETWEEN', [30, 40])],
        [{ ...bands, status: 'UNAVAILABLE' }],
        names,
      ),
    ).toEqual([]);
  });
});

describe('CapabilityPrecisionSchema', () => {
  it('accepts the formats an Agent publishes', () => {
    for (const p of [
      {
        kind: 'BANDS',
        unit: 'YEARS',
        bands: [
          { lo: 18, hi: 24 },
          { lo: 60, hi: null },
        ],
      },
      { kind: 'APPROXIMATE', unit: 'YEARS', width: 1 },
      { kind: 'WITHIN', days: 30 },
      { kind: 'WINDOW', days: 30 },
    ]) {
      expect(CapabilityPrecisionSchema.safeParse(p).success).toBe(true);
    }
  });

  it('refuses anything that is not a format', () => {
    for (const p of [
      { kind: 'BANDS', unit: 'YEARS' },
      { kind: 'BANDS', unit: 'YEARS', bands: [{ lo: 45, hi: 25 }] },
      { kind: 'WITHIN' },
      { kind: 'APPROXIMATE', unit: 'YEARS', width: 1, customers: 1200 },
      { kind: 'EXACT_VALUES', values: [31, 32] },
    ]) {
      expect(CapabilityPrecisionSchema.safeParse(p).success).toBe(false);
    }
  });
});
