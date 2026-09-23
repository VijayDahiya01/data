/**
 * Cursor pagination -- spec v5 §53, §86.
 *
 * §86: cursor-based, default page size 25, maximum 100.
 *
 * Offset pagination is deliberately avoided: the catalogue is written to while
 * being browsed, and OFFSET both skips and repeats rows under concurrent
 * inserts. A cursor over an immutable sort key does not.
 */
import { OolixError, PAGINATION } from '@oolix/contracts';

export interface Cursor {
  /** Sort key of the last item on the previous page. */
  k: string;
  /** Tie-break id, so equal sort keys still yield a total order. */
  i: string;
}

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export function decodeCursor(raw: string | undefined): Cursor | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Cursor;
    if (typeof parsed.k !== 'string' || typeof parsed.i !== 'string') throw new Error('shape');
    return parsed;
  } catch {
    throw new OolixError('VAL_001', 'Malformed cursor.', {
      fieldErrors: [{ field: 'cursor', message: 'not a valid pagination cursor' }],
    });
  }
}

export function clampLimit(requested: unknown): number {
  const n = Number(requested);
  if (!Number.isFinite(n) || n <= 0) return PAGINATION.defaultPageSize;
  return Math.min(Math.floor(n), PAGINATION.maxPageSize);
}

export interface Page<T> {
  items: T[];
  next_cursor: string | null;
}

/**
 * Build a page from `limit + 1` rows. Fetching one extra row is how we know
 * whether a next page exists without a second COUNT query.
 */
export function buildPage<T>(rows: T[], limit: number, toCursor: (row: T) => Cursor): Page<T> {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];
  return {
    items,
    next_cursor: hasMore && last ? encodeCursor(toCursor(last)) : null,
  };
}
