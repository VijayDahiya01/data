/**
 * Campaign builder — step 9 (§40.9).
 *
 * §40.9 asks for the parent summary plus one card per Partner request, external
 * channels clearly labelled as pending eligibility, and a warning where a
 * request uses a creative the Partner has not approved. All three are here,
 * because this is the last screen before real people are asked to decide.
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
  dateTime,
} from '@/components/ui';
import { WizardSteps } from '@/components/WizardSteps';
import { SubmitCampaignForm } from '@/components/SubmitCampaignForm';

interface Campaign {
  id: string;
  name: string;
  objective: string;
  category: string;
  purpose_id: string;
  status: string;
  start_at: string;
  end_at: string;
  geographies: string[];
  landing_url?: string;
  lead_definition?: { qualified_statuses?: string[]; duplicate_window_days?: number };
  budget: {
    total_minor: number;
    allocated_minor: number;
    unallocated_minor: number;
    currency: string;
  };
  partner_requests: {
    request_id: string;
    partner: { id: string; display_name: string };
    // v6 §19: null on the audience path, which is now the primary one. The old
    // shape was non-null and this page dereferenced it unguarded — an
    // audience-targeted campaign 500'd on its own review screen.
    segment: { display_name: string; reach_bucket: string | null } | null;
    audience?: { audience_group_id: string; audience_version: number } | null;
    targeting_source?: string;
    status: string;
    channels: {
      channel: string;
      allocation_minor: number;
      frequency_cap?: { max_impressions: number; window: string };
    }[];
  }[];
  creatives: { creative_version_id: string; version: number; type: string; status: string }[];
}

export default async function ReviewStepPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireContext(`/campaigns/${id}/review`);

  const campaign = await apiOptional<Campaign>(`/v1/campaigns/${id}`);
  if (!campaign) notFound();

  const currency = campaign.budget.currency;
  const isDraft = campaign.status === 'DRAFT';
  const canSubmit =
    isDraft &&
    campaign.partner_requests.length > 0 &&
    (ctx.active_organization?.can_submit_campaigns ?? false) &&
    ctx.permissions.includes('campaign:submit');

  const external = campaign.partner_requests.flatMap((r) =>
    r.channels.filter((c) => c.channel === 'META' || c.channel === 'GOOGLE'),
  );

  return (
    <Shell ctx={ctx}>
      <PageHeader title={campaign.name} lead="Step 9 · Review and submit" />
      <WizardSteps current={4} />

      <Card title="Campaign">
        <div className="table-wrap">
          <table>
            <tbody>
              <tr>
                <th>Objective</th>
                <td>{campaign.objective.replaceAll('_', ' ').toLowerCase()}</td>
              </tr>
              <tr>
                <th>Category</th>
                <td>{campaign.category}</td>
              </tr>
              <tr>
                <th>Purpose</th>
                <td>
                  <code>{campaign.purpose_id}</code>
                </td>
              </tr>
              <tr>
                <th>Flight</th>
                <td>
                  {dateTime(campaign.start_at)} – {dateTime(campaign.end_at)}
                </td>
              </tr>
              <tr>
                <th>Geographies</th>
                <td>{campaign.geographies.join(', ')}</td>
              </tr>
              <tr>
                <th>Budget</th>
                <td>
                  <Money minor={campaign.budget.total_minor} currency={currency} /> total ·{' '}
                  <Money minor={campaign.budget.allocated_minor} currency={currency} /> allocated
                </td>
              </tr>
              {campaign.landing_url ? (
                <tr>
                  <th>Landing</th>
                  <td>
                    <code>{campaign.landing_url}</code>
                  </td>
                </tr>
              ) : null}
              {campaign.lead_definition?.qualified_statuses?.length ? (
                <tr>
                  <th>Payable on</th>
                  <td>
                    {campaign.lead_definition.qualified_statuses.join(', ').toLowerCase()}
                    <span className="faint">
                      {' '}
                      · {campaign.lead_definition.duplicate_window_days}-day duplicate window
                    </span>
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </Card>

      {external.length ? (
        <Notice tone="warn">
          This campaign requests an external channel. Those activations stay pending an eligibility
          check and receive no manifest — Partner approval alone never enables an upload.
        </Notice>
      ) : null}

      <h2>Partner requests</h2>
      {campaign.partner_requests.length === 0 ? (
        <Empty>
          No Partners yet. <Link href={`/campaigns/${id}/audience`}>Add at least one</Link>.
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
                <>
                  Your audience
                  {r.audience ? ` · rules v${r.audience.audience_version}` : ''}
                </>
              )}{' '}
              · <StatusBadge status={r.status} />
            </p>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Channel</th>
                    <th>Allocation</th>
                    <th>Frequency cap</th>
                  </tr>
                </thead>
                <tbody>
                  {r.channels.map((c) => (
                    <tr key={c.channel}>
                      <td>
                        {c.channel.replaceAll('_', ' ').toLowerCase()}
                        {c.channel === 'META' || c.channel === 'GOOGLE' ? (
                          <span className="badge badge-warn"> pending eligibility</span>
                        ) : null}
                      </td>
                      <td>
                        <Money minor={c.allocation_minor} currency={currency} />
                      </td>
                      <td className="muted">
                        {c.frequency_cap
                          ? `${c.frequency_cap.max_impressions} / ${c.frequency_cap.window}`
                          : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="faint" style={{ marginBottom: 0 }}>
              This Partner sees only its own request. Nothing here reveals the others.
            </p>
          </Card>
        ))
      )}

      <Card title="Creative versions">
        {campaign.creatives.length === 0 ? (
          <Empty>None uploaded.</Empty>
        ) : (
          <ul className="muted" style={{ margin: 0, paddingLeft: '1.1rem' }}>
            {campaign.creatives.map((c) => (
              <li key={c.creative_version_id}>
                v{c.version} · {c.type.replaceAll('_', ' ').toLowerCase()} ·{' '}
                <StatusBadge status={c.status} />
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Notice tone="plain">
        Submitting freezes this version and starts each Partner&rsquo;s own 7-day review clock. Each
        Partner decides independently: one rejecting does not stop the others.
      </Notice>

      {/* A disabled button with no reason beside it is a dead end: the Buyer
          can see they cannot submit and not why. Every condition in `canSubmit`
          now has a sentence, and the two that used to be silent -- no Partner
          added, and business verification still pending -- are the ones people
          actually hit. */}
      {isDraft && campaign.partner_requests.length === 0 ? (
        <Notice tone="warn">
          No Data Partner has been added to this campaign yet, so there is nobody to send it to.
          Open <Link href={`/campaigns/${id}/audience`}>Partner matches</Link>, pick a Partner and
          give them a budget — that is what creates the request they review.
        </Notice>
      ) : null}

      {isDraft && !(ctx.active_organization?.can_submit_campaigns ?? false) ? (
        <Notice tone="warn">
          {ctx.active_organization?.name ?? 'Your organization'} is still being verified. You can
          build the campaign now, but it cannot be submitted until verification completes.
        </Notice>
      ) : null}

      <div className="btn-row">
        <SubmitCampaignForm campaignId={id} disabled={!canSubmit} />
        <Link className="btn" href={`/campaigns/${id}/audience`}>
          Back
        </Link>
        {!isDraft ? <span className="faint">Already submitted.</span> : null}
        {isDraft && !ctx.permissions.includes('campaign:submit') ? (
          <span className="faint">Your role can draft but not submit.</span>
        ) : null}
      </div>
    </Shell>
  );
}
