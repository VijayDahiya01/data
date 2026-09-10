/**
 * Reach bucket translation between the database and the wire (§72).
 *
 * §72 fixes the published bucket values -- `100K_250K` and friends. Prisma
 * enum members cannot begin with a digit, so the schema spells them
 * `HUNDRED_K_250K` and `@map`s them to the real column values. That leaves two
 * vocabularies in the codebase, and every response that forgets to translate
 * leaks the database spelling into a canonical API field.
 *
 * That is not cosmetic. §86 makes the OpenAPI file authoritative for HTTP
 * shapes and it declares the §72 enum, so an untranslated value is a client
 * that fails to parse a valid response -- and, on a Partner's approval screen,
 * a reach estimate rendered as `HUNDRED_K_250K` to somebody being asked to
 * make a commercial decision (§41).
 *
 * Both directions live here so they cannot drift apart.
 */
import type { ReachBucket } from '@oolix/contracts';

/** Wire value (§72) -> Prisma enum member. */
export const BUCKET_TO_DB: Readonly<Record<ReachBucket, string>> = Object.freeze({
  UNDER_10K: 'UNDER_10K',
  '10K_50K': 'TEN_K_50K',
  '50K_100K': 'FIFTY_K_100K',
  '100K_250K': 'HUNDRED_K_250K',
  '250K_500K': 'TWOFIFTY_K_500K',
  '500K_1M': 'FIVEHUNDRED_K_1M',
  OVER_1M: 'OVER_1M',
});

/** Prisma enum member -> wire value (§72). Derived, so it cannot fall behind. */
export const BUCKET_FROM_DB: Readonly<Record<string, ReachBucket>> = Object.freeze(
  Object.fromEntries(Object.entries(BUCKET_TO_DB).map(([wire, db]) => [db, wire as ReachBucket])),
) as Readonly<Record<string, ReachBucket>>;

/**
 * Translate a stored bucket for output.
 *
 * An unrecognised value is passed through rather than dropped: losing a reach
 * bucket entirely would be worse for the reader than showing an odd one, and
 * the contract test is what catches the omission.
 */
export function toWireBucket(stored: string | null | undefined): ReachBucket | null {
  if (!stored) return null;
  return BUCKET_FROM_DB[stored] ?? (stored as ReachBucket);
}
