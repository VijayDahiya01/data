/**
 * Campaign list (§34, §42).
 *
 * The status column shows the DERIVED status where the API provides one. §42
 * makes the parent campaign an aggregate view: a campaign is routinely live at
 * one Partner and rejected at another, and this list must not flatten that
 * into something that reads as a single verdict.
 */
import Link from 'next/link';
import { requireContext } from '@/lib/nav-entry';
import { apiOptional } from '@/lib/api';
import { Shell } from '@/components/Shell';
import { Card, Empty, Money, PageHeader, StatusBadge, dateOnly } from '@/components/ui';

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

export default async function CampaignsPage() {
  const ctx = await requireContext('/campaigns');
  const data = await apiOptional<{ items: CampaignRow[] }>('/v1/campaigns');
  const items = data?.items ?? [];

  return (
    <Shell ctx={ctx}>
      <PageHeader
        title="Campaigns"
        lead="One campaign can run across several Data Partners, each approving independently."
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
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Campaign</th>
                  <th>Objective</th>
                  <th>Category</th>
                  <th>Status</th>
                  <th>Budget</th>
                  <th>Flight</th>
                </tr>
              </thead>
              <tbody>
                {items.map((c) => (
                  <tr key={c.id}>
                    <td>
                      <Link href={`/campaigns/${c.id}`}>{c.name}</Link>
                      {c.version > 1 ? <span className="faint"> · v{c.version}</span> : null}
                    </td>
                    <td className="muted">{c.objective.replaceAll('_', ' ').toLowerCase()}</td>
                    <td className="muted">{c.category}</td>
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
      </Card>
    </Shell>
  );
}
