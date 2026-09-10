/**
 * Turning the attribute taxonomy into language a Buyer already speaks.
 *
 * The taxonomy is a machine contract: `purchase_recency_days`, `LTE`, `90`,
 * `CREDIT_CARD`. A Buyer describing who they want to reach should never have to
 * learn any of it. Everything here is presentation — the values sent to the API
 * are unchanged, so the rule the Data Partner approves is exactly the rule the
 * taxonomy defines.
 *
 * Shared by the builder and the read-only views so a rule reads identically
 * wherever it appears: composing it, reviewing it on the campaign, and seeing
 * it on a Partner's approval screen.
 */

export interface TaxonomyAttribute {
  key: string;
  display_name: string;
  description?: string;
  category: string;
  data_type: string;
  operators: string[];
  allowed_values?: string[] | null;
  min_value?: number | null;
  max_value?: number | null;
  unit?: string | null;
}

/** The order categories appear in. Broad and stable first, niche last. */
export const CATEGORY_ORDER = [
  'GEOGRAPHY',
  'DEMOGRAPHIC',
  'COMMERCE',
  'PAYMENT_BEHAVIOUR',
  'TRAVEL',
  'ENGAGEMENT',
] as const;

export const CATEGORY_LABELS: Record<string, string> = {
  DEMOGRAPHIC: 'Demographics',
  GEOGRAPHY: 'Location',
  COMMERCE: 'Shopping behaviour',
  PAYMENT_BEHAVIOUR: 'Payment',
  TRAVEL: 'Travel',
  ENGAGEMENT: 'Engagement',
};

/**
 * The three attributes that get their own Location section.
 *
 * Geography is not a behavioural condition — it is the first thing a Buyer
 * decides and the thing that most obviously narrows who they mean. It still
 * compiles into ordinary rules; only its position in the form is special.
 */
export const GEOGRAPHY_KEYS = ['country', 'state_region', 'city'] as const;

/**
 * Codes a Buyer should never have to decode.
 *
 * `IN` is India, not Indiana or "included". `DL` is Delhi. Everything not
 * listed falls through to the generic humaniser, which is fine for values that
 * are already words (`FOOTWEAR`, `GOLD`).
 */
const VALUE_LABELS: Record<string, string> = {
  IN: 'India',
  DL: 'Delhi',
  HR: 'Haryana',
  UP: 'Uttar Pradesh',
  KA: 'Karnataka',
  MH: 'Maharashtra',
  TN: 'Tamil Nadu',
  TG: 'Telangana',
  GJ: 'Gujarat',
  WB: 'West Bengal',
  RJ: 'Rajasthan',
  UPI: 'UPI',
  COD: 'Cash on delivery',
  NET_BANKING: 'Net banking',
  CREDIT_CARD: 'Credit card',
  DEBIT_CARD: 'Debit card',
  UNDISCLOSED: 'Not disclosed',
};

