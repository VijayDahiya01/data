/**
 * Campaign builder — v6 §9 steps 3–7.
 *
 * v6 inverts what this screen used to do. §18.1: "Remove Partner segment
 * browsing as the primary Step 3." A Buyer now names the audience they want
 * first, and Oolix works out which Data Partners can evaluate it — instead of
 * browsing other people's segments and hoping one is close enough.
 *
 * §9's steps map onto the sections below: 3 choose an Audience Group, 4 see
 * Partner matches, 5 select Partners, 6 channel and placement per Partner, 7
 * budget allocation.
 *
 * There is no prebuilt-segment option on this screen any more. §19's path still
 * exists in the API — a campaign already targeting a Partner's segment keeps
 * running on it, and Partners still publish them — but offering both here asked
 * the Buyer to choose between describing who they want and shopping through
 * someone else's list before they could begin either.
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
  relative,
} from '@/components/ui';
import { WizardSteps } from '@/components/WizardSteps';
import { LinkAudienceForm, UnlinkAudienceForm } from '@/components/AudienceForms';
import {
  AudiencePartnerRequestForm,
  type AudienceMatchChoice,
} from '@/components/AudiencePartnerRequestForm';
// Only the creative type is still needed here. `PartnerRequestForm` builds a
// request against a Partner's prebuilt segment and is no longer reachable from
// the Buyer's path; it stays in the codebase because §19 requests still exist
// and are still rendered wherever they are reviewed.
import type { CreativeChoice } from '@/components/PartnerRequestForm';
import type { TaxonomyAttribute } from '@/components/AudienceBuilder';

interface Campaign {
  id: string;
  name: string;
  category: string;
  objective: string;
  geographies: string[];
  budget: {
    total_minor: number;
    allocated_minor: number;
    unallocated_minor: number;
    currency: string;
  };
  partner_requests: {
    request_id: string;
    partner: { id: string; display_name: string };
    segment: { display_name: string; reach_bucket: string | null } | null;
    targeting_source?: string;
    audience?: { audience_group_id: string; audience_version: number } | null;
    status: string;
    channels: { channel: string; allocation_minor: number }[];
  }[];
}

interface Rule {
  attribute: string;
  operator: string;
  value: unknown;
  required: boolean;
  weight: number;
}

interface AudienceLink {
  campaign_id: string;
  audience: {
    audience_group_id: string;
    audience_group_name: string;
    audience_version: number;
    rule_hash: string;
    rules: Rule[];
    linked_at: string;
  } | null;
}

interface MatchItem extends AudienceMatchChoice {
  status: string;
  supported_rules: string[];
  missing_required_rules: string[];
  missing_optional_rules: string[];
}

function renderValue(value: unknown, operator: string): string {
  if (Array.isArray(value)) {
    return operator === 'BETWEEN' ? `${value[0]}–${value[1]}` : value.join(', ');
  }
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  return String(value ?? '');
}

export default async function AudienceStepPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireContext(`/campaigns/${id}/audience`);

  const campaign = await apiOptional<Campaign>(`/v1/campaigns/${id}`);
  if (!campaign) notFound();

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
    (c) => (c as CreativeChoice & { status?: string }).status !== 'PENDING',
  );
  const nameOf = (key: string) => taxonomy?.items.find((a) => a.key === key)?.display_name ?? key;

  // §7 matches, only once an audience is actually linked. Asking before then
  // would be matching against nothing.
  const matches = linked
    ? await apiOptional<{ items: MatchItem[] }>(
        `/v1/audiences/${linked.audience_group_id}/partner-matches?version=${linked.audience_version}`,
      )
    : null;

  const chosen = new Set(campaign.partner_requests.map((r) => r.partner.id));
  const selectable = (matches?.items ?? []).filter(
    (m) => m.status !== 'INCOMPATIBLE' && !chosen.has(m.partner_org_id),
  );

  // Placements come from the Partner's own published set (§76.2). Fetched per
  // candidate so the request form can offer a real slot rather than failing at
  // submit on a channel with none.
  const placementsByPartner = new Map<
    string,
    { placement_id: string; display_name: string; surface: string; format: string }[]
  >();
  await Promise.all(
    selectable.map(async (m) => {
      const res = await apiOptional<{
        items: { placement_id: string; display_name: string; surface: string; format: string }[];
      }>(`/v1/catalogue/partners/${m.partner_org_id}/placements`);
      placementsByPartner.set(m.partner_org_id, res?.items ?? []);
    }),
  );

  const currency = campaign.budget.currency;

  return (
    <Shell ctx={ctx}>
      <PageHeader
        title={campaign.name}
        lead="Steps 3–7 · Audience, Partner matches, channels and budget"
      />
      <WizardSteps current={3} />

      <div className="grid" style={{ marginBottom: '1.25rem' }}>
        <div className="stat">
          <div className="stat-label">Total budget</div>
          <div className="stat-value">
            <Money minor={campaign.budget.total_minor} currency={currency} />
          </div>
        </div>
        <div className="stat">
          <div className="stat-label">Allocated</div>
          <div className="stat-value">
            <Money minor={campaign.budget.allocated_minor} currency={currency} />
          </div>
        </div>
        <div className="stat">
          <div className="stat-label">Unallocated</div>
          <div className="stat-value">
            <Money minor={campaign.budget.unallocated_minor} currency={currency} />
          </div>
          <div className="stat-note">Allocations must not exceed the total.</div>
        </div>
      </div>

      {/* --- §9 step 3 ---------------------------------------------------- */}
      <Card title="Step 3 · Audience">
        {linked ? (
          <>
            <div className="btn-row" style={{ marginTop: 0, marginBottom: '0.75rem' }}>
              <Link className="btn-secondary" href={`/audiences/${linked.audience_group_id}`}>
                {linked.audience_group_name}
              </Link>
              {/* The rule hash is still what §10 binds the Partner's approval
                  to. It is not shown: a Buyer cannot check a hex string, and
                  what they actually need to know — that this campaign keeps
                  this version whatever happens to the audience later — is
                  said in words instead. */}
              <span className="faint small">
                Locked to version {linked.audience_version}, {relative(linked.linked_at)}
              </span>
            </div>

            <table className="table">
              <thead>
                <tr>
                  <th>Attribute</th>
                  <th>Condition</th>
                  <th>Requirement</th>
                </tr>
              </thead>
              <tbody>
                {linked.rules.map((r) => (
                  <tr key={r.attribute}>
                    <td>{nameOf(r.attribute)}</td>
                    <td>
                      <code className="small">
                        {r.operator} {renderValue(r.value, r.operator)}
                      </code>
                    </td>
                    <td>
                      {r.required ? (
                        <strong>Required</strong>
                      ) : (
                        <span className="faint">Optional</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            <p className="faint small">
              This campaign is frozen to v{linked.audience_version}. Editing the audience creates a
              new version and leaves this campaign exactly where its Partners approved it.
            </p>

            {campaign.partner_requests.length === 0 ? (
              <UnlinkAudienceForm campaignId={id} />
            ) : (
              <p className="faint small">
                Partner requests already reference this audience, so it can no longer be changed.
              </p>
            )}
          </>
        ) : (audiences?.items?.length ?? 0) === 0 ? (
          <Empty>
            You have no audiences yet. Build one first — it describes who the campaign is for, and
            every Partner match on this page follows from it.
            <div className="btn-row">
              <Link className="btn-primary" href="/audiences/new">
                Build an audience
              </Link>
            </div>
          </Empty>
        ) : (
          <LinkAudienceForm campaignId={id} audiences={audiences?.items ?? []} />
        )}
      </Card>

      {/* --- §9 steps 4-7 ------------------------------------------------- */}
      <Card title={`Partners on this campaign (${campaign.partner_requests.length})`}>
        {campaign.partner_requests.length === 0 ? (
          <Empty>None yet. Add one from the matches below.</Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Partner</th>
                  <th>Targeting</th>
                  <th>Channels</th>
                  <th>Allocated</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {campaign.partner_requests.map((r) => (
                  <tr key={r.request_id}>
                    <td>{r.partner.display_name}</td>
                    <td className="muted">
                      {r.segment ? (
                        <>
                          {r.segment.display_name} <Reach bucket={r.segment.reach_bucket} />
                        </>
                      ) : (
                        <>
                          {linked?.audience_group_name ?? 'Audience'}
                          <span className="faint small">
                            {' '}
                            v{r.audience?.audience_version ?? linked?.audience_version}
                          </span>
                        </>
                      )}
                    </td>
                    <td className="muted">
                      {r.channels
                        .map((c) => c.channel.replace('PARTNER_', '').toLowerCase())
                        .join(', ')}
                    </td>
                    <td>
                      <Money
                        minor={r.channels.reduce((s, c) => s + Number(c.allocation_minor), 0)}
                        currency={currency}
                      />
                    </td>
                    <td>
                      <StatusBadge status={r.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Notice tone="plain">
        Reach is shown per Partner and is <strong>never added up</strong>. The same person can be in
        two Partners&rsquo; audiences, so a combined total would overstate who you actually reach.
      </Notice>

      {linked ? (
        <Card title="Steps 4–7 · Partner matches">
          {ready.length === 0 ? (
            <Notice tone="warn">
              Upload a creative first — a Partner approves a specific version, so a request cannot
              be made without one. <Link href={`/campaigns/${id}/creative`}>Go to creative</Link>.
            </Notice>
          ) : selectable.length === 0 ? (
            <Empty>
              No further Partner can evaluate this audience. See{' '}
              <Link href={`/audiences/${linked.audience_group_id}/matches`}>
                all matches, including excluded Partners
              </Link>{' '}
              — each names the required rule it is missing.
            </Empty>
          ) : (
            selectable.map((m) => (
              <details key={m.partner_org_id} className="card" style={{ marginTop: '0.75rem' }}>
                <summary style={{ cursor: 'pointer' }}>
                  <strong>{m.partner_name}</strong>{' '}
                  <span className="muted">· {m.match_score}% field coverage</span>{' '}
                  {m.reach_estimate?.status === 'READY' ? (
                    <Reach bucket={m.reach_estimate.reach_bucket} />
                  ) : (
                    <span className="faint">· no estimate yet</span>
                  )}
                  {m.missing_optional_rules.length > 0 ? (
                    <span className="faint">
                      {' '}
                      · cannot apply {m.missing_optional_rules.map(nameOf).join(', ')}
                    </span>
                  ) : null}
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
            ))
          )}
          <p className="faint small">
            Match score measures whether a Partner&rsquo;s data can evaluate your rules. It is not a
            measure of audience quality.
          </p>
        </Card>
      ) : null}

      <div className="btn-row">
        <Link
          className={campaign.partner_requests.length ? 'btn btn-primary' : 'btn'}
          href={`/campaigns/${id}/review`}
        >
          Continue to review
        </Link>
        <Link className="btn" href={`/campaigns/${id}/creative`}>
          Back to creative
        </Link>
      </div>
    </Shell>
  );
}
