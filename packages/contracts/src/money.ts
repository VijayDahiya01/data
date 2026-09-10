/**
 * Money handling -- spec v5 §53, §73, §102.
 *
 * Money is ALWAYS integer minor units plus an ISO-4217 code. There is no
 * floating point anywhere in this codebase's financial path: §50 requires
 * every financial calculation to be reproducible from immutable settlement
 * inputs, and binary floats are not reproducible under summation reordering.
 */
import { z } from 'zod';

export const CurrencySchema = z
  .string()
  .length(3)
  .regex(/^[A-Z]{3}$/, 'ISO-4217 uppercase alpha-3');

export const MoneySchema = z.object({
  amount_minor: z.number().int(),
  currency: CurrencySchema,
});

export type Money = z.infer<typeof MoneySchema>;

/** Minor units per major unit. Extend as launch jurisdictions are added. */
const MINOR_UNIT_EXPONENT: Readonly<Record<string, number>> = Object.freeze({
  INR: 2,
  USD: 2,
  EUR: 2,
  GBP: 2,
  AED: 2,
  SGD: 2,
  // Zero-decimal currencies -- getting these wrong inflates an invoice 100x.
  JPY: 0,
  KRW: 0,
  VND: 0,
  // Three-decimal.
  BHD: 3,
  KWD: 3,
  OMR: 3,
});

export function minorUnitExponent(currency: string): number {
  return MINOR_UNIT_EXPONENT[currency.toUpperCase()] ?? 2;
}

export function money(amountMinor: number, currency: string): Money {
  if (!Number.isInteger(amountMinor)) {
    throw new TypeError(`amount_minor must be an integer, received ${amountMinor}`);
  }
  return { amount_minor: amountMinor, currency: currency.toUpperCase() };
}

function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    // §40.2 fixes one currency per campaign, so a mismatch is a bug upstream,
    // not a case to silently convert.
    throw new Error(`currency mismatch: ${a.currency} vs ${b.currency}`);
  }
}

export function addMoney(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return { amount_minor: a.amount_minor + b.amount_minor, currency: a.currency };
}

export function subtractMoney(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return { amount_minor: a.amount_minor - b.amount_minor, currency: a.currency };
}

export function sumMoney(items: readonly Money[], currency: string): Money {
  return items.reduce<Money>((acc, m) => addMoney(acc, m), {
    amount_minor: 0,
    currency: currency.toUpperCase(),
  });
}

/**
 * Multiply money by a whole quantity -- the CPQL / CPL / CPM shape from §102
 * (unit price x verified outcome count). Quantity must be an integer because
 * outcomes are counted, never fractional.
 */
export function multiplyMoney(unit: Money, quantity: number): Money {
  if (!Number.isInteger(quantity) || quantity < 0) {
    throw new TypeError(`quantity must be a non-negative integer, received ${quantity}`);
  }
  return { amount_minor: unit.amount_minor * quantity, currency: unit.currency };
}

/**
 * Apply a percentage fee (§102: platform fee = 10% of qualified-lead media).
 *
 * `basisPoints` avoids fractional percentages entirely: 10% is 1000 bps.
 * Rounding is half-up on the minor unit, applied once, so the result is
 * deterministic and reproducible for settlement.
 */
export function percentageOf(amount: Money, basisPoints: number): Money {
  if (!Number.isInteger(basisPoints) || basisPoints < 0) {
    throw new TypeError(`basisPoints must be a non-negative integer, received ${basisPoints}`);
  }
  const product = amount.amount_minor * basisPoints;
  const rounded = Math.floor((product + 5_000) / 10_000);
  return { amount_minor: rounded, currency: amount.currency };
}

export function compareMoney(a: Money, b: Money): number {
  assertSameCurrency(a, b);
  return a.amount_minor === b.amount_minor ? 0 : a.amount_minor < b.amount_minor ? -1 : 1;
}

/** Display helper. Presentation only -- never feed this back into arithmetic. */
export function formatMoney(m: Money, locale = 'en-IN'): string {
  const exp = minorUnitExponent(m.currency);
  const major = m.amount_minor / 10 ** exp;
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: m.currency,
    minimumFractionDigits: exp,
    maximumFractionDigits: exp,
  }).format(major);
}

/** Convert a human major-unit figure (form input) into minor units. */
export function majorToMinor(major: number, currency: string): Money {
  const exp = minorUnitExponent(currency);
  const scaled = Math.round(major * 10 ** exp);
  return money(scaled, currency);
}