/** `CREDIT_CARD` -> `Credit card`, `GOLD` -> `Gold`, `UPI` -> `UPI`. */
export function valueLabel(raw: unknown): string {
  const value = String(raw);
  if (VALUE_LABELS[value]) return VALUE_LABELS[value];
  if (value.length <= 3) return value.toUpperCase();
  const words = value.toLowerCase().replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * The single operator an attribute supports.
 *
 * Every attribute in the MVP taxonomy declares exactly one, which is why the
 * builder shows no operator picker: choosing the attribute already determines
 * it. Offering a dropdown with one option asks the Buyer to make a decision
 * that was never theirs, and leaving it unset — as an earlier build did — makes
 * an invalid rule reachable.
 */
export function operatorFor(attr: TaxonomyAttribute): string {
  return attr.operators[0] ?? 'EQ';
}

/**
 * How the condition reads in a sentence, before its value.
 *
 * `purchase_recency_days LTE 90` becomes "Purchased within — last 90 days".
 * The unit does the work: an LTE on days is a recency window, an LTE on
 * anything else is a ceiling.
 */
export function operatorPhrase(attr: TaxonomyAttribute): string {
  switch (operatorFor(attr)) {
    case 'BETWEEN':
      return 'between';
    case 'IN':
      return 'is any of';
    case 'GTE':
      return 'at least';
    case 'LTE':
      return attr.unit === 'days' ? 'within the last' : 'at most';
    default:
      return 'is';
  }
}

/** The whole condition as one readable line, for summaries and review screens. */
export function describeRule(
  attr: TaxonomyAttribute | undefined,
  value: unknown,
  attributeKey: string,
): string {
  if (!attr) return `${attributeKey}: ${JSON.stringify(value)}`;

  const op = operatorFor(attr);

  if (attr.data_type === 'BOOLEAN') {
    return `${attr.display_name}: ${value === true ? 'Yes' : 'No'}`;
  }
  if (op === 'BETWEEN' && Array.isArray(value)) {
    return `${attr.display_name}: ${value[0]}–${value[1]}${attr.unit ? ` ${attr.unit}` : ''}`;
  }
  if (op === 'IN') {
    const list = Array.isArray(value) ? value : [value];
    return `${attr.display_name}: ${list.map(valueLabel).join(' or ')}`;
  }
  if (op === 'LTE' && attr.unit === 'days') {
    return `${attr.display_name}: within ${value} days`;
  }
  if (op === 'GTE') {
    return `${attr.display_name}: ${value}+${attr.unit ? ` ${attr.unit}` : ''}`;
  }
  return `${attr.display_name}: ${valueLabel(value)}`;
}

/**
 * §7's weight, as something a Buyer can reason about.
 *
 * A number from 1 to 5 invites false precision — nobody can defend 4 over 3.
 * Three named levels say the only thing the score actually uses them for:
 * which optional condition matters more when ranking Partners.
 */
export const IMPORTANCE = [
  { value: 1, label: 'Low' },
  { value: 3, label: 'Medium' },
  { value: 5, label: 'High' },
] as const;

export function importanceLabel(weight: number): string {
  if (weight >= 5) return 'High';
  if (weight >= 3) return 'Medium';
  return 'Low';
}

/** A sensible starting value, so a new condition is never in an invalid state. */
export function defaultValueFor(attr: TaxonomyAttribute): unknown {
  const op = operatorFor(attr);

  // A boolean has two states and one of them is the reason you added the
  // condition, so Yes is a safe starting point.
  if (attr.data_type === 'BOOLEAN') return true;

  // Everything else starts EMPTY, and the condition counts as unfinished until
  // the Buyer fills it.
  //
  // Pre-filling a range with the attribute's own bounds looked helpful and was
  // the opposite: "Age 13-120" reads as a deliberate choice, matches every
  // person alive, and would ship unnoticed. The builder should never invent a
  // targeting decision on the Buyer's behalf — an empty box asks the question
  // that a plausible-looking default quietly answers for them.
  if (op === 'BETWEEN') return ['', ''];
  if (op === 'IN') return [];
  return '';
}

/**
 * A number the Buyer actually typed.
 *
 * `Number('')` is 0 and `Number.isFinite(0)` is true, so testing finiteness
 * alone treats an empty box as the deliberate value zero — an empty "Purchased
 * within" would have submitted as "within 0 days" and matched nobody.
 */
function isFilledNumber(value: unknown): boolean {
  if (value === '' || value === null || value === undefined) return false;
  return Number.isFinite(Number(value));
}

/** Whether a condition is complete enough to submit. */
export function isRuleComplete(attr: TaxonomyAttribute | undefined, value: unknown): boolean {
  if (!attr) return false;
  const op = operatorFor(attr);
  if (attr.data_type === 'BOOLEAN') return typeof value === 'boolean';
  if (op === 'IN') return Array.isArray(value) && value.length > 0;
  if (op === 'BETWEEN') {
    return (
      Array.isArray(value) &&
      value.length === 2 &&
      isFilledNumber(value[0]) &&
      isFilledNumber(value[1]) &&
      Number(value[0]) <= Number(value[1])
    );
  }
  return isFilledNumber(value);
}
