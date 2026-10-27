/**
 * What a Partner's precision means for one audience, in words a Buyer can act
 * on (docs/DESIGN-PARTNER-DATA.md §5).
 *
 * A Partner's Agent answers a rule with the customers who CERTAINLY match it.
 * One that holds ages as groups 25-45 cannot say who is 30 to 40, so a 30-40
 * rule reaches none of its customers -- correctly, but invisibly. Its
 * capability says how it holds the attribute, and these notes turn that into
 * advice: widen the rule to 25-45 to include them.
 *
 * Format only goes in and words come out. No count, no customer, no value.
 */
import type {
  AudienceRule,
  CapabilityPrecision,
  PartnerCapabilityAttribute,
} from '@oolix/contracts';

type Band = NonNullable<CapabilityPrecision['bands']>[number];

const bandText = (b: Band) => (b.hi === null ? `${b.lo}+` : `${b.lo}-${b.hi}`);

export function precisionNotes(
  rules: AudienceRule[],
  attributes: PartnerCapabilityAttribute[],
  displayName: (key: string) => string,
): string[] {
  const notes: string[] = [];
  for (const rule of rules) {
    const precision = attributes.find(
      (a) => a.attribute_key === rule.attribute && a.status !== 'UNAVAILABLE',
    )?.precision;
    if (!precision) continue;
    const name = displayName(rule.attribute);
    const note = noteFor(rule, precision, name);
    if (note) notes.push(note);
  }
  return notes;
}

function noteFor(rule: AudienceRule, p: CapabilityPrecision, name: string): string | null {
  switch (p.kind) {
    case 'BANDS': {
      if (rule.operator !== 'BETWEEN' || !Array.isArray(rule.value) || !p.bands) return null;
      const [lo, hi] = rule.value as [number, number];
      // A group fits when every age in it is inside the rule.
      if (p.bands.some((b) => b.lo >= lo && b.hi !== null && b.hi <= hi)) return null;
      const groups = p.bands.map(bandText).join(', ');
      const overlapping = p.bands.filter((b) => b.lo <= hi && (b.hi === null || b.hi >= lo));
      if (overlapping.length === 0) {
        return `${name}: held only as the groups ${groups}, and none of them is inside ${lo}-${hi}.`;
      }
      const from = Math.min(...overlapping.map((b) => b.lo));
      const to = overlapping.some((b) => b.hi === null)
        ? null
        : Math.max(...overlapping.map((b) => b.hi as number));
      const widened = to === null ? `${from} or older` : `${from}-${to}`;
      return (
        `${name}: held only as the groups ${groups}, so no customer is certainly ${lo}-${hi}. ` +
        `Widen the rule to ${widened} to reach them.`
      );
    }
    case 'WITHIN': {
      if (rule.operator !== 'LTE' || typeof rule.value !== 'number' || !p.days) return null;
      if (rule.value >= p.days) return null;
      return (
        `${name}: known only as yes or no for the last ${p.days} days, so "${rule.value} or fewer" ` +
        `reaches none of this Partner's customers. Allow ${p.days} or more to include them.`
      );
    }
    case 'WINDOW': {
      if (rule.operator !== 'GTE' || !p.days) return null;
      return (
        `${name}: counted over the last ${p.days} days, so only customers with ${String(rule.value)} or ` +
        `more in those ${p.days} days are included.`
      );
    }
    case 'APPROXIMATE': {
      if (rule.operator !== 'BETWEEN' || !Array.isArray(rule.value) || !p.width) return null;
      const [lo, hi] = rule.value as [number, number];
      if (hi - lo + 1 >= p.width) return null;
      const unit = p.unit === 'DAYS' ? 'days' : 'years';
      return `${name}: known to within ${p.width} ${unit}, wider than ${lo}-${hi}, so few or no customers match it.`;
    }
  }
  return null;
}
