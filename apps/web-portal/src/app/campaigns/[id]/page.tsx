/**
 * Campaign detail (§42).
 *
 * §42 makes the parent campaign an aggregate VIEW: each Partner request and
 * each activation carries its own state and its own reason. A campaign can be
 * live at one Partner and rejected at another, so this screen shows the
 * per-Partner truth first and the rolled-up status only as a label.
 */
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireContext } from '@/lib/nav-entry';
import { apiOptional } from '@/lib/api';
import { Shell } from '@/components/Shell';
import {
  Card,
  Empty,
  Money,
  Notice,
  PageHeader,
  Reach,
  StatusBadge,
  dateOnly,
  dateTime,
  relative,
} from '@/components/ui';
import { ActivationControls } from '@/components/ActivationControls';

interface Campaign {
  id: string;
  name: string;
  objective: string;
  status: string;
  derived_status?: string;
  start_at: string;
  end_at: string;
  budget: { total_minor: number; allocated_minor: number; currency: string };
  partner_requests: {
    request_id: string;
    partner: { id: string; display_name: string };
    // v6 §19: null whenever the request targets the campaign's Audience Group,
    // which is the primary path.
    segment: { display_name: string; reach_bucket: string | null } | null;
    audience?: { audience_group_id: string; audience_version: number } | null;
    status: string;
    expires_at?: string | null;
    channels: { channel: string; allocation_minor: number }[];
    activations: {
      activation_id: string;
      channel: string;
      status: string;
      status_reason: string | null;
    }[];
  }[];
}

interface Report {
  delivery?: { impressions?: number; clicks?: number };
  outcomes?: { qualified?: number; converted?: number; received?: number };
}

export default async function CampaignDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireContext(`/campaigns/${id}`);

  const campaign = await apiOptional<Campaign>(`/v1/campaigns/${id}`);
  if (!campaign) notFound();

  const report = await apiOptional<Report>(`/v1/reports/campaigns/${id}`);
  const currency = campaign.budget.currency;
  const isDraft = campaign.status === 'DRAFT';

  // A campaign can be fully approved, activated, and still serve nothing
  // because its flight has not begun. That looks identical to a broken
  // integration from the outside, so it is worth saying plainly.
  const notStarted = Date.parse(campaign.start_at) > Date.now();

  return (
    <Shell ctx={ctx}>
      <PageHeader
        title={campaign.name}
        lead={
          <>
            <StatusBadge status={campaign.derived_status ?? campaign.status} />{' '}
            <span className="faint">
              {dateOnly(campaign.start_at)} – {dateOnly(campaign.end_at)} ·{' '}
              <Money minor={campaign.budget.total_minor} currency={currency} />
            </span>
          </>
        }
        actions={
          isDraft ? (
            <Link className="btn btn-primary" href={`/campaigns/${id}/review`}>
              Continue building
            </Link>
          ) : null
        }
      />

      {report ? (
        <div className="grid" style={{ marginBottom: '1.5rem' }}>
          <div className="stat">
            <div className="stat-label">Impressions</div>
            <div className="stat-value">{report.delivery?.impressions ?? 0}</div>
            <div className="stat-note">Counted by the Partner</div>
          </div>
          <div className="stat">
            <div className="stat-label">Clicks</div>
            <div className="stat-value">{report.delivery?.clicks ?? 0}</div>
          </div>
          <div className="stat">
            <div className="stat-label">Qualified leads</div>
            <div className="stat-value">{report.outcomes?.qualified ?? 0}</div>
            <div className="stat-note">Confirmed by your CRM</div>
          </div>
          <div className="stat">
            <div className="stat-label">Converted</div>
            <div className="stat-value">{report.outcomes?.converted ?? 0}</div>
          </div>
        </div>
      ) : null}

      <h2>Per-Partner status</h2>
      {campaign.partner_requests.length === 0 ? (
        <Empty>
          No Partner requests. <Link href={`/campaigns/${id}/audience`}>Add one</Link>.
        </Empty>
      ) : (
        campaign.partner_requests.map((r) => (
          <Card key={r.request_id} title={r.partner.display_name}>
            <p className="muted" style={{ marginTop: 0 }}>
              {r.segment ? (
                <>
                  {r.segment.display_name} · <Reach bucket={r.segment.reach_bucket} />
                </>
              ) : (
                <>Your audience{r.audience ? ` · rules v${r.audience.audience_version}` : ''}</>
              )}{' '}
              · <StatusBadge status={r.status} />
              {r.status === 'PARTNER_REVIEW' && r.expires_at ? (
                <span className="faint"> · decision due {relative(r.expires_at)}</span>
              ) : null}
            </p>

            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Channel</th>
                    <th>Allocation</th>
                    <th>Activation</th>
                    <th>Reason</th>
                    <th>Controls</th>
                  </tr>
                </thead>
                <tbody>
                  {r.channels.map((c) => {
                    const act = r.activations.find((a) => a.channel === c.channel);
                    return (
                      <tr key={c.channel}>
                        <td>{c.channel.replaceAll('_', ' ').toLowerCase()}</td>
                        <td>
                          <Money minor={c.allocation_minor} currency={currency} />
                        </td>
                        <td>
                          <StatusBadge status={act?.status} />
                        </td>
                        <td className="muted">{act?.status_reason ?? '—'}</td>
                        <td>
                          {act ? (
                            <ActivationControls
                              activationId={act.activation_id}
                              status={act.status}
                            />
                          ) : (
                            <span className="faint">not created</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>
        ))
      )}

      {notStarted ? (
        <Notice tone="warn">
          This campaign has not started yet. Nothing will be served until{' '}
          {dateTime(campaign.start_at)}, even once every Data Partner has approved it.
        </Notice>
      ) : null}

      <Notice tone="plain">
        Delivery is what each Partner counted; outcomes are what your CRM confirmed. They are shown
        separately because they are verified by different parties, and a Partner is paid on the
        verified outcome, never on unverified clicks.
        <br />
        <br />
        You can pause or end any activation you pay for. So can the Partner serving it — each side
        controls its own, and neither can touch the other&rsquo;s.
      </Notice>
    </Shell>
  );
}
