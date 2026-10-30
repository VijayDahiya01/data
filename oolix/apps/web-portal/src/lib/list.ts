/**
 * Search, status filter and paging for the portal's long lists.
 *
 * Read from the URL (`?q=&status=&page=`), so a filtered list can be linked,
 * reloaded and walked back through. The filtering happens here, over the list
 * the API already returned: an organization's own campaigns or audiences, which
 * the pages fetched whole anyway. A list of 394 audiences on one page was 20,000
 * pixels tall.
 */
export const PAGE_SIZE = 20;

export interface ListQuery {
  q: string;
  status: string;
  page: number;
}

type Params = Record<string, string | string[] | undefined>;

const first = (v: string | string[] | undefined): string => (Array.isArray(v) ? v[0] : v) ?? '';

export function readListQuery(params: Params): ListQuery {
  const page = Number.parseInt(first(params.page), 10);
  return {
    q: first(params.q).trim(),
    status: first(params.status),
    page: Number.isFinite(page) && page > 1 ? page : 1,
  };
}

export interface ListPage<T> {
  items: T[];
  /** How many match, across every page. */
  total: number;
  page: number;
  pages: number;
}

export function pageOf<T>(
  items: T[],
  query: ListQuery,
  text: (item: T) => string,
  status?: (item: T) => string,
): ListPage<T> {
  const q = query.q.toLowerCase();
  const matching = items.filter(
    (i) =>
      (!q || text(i).toLowerCase().includes(q)) &&
      (!query.status || !status || status(i) === query.status),
  );
  const pages = Math.max(1, Math.ceil(matching.length / PAGE_SIZE));
  const page = Math.min(query.page, pages);
  return {
    items: matching.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
    total: matching.length,
    page,
    pages,
  };
}
