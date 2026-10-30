/**
 * Buyer home (§34).
 *
 * Leads with what to do next -- finish a draft, wait on Partners, describe an
 * audience -- worked out from the lists this page already loads, then three
 * counts and the latest campaigns.
 *
 * Delivery and outcomes are never merged into one "performance" number here or
 * anywhere (§49): a Partner counts an impression, a Buyer confirms a qualified
 * lead, and blending them would hide which side the evidence came from. They
 * are on each campaign's own page.
 */
import Link from 'next/link';
import { requireContext } from '@/lib/nav-entry';
import { apiOptional } from '@/lib/api';
import { Shell } from '@/components/Shell';
import { Card, Empty, Money, PageHeader, Stat, StatusBadge } from '@/components/ui';

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
  const [campaigns, audiences] = await Promise.all([
    apiOptional<{ items: CampaignRow[] }>('/v1/campaigns'),
    apiOptional<{ items: { id: string; status: string }[] }>('/v1/audiences'),
  ]);
  const items = campaigns?.items ?? [];

  const live = items.filter((c) => c.status === 'LIVE' || c.status === 'PARTIALLY_LIVE');
  const drafts = items.filter((c) => c.status === 'DRAFT');
  const awaiting = items.filter((c) => c.status === 'PARTNER_REVIEW');
  const hasAudience = (audiences?.items ?? []).some((a) => a.status === 'READY');

  const next: { text: string; href: string; action: string }[] = [];
  const latestDraft = drafts[0];
  if (latestDraft) {
    next.push({
      text: `“${latestDraft.name}” is not submitted yet.`,
      href: `/campaigns/${latestDraft.id}/audience`,
      action: 'Finish it',
    });
  }
  if (awaiting.length > 0) {
    next.push({
      text: `${awaiting.length} campaign${awaiting.length === 1 ? ' is' : 's are'} with Partners, who have 7 days to decide.`,
      href: '/campaigns',
      action: 'See them',
    });
  }
  if (!hasAudience) {
    next.push({
      text: 'Describe who you want to reach, and see which Partners can reach them.',
      href: '/audiences/new',
      action: 'New audience',
    });
  }

  return (
    <Shell ctx={ctx}>
      <PageHeader
        title={`Welcome, ${ctx.user.name.split(' ')[0]}`}
        actions={
          <Link className="btn btn-primary" href="/campaigns/new">
            New campaign
          </Link>
        }
      />

      {next.length > 0 ? (
        <Card title="Next steps">
          <ul className="plain-list">
            {next.map((n) => (
              <li key={n.href + n.action}>
                {n.text} <Link href={n.href}>{n.action}</Link>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      <div className="grid" style={{ marginBottom: '1.5rem' }}>
        <Stat label="Running" value={live.length} />
        <Stat label="With Partners" value={awaiting.length} />
        <Stat label="Drafts" value={drafts.length} />
      </div>

      <Card title="Latest campaigns">
        {items.length === 0 ? (
          <Empty>
            No campaigns yet. <Link href="/campaigns/new">Create your first one</Link>.
          </Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Campaign</th>
                  <th>Status</th>
                  <th>Budget</th>
                </tr>
              </thead>
              <tbody>
                {items.slice(0, 5).map((c) => (
                  <tr key={c.id}>
                    <td>
                      <Link href={`/campaigns/${c.id}`}>{c.name}</Link>
                    </td>
                    <td>
                      <StatusBadge status={c.status} />
                    </td>
                    <td>
                      <Money minor={c.budget?.amount_minor} currency={c.budget?.currency} />
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
