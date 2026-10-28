/**
 * Values a Partner's Agent could not read, as they travel to Oolix: for a
 * suggested meaning, or as an answer the Partner chose to share.
 */

/**
 * The value as the Agent compares it: lower case, separators as spaces, "&"
 * as "and". The same rule as the Agent's clean.Normalize, so "Home & Kitchen"
 * and "home-and-kitchen" are one value on both sides.
 */
export function normalizeValue(s: string): string {
  const replaced = s
    .trim()
    .toLowerCase()
    .replace(/[_\-./]/g, ' ')
    .replace(/&/g, ' and ')
    .replace(/'/g, '');
  return replaced.split(/\s+/).filter(Boolean).join(' ');
}

/**
 * Whether a value may leave the Partner's data at all: a short phrase with a
 * letter in it -- a category, a place, a tier. An address, a phone number, an
 * ID or a sentence is held back, in case a column holds more than its name
 * says.
 */
export function shareable(value: string): boolean {
  const v = value.trim();
  if (v.length === 0 || v.length > 80) return false;
  if (v.includes('@')) return false;
  if ((v.match(/\d/g)?.length ?? 0) >= 5) return false;
  if (v.split(/\s+/).length > 8) return false;
  return /\p{L}/u.test(v);
}
