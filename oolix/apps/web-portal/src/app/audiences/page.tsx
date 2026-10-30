/**
 * Audiences — v6 §18.1.
 *
 * This route replaces "Audience discovery" as the Buyer's primary entry point,
 * and the inversion it represents is the whole of v6: you describe who you want
 * to reach first, and Oolix then works out which Data Partners can actually
 * evaluate that description. You no longer start by browsing other people's
 * segments and hoping one is close enough.
 *
 * §18.1 asks this list for name, status, compatible Partner count and linked
 * campaigns -- each answers a different question about whether an audience is
 * ready to carry a campaign. It is searched and paged (lib/list.ts).
 */
import Link from 'next/link';
import { requireContext } from '@/lib/nav-entry';
import { apiOptional } from '@/lib/api';
import { pageOf, readListQuery } from '@/lib/list';
import { Shell } from '@/components/Shell';
import { Card, Empty, PageHeader, relative } from '@/components/ui';
import { ListSearch, Pager } from '@/components/ListControls';

interface AudienceListItem {
  id: string;
  name: string;
  description: string | null;
  status: string;
  /** The Buyer-facing word: Draft, Ready, In Use or Archived. */
  display_status: string;
  current_version: number;
  rule_count: number;
  rule_hash: string | null;
  compatible_partners: number;
  linked_campaigns: number;
  updated_at: string;
}

const STATUSES = ['Draft', 'Ready', 'In Use', 'Archived'].map((s) => ({ value: s, label: s }));

export default async function AudiencesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ctx = await requireContext('/audiences');
  const query = readListQuery(await searchParams);
  const data = await apiOptional<{ items: AudienceListItem[] }>('/v1/audiences');
  const items = data?.items ?? [];
  const list = pageOf(
    items,
    query,
    (a) => `${a.name} ${a.description ?? ''}`,
    (a) => a.display_status,
  );

  return (
    <Shell ctx={ctx}>
      <PageHeader
        title="Audiences"
        actions={
          <Link className="btn btn-primary" href="/audiences/new">
            New audience
          </Link>
        }
      />

      {items.length === 0 ? (
        <Card>
          <Empty>
            No audiences yet. Describe who you want to reach, and see which Data Partners can reach
            them.
          </Empty>
          <p>
            <Link className="btn btn-primary" href="/audiences/new">
              Build your first audience
            </Link>
          </p>
        </Card>
      ) : (
        <Card>
          <ListSearch
            query={query}
            count={items.length}
            statuses={STATUSES}
            placeholder="Search audiences"
          />
          {list.items.length === 0 ? (
            <Empty>No audience matches.</Empty>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Audience</th>
                    <th>Status</th>
                    <th>Partners</th>
                    <th>Campaigns</th>
                    <th>Updated</th>
                  </tr>
                </thead>
                <tbody>
                  {list.items.map((a) => (
                    <tr key={a.id}>
                      <td>
                        <Link href={`/audiences/${a.id}`}>{a.name}</Link>
                        {a.description ? <div className="faint small">{a.description}</div> : null}
                      </td>
                      <td>
                        {/* The version number is kept by the backend and is what
                            a Partner's approval binds to; it is not something a
                            Buyer chooses or can act on, so it is not shown. */}
                        <span
                          className={
                            a.display_status === 'In Use' || a.display_status === 'Ready'
                              ? 'badge badge-ok'
                              : a.display_status === 'Draft'
                                ? 'badge badge-warn'
                                : 'badge'
                          }
                        >
                          {a.display_status}
                        </span>
                      </td>
                      <td>{a.compatible_partners > 0 ? a.compatible_partners : '—'}</td>
                      <td>{a.linked_campaigns || '—'}</td>
                      <td className="faint">{relative(a.updated_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <Pager list={list} query={query} />
        </Card>
      )}
    </Shell>
  );
}
