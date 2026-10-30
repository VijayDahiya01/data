/**
 * Campaign list (§34, §42).
 *
 * The status column shows the DERIVED status where the API provides one. §42
 * makes the parent campaign an aggregate view: a campaign is routinely live at
 * one Partner and rejected at another, and this list must not flatten that
 * into something that reads as a single verdict.
 *
 * Searched and paged (lib/list.ts); a draft links straight back into the
 * builder rather than to a page that says it is a draft.
 */
import Link from 'next/link';
import { requireContext } from '@/lib/nav-entry';
import { apiOptional } from '@/lib/api';
import { pageOf, readListQuery } from '@/lib/list';
import { Shell } from '@/components/Shell';
import { Card, Empty, Money, PageHeader, StatusBadge, dateOnly } from '@/components/ui';
import { ListSearch, Pager, statusOptions } from '@/components/ListControls';

interface CampaignRow {
  id: string;
  name: string;
  objective: string;
  category: string;
  status: string;
  budget: { amount_minor: number; currency: string };
  start_at: string;
  end_at: string;
  version: number;
}

export default async function CampaignsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ctx = await requireContext('/campaigns');
  const query = readListQuery(await searchParams);
  const data = await apiOptional<{ items: CampaignRow[] }>('/v1/campaigns');
  const items = data?.items ?? [];
  const list = pageOf(
    items,
    query,
    (c) => `${c.name} ${c.category}`,
    (c) => c.status,
  );

  return (
    <Shell ctx={ctx}>
      <PageHeader
        title="Campaigns"
        actions={
          <Link className="btn btn-primary" href="/campaigns/new">
            New campaign
          </Link>
        }
      />

      <Card>
        {items.length === 0 ? (
          <Empty>
            Nothing here yet. <Link href="/campaigns/new">Start a campaign</Link>.
          </Empty>
        ) : (
          <>
            <ListSearch
              query={query}
              count={items.length}
              statuses={statusOptions(items.map((c) => c.status))}
              placeholder="Search campaigns"
            />
            {list.items.length === 0 ? (
              <Empty>No campaign matches.</Empty>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Campaign</th>
                      <th>Status</th>
                      <th>Budget</th>
                      <th>Runs</th>
                    </tr>
                  </thead>
                  <tbody>
                    {list.items.map((c) => (
                      <tr key={c.id}>
                        <td>
                          <Link
                            href={
                              c.status === 'DRAFT'
                                ? `/campaigns/${c.id}/audience`
                                : `/campaigns/${c.id}`
                            }
                          >
                            {c.name}
                          </Link>
                        </td>
                        <td>
                          <StatusBadge status={c.status} />
                        </td>
                        <td>
                          <Money minor={c.budget?.amount_minor} currency={c.budget?.currency} />
                        </td>
                        <td className="muted">
                          {dateOnly(c.start_at)} – {dateOnly(c.end_at)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <Pager list={list} query={query} />
          </>
        )}
      </Card>
    </Shell>
  );
}
