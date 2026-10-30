/**
 * How a Partner is paid when the Buyer does not say otherwise.
 *
 * Outcome campaigns pay per qualified lead: §102 settles CPQL on leads the
 * Buyer's CRM confirms, CONVERTED ones included. Delivery campaigns pay per
 * thousand impressions -- §50 forbids paying on unverified clicks. The Partner
 * still has to accept the basis, and a Buyer who wants another one customises
 * that Partner instead.
 */
export interface Payout {
  model: 'CPQL' | 'CPM';
  unit_price_minor: number;
}

export function defaultPayout(objective: string): Payout {
  return objective === 'QUALIFIED_LEADS' || objective === 'CONVERSIONS'
    ? { model: 'CPQL', unit_price_minor: 400_000 }
    : { model: 'CPM', unit_price_minor: 15_000 };
}

/** "₹4,000 per qualified lead" */
export function payoutInWords(objective: string, currency: string): string {
  const p = defaultPayout(objective);
  const price = new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency,
    maximumFractionDigits: 0,
  }).format(p.unit_price_minor / 100);
  return p.model === 'CPQL' ? `${price} per qualified lead` : `${price} per 1,000 views`;
}
