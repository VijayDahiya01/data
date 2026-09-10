/**
 * Reach buckets, minimum audience size and anti-differencing -- spec v5 §72.
 *
 * The Buyer never sees an exact segment count. §72 removed the earlier
 * "exact count if the Partner allows" option from the canonical
 * implementation, so exact reach exists only inside the Data Partner.
 */
import { z } from 'zod';

export const REACH_BUCKETS = [
  'UNDER_10K',
  '10K_50K',
  '50K_100K',
  '100K_250K',
  '250K_500K',
  '500K_1M',
  'OVER_1M',
] as const;

export type ReachBucket = (typeof REACH_BUCKETS)[number];
export const ReachBucketSchema = z.enum(REACH_BUCKETS);

/** Buyer-facing labels (§72 table). */
export const REACH_BUCKET_LABELS: Readonly<Record<ReachBucket, string>> = Object.freeze({
  UNDER_10K: '< 10,000',
  '10K_50K': '10,000-50,000',
  '50K_100K': '50,000-100,000',
  '100K_250K': '100,000-250,000',
  '250K_500K': '250,000-500,000',
  '500K_1M': '500,000-1,000,000',
  OVER_1M: '1,000,000+',
});

/**
 * §72: default minimum publishable segment size. Partner or security policy
 * may raise this, never lower it.
 */
export const DEFAULT_MIN_PUBLISHABLE_REACH = 1_000;

/**
 * §72: published bucket values are cached for a minimum publication interval
 * so a Buyer cannot difference repeated refreshes into an exact count.
 */
export const DEFAULT_BUCKET_PUBLICATION_INTERVAL_HOURS = 24;

const BUCKET_BOUNDS: ReadonlyArray<{ bucket: ReachBucket; min: number; max: number }> = [
  { bucket: 'UNDER_10K', min: 1_000, max: 9_999 },
  { bucket: '10K_50K', min: 10_000, max: 49_999 },
  { bucket: '50K_100K', min: 50_000, max: 99_999 },
  { bucket: '100K_250K', min: 100_000, max: 249_999 },
  { bucket: '250K_500K', min: 250_000, max: 499_999 },
  { bucket: '500K_1M', min: 500_000, max: 999_999 },
  { bucket: 'OVER_1M', min: 1_000_000, max: Number.MAX_SAFE_INTEGER },
];

/**
 * Map an exact local count to its published bucket.
 *
 * Returns null when the cohort is below the publishable minimum -- §72
 * requires suppressing the result entirely rather than exposing a tiny
 * cohort. Callers must treat null as "do not list", not as "bucket unknown".
 */
export function bucketForExactReach(
  exactCount: number,
  minPublishable: number = DEFAULT_MIN_PUBLISHABLE_REACH,
): ReachBucket | null {
  if (!Number.isFinite(exactCount) || exactCount < minPublishable) return null;
  for (const b of BUCKET_BOUNDS) {
    if (exactCount >= b.min && exactCount <= b.max) return b.bucket;
  }
  return null;
}

/** Lower bound of a bucket, used only for Buyer-side range filtering. */
export function bucketMinimum(bucket: ReachBucket): number {
  return BUCKET_BOUNDS.find((b) => b.bucket === bucket)?.min ?? 0;
}

export function bucketMaximum(bucket: ReachBucket): number {
  return BUCKET_BOUNDS.find((b) => b.bucket === bucket)?.max ?? Number.MAX_SAFE_INTEGER;
}

/**
 * Does a bucket satisfy a Buyer's reach_min / reach_max filter (§67.5)?
 *
 * Deliberately inclusive: a bucket qualifies when its range OVERLAPS the
 * requested range. Comparing against the exact count would leak precision
 * that §72 says the Buyer must not have.
 */
export function bucketMatchesFilter(
  bucket: ReachBucket,
  filter: { reachMin?: number; reachMax?: number },
): boolean {
  const lo = bucketMinimum(bucket);
  const hi = bucketMaximum(bucket);
  if (filter.reachMin !== undefined && hi < filter.reachMin) return false;
  if (filter.reachMax !== undefined && lo > filter.reachMax) return false;
  return true;
}

/**
 * §72: reach is a planning signal only. Summing buckets across Partners is
 * NOT unique reach, because users overlap and the MVP has no cross-partner
 * identity graph (§13, §104). Callers that need a combined figure must label
 * it as a non-deduplicated upper bound.
 */
export function summedUpperBound(buckets: readonly ReachBucket[]): {
  upperBound: number;
  deduplicated: false;
  warning: string;
} {
  return {
    upperBound: buckets.reduce((acc, b) => acc + bucketMaximum(b), 0),
    deduplicated: false,
    warning:
      'Non-deduplicated upper bound. Users may overlap across Partners; ' +
      'the MVP has no cross-partner identity graph (spec §13, §72, §104).',
  };
}
