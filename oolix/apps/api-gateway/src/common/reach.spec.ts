/**
 * §72 publishes a fixed set of bucket values, and §86 makes the OpenAPI file
 * authoritative for them. The database spells the same buckets differently
 * because a Prisma enum member cannot begin with a digit, so every response
 * has to translate.
 *
 * This existed as an untranslated field on the campaign detail and the Partner
 * approval screen: a Partner was shown `HUNDRED_K_250K` while deciding whether
 * to accept a campaign (§41), and a generated client with a strict enum would
 * have rejected the response outright.
 */
import { REACH_BUCKETS, type ReachBucket } from '@oolix/contracts';
import { BUCKET_FROM_DB, BUCKET_TO_DB, toWireBucket } from './reach.js';

describe('reach bucket translation (§72)', () => {
  it('covers every canonical bucket', () => {
    // A bucket added to §72 without a database spelling would silently fall
    // through `toWireBucket` untranslated.
    expect(Object.keys(BUCKET_TO_DB).sort()).toEqual([...REACH_BUCKETS].sort());
  });

  it('round-trips every bucket', () => {
    for (const bucket of REACH_BUCKETS) {
      expect(BUCKET_FROM_DB[BUCKET_TO_DB[bucket]!]).toBe(bucket);
    }
  });

  it('maps the database spellings §72 cannot use directly', () => {
    // These four are the whole reason the mapping exists: they begin with a
    // digit, which Prisma will not accept as an enum member.
    expect(toWireBucket('TEN_K_50K')).toBe('10K_50K');
    expect(toWireBucket('FIFTY_K_100K')).toBe('50K_100K');
    expect(toWireBucket('HUNDRED_K_250K')).toBe('100K_250K');
    expect(toWireBucket('TWOFIFTY_K_500K')).toBe('250K_500K');
    expect(toWireBucket('FIVEHUNDRED_K_1M')).toBe('500K_1M');
  });

  it('leaves values that need no translation alone', () => {
    expect(toWireBucket('UNDER_10K')).toBe('UNDER_10K');
    expect(toWireBucket('OVER_1M')).toBe('OVER_1M');
  });

  it('treats an absent bucket as absent, not as a label', () => {
    // §72: a segment below the publishable minimum has no bucket at all, and
    // rendering one would imply a cohort that was deliberately suppressed.
    expect(toWireBucket(null)).toBeNull();
    expect(toWireBucket(undefined)).toBeNull();
    expect(toWireBucket('')).toBeNull();
  });

  it('never emits a value outside the §72 enum for a known input', () => {
    const canonical = new Set<string>(REACH_BUCKETS);
    for (const stored of Object.keys(BUCKET_FROM_DB)) {
      expect(canonical.has(toWireBucket(stored) as ReachBucket)).toBe(true);
    }
  });
});
