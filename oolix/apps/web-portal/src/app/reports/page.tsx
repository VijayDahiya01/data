/**
 * Buyer reporting (§13, §49, §72).
 *
 * The rule this screen exists to respect: per-Partner figures are NOT
 * deduplicated across Partners. §13 and §72 both say so, and the reason is that
 * the same person can be in two Partners' audiences — so a combined "unique
 * reach" would be a number nobody can stand behind.
 *
 * Delivery and outcomes stay in separate columns for the same reason they do
 * everywhere else: a Partner counts the first, your CRM confirms the second.
 */
import Link from 'next/link';
import { requireContext } from '@/lib/nav-entry';
import { apiOptional } from '@/lib/api';
import { Shell } from '@/components/Shell';
import { Card, Empty, Money, Notice, PageHeader, StatusBadge, dateOnly } from '@/components/ui';

interface CampaignRow {
  id: string;
  name: string;
  objective: string;
  status: string;
  budget: { amount_minor: number; currency: string };
  start_at: string;
  end_at: string;
}

interface Report {
  delivery?: { impressions?: number; clicks?: number };
  outcomes?: { received?: number; valid?: number; qualified?: number; converted?: number };
  partners?: {
    partner_name: string;
    delivery?: { impressions?: number; clicks?: number };
    outcomes?: { qualified?: number; converted?: number };
  }[];
}

export default async function ReportsPage() {
  const ctx = await requireContext('/reports');
  const list = await apiOptional<{ items: CampaignRow[] }>('/v1/campaigns');
  const campaigns = (list?.items ?? []).filter((c) => c.status !== 'DRAFT');

  // Reports for the most recent campaigns. Fetched per campaign because §49
  // reports are campaign-scoped -- there is no cross-campaign roll-up endpoint,
  // and inventing one in the portal would mean summing figures the API
  // deliberately keeps separate.
  const recent = campaigns.slice(0, 6);
  const reports = await Promise.all(
    recent.map(async (c) => ({
      campaign: c,
      report: await apiOptional<Report>(`/v1/reports/campaigns/${c.id}`),
    })),
  );

  return (
    <Shell ctx={ctx}>
      <PageHeader
        title="Reports"
        lead="Delivery each Partner counted, and outcomes your CRM confirmed."
      />

      {campaigns.length === 0 ? (
        <Card>
          <Empty>
            Nothing has run yet. <Link href="/campaigns/new">Create a campaign</Link>.
          </Empty>
        </Card>
      ) : (
        reports.map(({ campaign, report }) => (
          <Card key={campaign.id} title={campaign.name}>
            <p className="muted" style={{ marginTop: 0 }}>
              <StatusBadge status={campaign.status} />{' '}
              <span className="faint">
                {dateOnly(campaign.start_at)} – {dateOnly(campaign.end_at)} ·{' '}
                <Money minor={campaign.budget?.amount_minor} currency={campaign.budget?.currency} />
              </span>
            </p>

            <div className="grid" style={{ marginBottom: '0.9rem' }}>
              <div className="stat">
                <div className="stat-label">Impressions</div>
                <div className="stat-value">{report?.delivery?.impressions ?? 0}</div>
              </div>
              <div className="stat">
                <div className="stat-label">Clicks</div>
                <div className="stat-value">{report?.delivery?.clicks ?? 0}</div>
              </div>
              <div className="stat">
                <div className="stat-label">Qualified</div>
                <div className="stat-value">{report?.outcomes?.qualified ?? 0}</div>
                <div className="stat-note">Your CRM confirmed these</div>
              </div>
              <div className="stat">
                <div className="stat-label">Converted</div>
                <div className="stat-value">{report?.outcomes?.converted ?? 0}</div>
              </div>
            </div>

            {report?.partners?.length ? (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Partner</th>
                      <th>Impressions</th>
                      <th>Clicks</th>
                      <th>Qualified</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.partners.map((p) => (
                      <tr key={p.partner_name}>
                        <td>{p.partner_name}</td>
                        <td style={{ fontVariantNumeric: 'tabular-nums' }}>
                          {p.delivery?.impressions ?? 0}
                        </td>
                        <td style={{ fontVariantNumeric: 'tabular-nums' }}>
                          {p.delivery?.clicks ?? 0}
                        </td>
                        <td style={{ fontVariantNumeric: 'tabular-nums' }}>
                          {p.outcomes?.qualified ?? 0}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}

            <div className="btn-row">
              <Link className="btn" href={`/campaigns/${campaign.id}`}>
                Open campaign
              </Link>
            </div>
          </Card>
        ))
      )}

      <Notice tone="plain">
        Per-Partner rows are <strong>not deduplicated across Partners</strong>. The same person can
        appear in more than one Partner&rsquo;s audience, so adding these together would overstate
        who you actually reached.
      </Notice>
    </Shell>
  );
}
