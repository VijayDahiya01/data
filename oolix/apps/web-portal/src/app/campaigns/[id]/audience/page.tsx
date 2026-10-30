/**
 * Campaign builder — screen 3 of 3: who runs it, then submit (v6 §9 steps
 * 3-7 and 10).
 *
 * v6 inverts what this screen used to do. §18.1: "Remove Partner segment
 * browsing as the primary Step 3." A Buyer names the audience they want, and
 * Oolix works out which Data Partners can evaluate it.
 *
 * Every Partner that can is listed and ticked, with the budget split between
 * them, and one button requests them all and submits (PartnerPicker,
 * submitWithPartners). That replaced a collapsed form per Partner with eight
 * questions in it -- channels, placements, budget, frequency, versions, payout
 * basis, unit price, expansion -- which is where Buyers got stuck. The form is
 * still here, under "Set up a Partner yourself", for anyone who wants it.
 *
 * There is no prebuilt-segment option on this screen. §19's path still exists
 * in the API -- a campaign already targeting a Partner's segment keeps running
 * on it -- but offering both asked the Buyer to choose between describing who
 * they want and shopping through someone else's list.
 */
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { requireContext } from '@/lib/nav-entry';
import { apiOptional } from '@/lib/api';
import { payoutInWords } from '@/lib/payout-defaults';
import { Shell } from '@/components/Shell';
import { Card, Empty, Money, Notice, PageHeader, StatusBadge } from '@/components/ui';
import { WizardSteps } from '@/components/WizardSteps';
import { AutoRefresh } from '@/components/AutoRefresh';
import { LinkAudienceForm, UnlinkAudienceForm } from '@/components/AudienceForms';
import { PartnerPicker } from '@/components/PartnerPicker';
import {
  AudiencePartnerRequestForm,
  type AudienceMatchChoice,
} from '@/components/AudiencePartnerRequestForm';
import type { CreativeChoice } from '@/components/PartnerRequestForm';
import type { TaxonomyAttribute } from '@/components/AudienceBuilder';

interface Campaign {
  id: string;
  name: string;
  status: string;
  objective: string;
  budget: {
    total_minor: number;
    allocated_minor: number;
    unallocated_minor: number;
    currency: string;
  };
  partner_requests: {
    request_id: string;
    partner: { id: string; display_name: string };
    status: string;
    channels: { channel: string; allocation_minor: number }[];
  }[];
}

interface AudienceLink {
  campaign_id: string;
  audience: {
    audience_group_id: string;
    audience_group_name: string;
    audience_version: number;
  } | null;
}

interface MatchItem extends AudienceMatchChoice {
  status: string;
  missing_required_rules: string[];
}

const WORKING = new Set(['REQUESTED', 'PROCESSING']);

