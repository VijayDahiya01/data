/**
 * Audience detail.
 *
 * The page answers, in this order: who is this audience, can I use it, who can
 * serve it, how many people is that, and what is already running on it.
 *
 * What is deliberately NOT here is the technical versioning. It is all still
 * kept — every set of saved settings, its rule hash, and which campaign froze
 * which one — because a Partner's approval binds to exactly that pair and the
 * audit trail depends on it. But a Buyer cannot act on "v2 SUPERSEDED", and
 * showing it invited them to reason about a number that was never theirs. The
 * same facts appear as Change History under More, in dates and campaign counts.
 */
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireContext } from '@/lib/nav-entry';
import { apiOptional } from '@/lib/api';
import { Shell } from '@/components/Shell';
import { Card, Empty, Notice, PageHeader, Reach, StatusBadge, relative } from '@/components/ui';
import type { TaxonomyAttribute } from '@/components/AudienceBuilder';
import { describeRule, importanceLabel } from '@/lib/audience-vocabulary';
import {
  AudienceVersionActions,
  EditAudienceRulesForm,
  EditInUseConfirm,
} from '@/components/AudienceForms';

interface Rule {
  attribute: string;
  operator: string;
  value: unknown;
  required: boolean;
  weight: number;
}

interface AudienceDetail {
  id: string;
  name: string;
  description: string | null;
  status: string;
  /** The Buyer-facing word, decided by the service rather than here. */
  display_status: string;
  current_version: number;
  versions: {
    version: number;
    status: string;
    is_current: boolean;
    display_status: string;
    used_by_campaigns: number;
    rule_hash: string;
    rules: Rule[];
    created_at: string;
  }[];
  reach_estimates: {
    reach_estimate_id: string;
    partner_org_id: string;
    partner_name: string;
    audience_version: number;
    status: string;
    reach_bucket: string | null;
    requested_at: string | null;
    freshness_at: string | null;
    expires_at: string | null;
    failure_reason: string | null;
  }[];
  linked_campaigns: {
    campaign_id: string;
    campaign_name: string;
    campaign_status: string;
    audience_version: number;
  }[];
}

/**
 * Has this estimate been pending long enough to be worth explaining?
 *
 * A Partner's Agent normally answers in seconds. Ten minutes means something on
 * their side is not running, and saying so beats leaving the Buyer to wonder
 * whether they did something wrong.
 */
function stalled(requestedAt: string | null): boolean {
  if (!requestedAt) return false;
  const asked = Date.parse(requestedAt);
  return Number.isFinite(asked) && Date.now() - asked > 10 * 60_000;
}

/** A Buyer never sees DRAFT / READY / SUPERSEDED / ARCHIVED raw. */
function statusTone(display: string): string {
  if (display === 'In Use' || display === 'Ready') return 'badge badge-ok';
  if (display === 'Draft') return 'badge badge-warn';
  return 'badge';
}

