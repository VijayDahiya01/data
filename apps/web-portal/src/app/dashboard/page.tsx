/**
 * Buyer dashboard (§34).
 *
 * Deliberately shows delivery and outcomes side by side but never merged. §49
 * keeps them distinct because they are verified differently: a Partner counts
 * an impression, a Buyer confirms a qualified lead. Blending them into one
 * "performance" number would hide which side the evidence came from.
 */
import Link from 'next/link';
import { requireContext } from '@/lib/nav-entry';
import { apiOptional } from '@/lib/api';
import { Shell } from '@/components/Shell';
import {
  Card,
  Empty,
  Money,
  Notice,
  PageHeader,
  Stat,
  StatusBadge,
  dateOnly,
} from '@/components/ui';

interface CampaignRow {
  id: string;
  name: string;
  objective: string;
  status: string;
  budget: { amount_minor: number; currency: string };
  start_at: string;
  end_at: string;
}

export default async function DashboardPage() {
  const ctx = await requireContext('/dashboard');
  const campaigns = await apiOptional<{ items: CampaignRow[] }>('/v1/campaigns');
  const items = campaigns?.items ?? [];

  const live = items.filter((c) => c.status === 'LIVE' || c.status === 'PARTIALLY_LIVE');
  const drafts = items.filter((c) => c.status === 'DRAFT');
  const awaiting = items.filter((c) => c.status === 'PARTNER_REVIEW');

  const committed = items
    .filter((c) => c.status !== 'DRAFT')
    .reduce((sum, c) => sum + Number(c.budget?.amount_minor ?? 0), 0);

  return (
    <Shell ctx={ctx}>
      <PageHeader
        title={`Welcome, ${ctx.user.name.split(' ')[0]}`}
        lead={`${ctx.active_organization?.name} · Buyer`}
        actions={
          <Link className="btn btn-primary" href="/campaigns/new">
            New campaign
          </Link>
        }
      />

      <div className="grid" style={{ marginBottom: '1.5rem' }}>
        <Stat label="Live" value={live.length} note="running at one or more Partners" />
        <Stat
          label="Awaiting Partner review"
          value={awaiting.length}
          note="Partners have 7 days to decide"
        />
        <Stat label="Drafts" value={drafts.length} note="not yet submitted" />
        <Stat
          label="Committed budget"
          value={<Money minor={committed} currency={items[0]?.budget?.currency ?? 'INR'} />}
          note="across submitted campaigns"
        />
      </div>

      <Card title="Recent campaigns">
        {items.length === 0 ? (
          <Empty>
            No campaigns yet. <Link href="/campaigns/new">Create your first one</Link>, or{' '}
            <Link href="/audiences/new">describe an audience</Link> to see which Data Partners can
            reach it.
          </Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Campaign</th>
                  <th>Objective</th>
                  <th>Status</th>
                  <th>Budget</th>
                  <th>Runs</th>
                </tr>
              </thead>
              <tbody>
                {items.slice(0, 8).map((c) => (
                  <tr key={c.id}>
                    <td>
                      <Link href={`/campaigns/${c.id}`}>{c.name}</Link>
                    </td>
                    <td className="muted">{c.objective.replaceAll('_', ' ').toLowerCase()}</td>
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

      <Notice tone="plain">
        Audience sizes are ranges, and they don&rsquo;t add up across Partners — the same person can
        be in more than one.
      </Notice>
    </Shell>
  );
}