export default async function PartnersStepPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireContext(`/campaigns/${id}/audience`);

  const campaign = await apiOptional<Campaign>(`/v1/campaigns/${id}`);
  if (!campaign) notFound();
  // Submitted: there is nothing left to choose here.
  if (campaign.status !== 'DRAFT') redirect(`/campaigns/${id}`);

  const [link, audiences, creatives, taxonomy] = await Promise.all([
    apiOptional<AudienceLink>(`/v1/campaigns/${id}/audience-link`),
    apiOptional<{
      items: { id: string; name: string; status: string; current_version: number }[];
    }>('/v1/audiences'),
    apiOptional<{ items: CreativeChoice[] }>(`/v1/creatives?campaign_id=${id}`),
    apiOptional<{ items: TaxonomyAttribute[] }>('/v1/audiences/taxonomy'),
  ]);

  const linked = link?.audience ?? null;
  const ready = (creatives?.items ?? []).filter(
    (c) => (c as CreativeChoice & { status?: string }).status === 'READY',
  );
  const nameOf = (key: string) => taxonomy?.items.find((a) => a.key === key)?.display_name ?? key;

  // §7 matches, only once an audience is linked.
  const matches = linked
    ? await apiOptional<{ items: MatchItem[] }>(
        `/v1/audiences/${linked.audience_group_id}/partner-matches?version=${linked.audience_version}`,
      )
    : null;
  const all = matches?.items ?? [];
  const compatible = all.filter((m) => m.status !== 'INCOMPATIBLE');
  const excluded = all.filter((m) => m.status === 'INCOMPATIBLE');
  const chosen = new Set(campaign.partner_requests.map((r) => r.partner.id));
  const pickable = compatible.filter((m) => !chosen.has(m.partner_org_id));

  // Placements, for the "set up yourself" forms only (§76.2): the one-press
  // path looks them up when it runs.
  const placementsByPartner = new Map<
    string,
    { placement_id: string; display_name: string; surface: string; format: string }[]
  >();
  await Promise.all(
    pickable.map(async (m) => {
      const res = await apiOptional<{
        items: { placement_id: string; display_name: string; surface: string; format: string }[];
      }>(`/v1/catalogue/partners/${m.partner_org_id}/placements`);
      placementsByPartner.set(m.partner_org_id, res?.items ?? []);
    }),
  );

  const currency = campaign.budget.currency;
  const blocked = !(ctx.active_organization?.can_submit_campaigns ?? false)
    ? `${ctx.active_organization?.name ?? 'Your organization'} is still being verified. Come back to submit once it is.`
    : !ctx.permissions.includes('campaign:submit')
      ? 'Your role can prepare campaigns but not submit them. Ask an admin to submit it.'
      : null;
  const estimating = pickable.some((m) => WORKING.has(m.reach_estimate?.status ?? ''));

  return (
    <Shell ctx={ctx}>
      <PageHeader title={campaign.name} lead="Who runs it" />
      <WizardSteps current={3} />
      {estimating ? <AutoRefresh /> : null}

      <Card title="Who it is for">
        {linked ? (
          <div className="btn-row" style={{ marginTop: 0 }}>
            <Link href={`/audiences/${linked.audience_group_id}`}>
              <strong>{linked.audience_group_name}</strong>
            </Link>
            {campaign.partner_requests.length === 0 ? <UnlinkAudienceForm campaignId={id} /> : null}
          </div>
        ) : (audiences?.items?.length ?? 0) === 0 ? (
          <Empty>
            You have no audiences yet.{' '}
            <Link className="btn btn-primary btn-sm" href="/audiences/new">
              Build one
            </Link>
          </Empty>
        ) : (
          <LinkAudienceForm campaignId={id} audiences={audiences?.items ?? []} />
        )}
      </Card>

      {ready.length === 0 ? (
        <Notice tone="warn">
          Add your ad first: each Partner approves one exact version of it.{' '}
          <Link href={`/campaigns/${id}/creative`}>Add the ad</Link>
        </Notice>
      ) : null}

      {linked && ready.length > 0 ? (
        <Card title="Partners">
          {campaign.partner_requests.length > 0 ? (
            <ul className="plain-list" style={{ marginBottom: '1rem' }}>
              {campaign.partner_requests.map((r) => (
                <li key={r.request_id}>
                  {r.partner.display_name} ·{' '}
                  <Money
                    minor={r.channels.reduce((s, c) => s + Number(c.allocation_minor), 0)}
                    currency={currency}
                  />{' '}
                  <StatusBadge status={r.status} />
                </li>
              ))}
            </ul>
          ) : null}

          {compatible.length === 0 ? (
            <Empty>
              No Partner can reach this audience yet. Each one below is missing something the
              audience requires: make that condition optional, or{' '}
              <Link href={`/audiences/${linked.audience_group_id}`}>change the audience</Link>.
            </Empty>
          ) : (
            <PartnerPicker
              campaignId={id}
              partners={pickable.map((m) => ({
                partner_org_id: m.partner_org_id,
                partner_name: m.partner_name,
                reach_bucket: m.reach_estimate?.reach_bucket ?? null,
                estimate_status: m.reach_estimate?.status ?? null,
              }))}
              alreadyAdded={campaign.partner_requests.length}
              unallocatedMinor={Number(campaign.budget.unallocated_minor)}
              currency={currency}
              payment={payoutInWords(campaign.objective, currency)}
              blocked={blocked}
            />
          )}
        </Card>
      ) : null}

      {excluded.length > 0 ? (
        <details className="more" open={compatible.length === 0 || undefined}>
          <summary>
            {excluded.length} Partner{excluded.length === 1 ? '' : 's'} can&rsquo;t reach this
            audience
          </summary>
          <ul className="plain-list">
            {excluded.map((m) => (
              <li key={m.partner_org_id}>
                {m.partner_name}{' '}
                <span className="muted">
                  · can&rsquo;t answer {m.missing_required_rules.map(nameOf).join(', ')}
                </span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {linked && ready.length > 0 && pickable.length > 0 ? (
        <details className="more">
          <summary>Set up a Partner yourself</summary>
          <p className="faint small" style={{ marginTop: 0 }}>
            Choose channels, placements, frequency and payment for one Partner instead of the
            defaults.
          </p>
          {pickable.map((m) => (
            <details key={m.partner_org_id} className="card" style={{ marginTop: '0.75rem' }}>
              <summary>
                <strong>{m.partner_name}</strong>
              </summary>
              <div style={{ marginTop: '0.9rem' }}>
                <AudiencePartnerRequestForm
                  campaignId={id}
                  match={m}
                  placements={placementsByPartner.get(m.partner_org_id) ?? []}
                  creatives={ready}
                  currency={currency}
                />
              </div>
            </details>
          ))}
        </details>
      ) : null}

      <p className="faint">
        <Link href={`/campaigns/${id}/creative`}>Back to the ad</Link> ·{' '}
        <Link href="/campaigns">Save and finish later</Link>
      </p>
    </Shell>
  );
}