export default async function AudienceDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireContext(`/audiences/${id}`);

  const [audience, taxonomy] = await Promise.all([
    apiOptional<AudienceDetail>(`/v1/audiences/${id}`),
    apiOptional<{ items: TaxonomyAttribute[] }>('/v1/audiences/taxonomy'),
  ]);
  if (!audience) notFound();

  const current =
    audience.versions.find((v) => v.is_current) ??
    audience.versions.find((v) => v.version === audience.current_version) ??
    audience.versions[0];
  const attributes = taxonomy?.items ?? [];

  const required = current?.rules.filter((r) => r.required) ?? [];
  const optional = current?.rules.filter((r) => !r.required) ?? [];

  const describe = (r: Rule) =>
    describeRule(
      attributes.find((a) => a.key === r.attribute),
      r.value,
      r.attribute,
    );

  // How many campaigns are running on any saved settings of this audience,
  // which is what an edit has to warn about.
  const campaignCount = audience.linked_campaigns.length;
  const isDraft = current?.status === 'DRAFT';

  return (
    <Shell ctx={ctx}>
      <PageHeader
        title={audience.name}
        lead={audience.description ?? undefined}
        actions={
          <Link className="btn-primary" href={`/audiences/${id}/matches`}>
            Use Audience in Campaign
          </Link>
        }
      />

      <div className="btn-row" style={{ marginTop: '-0.4rem', marginBottom: '1rem' }}>
        <span className={statusTone(audience.display_status)}>{audience.display_status}</span>
        {campaignCount > 0 ? (
          <span className="faint small">
            Used by {campaignCount} {campaignCount === 1 ? 'campaign' : 'campaigns'}
          </span>
        ) : null}
      </div>

      <Card title="Audience Conditions">
        {/* An audience with nothing required matches almost any Partner, which
            reads as broad reach and is actually a loss of control over who
            serves it. */}
        {required.length === 0 ? (
          <Notice tone="warn">
            No Required conditions are configured. This audience may match a broad range of Data
            Partners.
          </Notice>
        ) : null}

        <h3 className="small" style={{ margin: '0.2rem 0 0.4rem' }}>
          Required
        </h3>
        {required.length === 0 ? (
          <Empty>None.</Empty>
        ) : (
          <ul className="rule-list">
            {required.map((r) => (
              <li key={r.attribute}>
                <span className="rule-tick" aria-hidden="true">
                  ✓
                </span>
                {describe(r)}
              </li>
            ))}
          </ul>
        )}

        <h3 className="small" style={{ margin: '1rem 0 0.4rem' }}>
          Optional
        </h3>
        {optional.length === 0 ? (
          <Empty>None.</Empty>
        ) : (
          <ul className="rule-list">
            {optional.map((r) => (
              <li key={r.attribute}>
                <span className="rule-dot" aria-hidden="true">
                  •
                </span>
                {describe(r)}
                <span className="faint small"> · {importanceLabel(r.weight)}</span>
              </li>
            ))}
          </ul>
        )}

        <p className="faint small" style={{ marginBottom: 0 }}>
          A Data Partner must be able to answer every <strong>Required</strong> condition to be
          matched. Optional conditions only affect how well they rank.
        </p>

        <AudienceVersionActions audienceId={id} versionStatus={current?.status ?? 'DRAFT'} />
      </Card>

      <Card title="Partner Matches">
        <p className="muted" style={{ marginTop: 0 }}>
          Which Data Partners can evaluate these conditions against their own data.
        </p>
        <Link className="btn-secondary" href={`/audiences/${id}/matches`}>
          View Partner matches
        </Link>
      </Card>

      <Card title="Reach Estimates">
        {audience.reach_estimates.length === 0 ? (
          <Empty>
            No estimates yet. Open <Link href={`/audiences/${id}/matches`}>Partner matches</Link> to
            ask a Partner for one.
          </Empty>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Partner</th>
                <th>Status</th>
                <th>Reach</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {audience.reach_estimates.map((e) => (
                <tr key={e.reach_estimate_id}>
                  <td>{e.partner_name}</td>
                  <td>
                    <StatusBadge status={e.status} />
                    {e.failure_reason ? (
                      <div className="faint small">{e.failure_reason}</div>
                    ) : null}
                    {/* The estimate is computed inside the Partner. If their
                        systems are not reporting, the request stays pending
                        indefinitely — and a Buyer watching "requested" with
                        nothing beside it cannot tell that from "asked a moment
                        ago". Ten minutes is well past the usual few seconds. */}
                    {e.status === 'REQUESTED' && stalled(e.requested_at) ? (
                      <div className="faint small">
                        No response yet. This is worked out on the Partner&rsquo;s side, so it waits
                        until their systems answer.
                      </div>
                    ) : null}
                  </td>
                  <td>
                    {e.status === 'BELOW_THRESHOLD' ? (
                      <span className="faint">too small to report</span>
                    ) : (
                      <Reach bucket={e.reach_bucket} />
                    )}
                  </td>
                  <td className="faint">{relative(e.freshness_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="faint small">
          Reach is always a range. Each Partner works it out from their own data.
        </p>
      </Card>

      <Card title="Linked Campaigns">
        {audience.linked_campaigns.length === 0 ? (
          <Empty>Not used by any campaign yet.</Empty>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Campaign</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {audience.linked_campaigns.map((c) => (
                <tr key={c.campaign_id}>
                  <td>
                    <Link href={`/campaigns/${c.campaign_id}`}>{c.campaign_name}</Link>
                  </td>
                  <td>
                    <StatusBadge status={c.campaign_status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="faint small">
          Each campaign keeps the settings it started with. Editing here never changes a running
          campaign.
        </p>
      </Card>

      {/* Editing and history are both real, both occasionally needed, and
          neither belongs in the reading path of someone who opened this page to
          check their reach. */}
      <Card title="More">
        {attributes.length > 0 && current ? (
          <details>
            <summary style={{ cursor: 'pointer' }}>Edit audience conditions</summary>
            <div style={{ marginTop: '0.9rem' }}>
              <EditInUseConfirm campaignCount={campaignCount}>
                <Notice tone="plain">
                  {isDraft
                    ? 'Saving updates this draft.'
                    : 'Saving creates a new set of settings. Running campaigns are not affected.'}
                </Notice>
                <EditAudienceRulesForm
                  audienceId={id}
                  attributes={attributes}
                  rules={current.rules}
                />
              </EditInUseConfirm>
            </div>
          </details>
        ) : null}

        <details style={{ marginTop: '0.6rem' }}>
          <summary style={{ cursor: 'pointer' }}>Change history</summary>
          <table className="table" style={{ marginTop: '0.9rem' }}>
            <thead>
              <tr>
                <th>Settings</th>
                <th>Saved</th>
                <th>Used by</th>
              </tr>
            </thead>
            <tbody>
              {audience.versions.map((v) => (
                <tr key={v.version}>
                  <td>{v.display_status}</td>
                  <td className="faint">{relative(v.created_at)}</td>
                  <td className="faint">
                    {v.used_by_campaigns === 0
                      ? '—'
                      : `${v.used_by_campaigns} ${v.used_by_campaigns === 1 ? 'campaign' : 'campaigns'}`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="faint small" style={{ marginBottom: 0 }}>
            Previous settings are kept because campaigns approved against them are still running on
            them.
          </p>
        </details>
      </Card>
    </Shell>
  );
}
