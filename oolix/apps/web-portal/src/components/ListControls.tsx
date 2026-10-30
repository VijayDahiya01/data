/**
 * The search box and the pager for a long list (lib/list.ts).
 *
 * A plain GET form and plain links: they work before any JavaScript, and the
 * URL is the whole state, so Back goes back.
 */
import Link from 'next/link';
import { PAGE_SIZE, type ListPage, type ListQuery } from '@/lib/list';

export function ListSearch({
  query,
  count,
  statuses,
  placeholder = 'Search',
}: {
  query: ListQuery;
  /** How long the whole list is: one that fits on a page needs no search box. */
  count: number;
  statuses?: { value: string; label: string }[];
  placeholder?: string;
}) {
  if (count <= PAGE_SIZE && !query.q && !query.status) return null;
  return (
    <form className="list-search" method="get" role="search">
      <input
        type="search"
        name="q"
        defaultValue={query.q}
        placeholder={placeholder}
        aria-label="Search"
      />
      {statuses && statuses.length > 1 ? (
        <select name="status" defaultValue={query.status} aria-label="Status">
          <option value="">Any status</option>
          {statuses.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
      ) : null}
      <button type="submit" className="btn-secondary">
        Search
      </button>
      {query.q || query.status ? (
        <Link href="?" className="faint small">
          Clear
        </Link>
      ) : null}
    </form>
  );
}

export function Pager<T>({ list, query }: { list: ListPage<T>; query: ListQuery }) {
  if (list.pages <= 1) {
    return list.total > 0 ? <p className="faint small">{list.total} in all</p> : null;
  }
  const href = (page: number) => {
    const params = new URLSearchParams();
    if (query.q) params.set('q', query.q);
    if (query.status) params.set('status', query.status);
    if (page > 1) params.set('page', String(page));
    return `?${params.toString()}`;
  };
  return (
    <nav className="pager" aria-label="Pages">
      {list.page > 1 ? <Link href={href(list.page - 1)}>← Previous</Link> : <span />}
      <span className="faint small">
        Page {list.page} of {list.pages} · {list.total} in all
      </span>
      {list.page < list.pages ? <Link href={href(list.page + 1)}>Next →</Link> : <span />}
    </nav>
  );
}

/** The distinct values of a status field, for the filter, in a stable order. */
export function statusOptions(values: string[]): { value: string; label: string }[] {
  return [...new Set(values)].sort().map((v) => ({
    value: v,
    label: v.replaceAll('_', ' ').toLowerCase(),
  }));
}
