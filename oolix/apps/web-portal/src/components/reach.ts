/**
 * Reach in words (§72): always a range, never a count -- the API has none to
 * give. Shared by server pages and client components.
 */
export const REACH_LABELS: Record<string, string> = {
  UNDER_10K: 'under 10K',
  '10K_50K': '10K – 50K',
  '50K_100K': '50K – 100K',
  '100K_250K': '100K – 250K',
  '250K_500K': '250K – 500K',
  '500K_1M': '500K – 1M',
  OVER_1M: 'over 1M',
};

/** What a Partner's estimate says, including the answers that are not a range. */
export function reachLabel(bucket: string | null, status: string | null): string {
  if (bucket) return `${REACH_LABELS[bucket] ?? bucket} people`;
  switch (status) {
    case 'REQUESTED':
    case 'PROCESSING':
      return 'working it out…';
    // §17: fewer than the minimum cohort is said as such, never as a number.
    case 'BELOW_THRESHOLD':
      return 'too few to show';
    case 'FAILED':
    case 'EXPIRED':
      return 'no answer yet';
    default:
      return 'not asked yet';
  }
}
