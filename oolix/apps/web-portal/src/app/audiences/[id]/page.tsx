/**
 * Audience detail.
 *
 * The page answers, in this order: who is this audience, who can reach them
 * and how many, and what is already running on it.
 *
 * Partner matches and reach estimates used to be two cards and a page of
 * their own, with a checkbox per Partner to ask for an estimate. They are one
 * list now. Finishing an audience asks every Partner that can evaluate it, and
 * the page refreshes itself while answers are on their way.
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
import { Card, Empty, Notice, PageHeader, StatusBadge, relative } from '@/components/ui';
import type { TaxonomyAttribute } from '@/components/AudienceBuilder';
import { AutoRefresh } from '@/components/AutoRefresh';
import { reachLabel } from '@/components/reach';
import { describeRule, importanceLabel } from '@/lib/audience-vocabulary';
import {
  AskPartnersForm,
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

interface Estimate {
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
  reach_estimates: Estimate[];
  linked_campaigns: {
    campaign_id: string;
    campaign_name: string;
    campaign_status: string;
    audience_version: number;
  }[];
}

interface Match {
  partner_org_id: string;
  partner_name: string;
  status: string;
  missing_required_rules: string[];
}

const WORKING = new Set(['REQUESTED', 'PROCESSING']);

/**
 * Has this estimate been pending long enough to be worth explaining?
 *
 * A Partner's Agent normally answers in seconds. Ten minutes means something on
 * their side is not running, and saying so beats leaving the Buyer to wonder
 * whether they did something wrong.
 */
function stalled(e: Estimate): boolean {
  if (!WORKING.has(e.status) || !e.requested_at) return false;
  const asked = Date.parse(e.requested_at);
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

  const [audience, taxonomy, matches] = await Promise.all([
    apiOptional<AudienceDetail>(`/v1/audiences/${id}`),
    apiOptional<{ items: TaxonomyAttribute[] }>('/v1/audiences/taxonomy'),
    apiOptional<{ items: Match[] }>(`/v1/audiences/${id}/partner-matches`),
  ]);
  if (!audience) notFound();

  const current =
    audience.versions.find((v) => v.is_current) ??
    audience.versions.find((v) => v.version === audience.current_version) ??
    audience.versions[0];
  const attributes = taxonomy?.items ?? [];
  const nameOf = (key: string) => attributes.find((a) => a.key === key)?.display_name ?? key;

  const required = current?.rules.filter((r) => r.required) ?? [];
  const optional = current?.rules.filter((r) => !r.required) ?? [];
  const describe = (r: Rule) =>
    describeRule(
      attributes.find((a) => a.key === r.attribute),
      r.value,
      r.attribute,
    );

  const campaignCount = audience.linked_campaigns.length;
  const isDraft = current?.status === 'DRAFT';

  // The newest estimate per Partner, for these settings.
  const latest = new Map<string, Estimate>();
  for (const e of audience.reach_estimates) {
    if (current && e.audience_version !== current.version) continue;
    const seen = latest.get(e.partner_org_id);
    if (!seen || Date.parse(e.requested_at ?? '') > Date.parse(seen.requested_at ?? '')) {
      latest.set(e.partner_org_id, e);
    }
  }
  const compatible = (matches?.items ?? []).filter((m) => m.status !== 'INCOMPATIBLE');
  const excluded = (matches?.items ?? []).filter((m) => m.status === 'INCOMPATIBLE');
  const unasked = compatible.some((m) => !latest.has(m.partner_org_id));
  const working = compatible.some((m) => WORKING.has(latest.get(m.partner_org_id)?.status ?? ''));

  return (
    <Shell ctx={ctx}>
      <PageHeader
        title={audience.name}
        lead={audience.description ?? undefined}
        actions={
          isDraft ? null : (
            <Link className="btn btn-primary" href={`/campaigns/new?audience=${id}`}>
              Use in a campaign
            </Link>
          )
        }
      />
      {working ? <AutoRefresh /> : null}

      <div className="btn-row" style={{ marginTop: '-0.4rem', marginBottom: '1rem' }}>
        <span className={statusTone(audience.display_status)}>{audience.display_status}</span>
        {campaignCount > 0 ? (
          <span className="faint small">
            Used by {campaignCount} {campaignCount === 1 ? 'campaign' : 'campaigns'}
          </span>
        ) : null}
      </div>

      <Card title="Who">
        {/* An audience with nothing required matches almost any Partner, which
            reads as broad reach and is actually a loss of control over who
            serves it. */}
        {required.length === 0 ? (
          <Notice tone="warn">
            Nothing is required, so almost any Partner matches. Make the conditions that matter
            required.
          </Notice>
        ) : null}

        <ul className="rule-list">
          {required.map((r) => (
            <li key={r.attribute}>
              <span className="rule-tick" aria-hidden="true">
                ✓
              </span>
              {describe(r)}
            </li>
          ))}
          {optional.map((r) => (
            <li key={r.attribute} className="muted">
              <span className="rule-dot" aria-hidden="true">
                •
              </span>
              {describe(r)}
              <span className="faint small">
                {' '}
                · optional, {importanceLabel(r.weight).toLowerCase()}
              </span>
            </li>
          ))}
        </ul>

        <AudienceVersionActions audienceId={id} versionStatus={current?.status ?? 'DRAFT'} />
      </Card>

      <Card title="Partners who can reach them">
        {isDraft ? (
          <Empty>Finish the audience to see which Partners can reach these people.</Empty>
        ) : compatible.length === 0 ? (
          <Empty>
            No Partner can reach this audience yet: each one is missing a condition you made
            required. Make that condition optional under Edit, below.
          </Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Partner</th>
                  <th>Can reach</th>
                  <th>Updated</th>
                </tr>
              </thead>
              <tbody>
                {compatible.map((m) => {
                  const e = latest.get(m.partner_org_id);
                  return (
                    <tr key={m.partner_org_id}>
                      <td>{m.partner_name}</td>
                      <td>
                        {reachLabel(e?.reach_bucket ?? null, e?.status ?? null)}
                        {e?.failure_reason ? (
                          <div className="faint small">{e.failure_reason}</div>
                        ) : null}
                        {/* The estimate is computed inside the Partner. Ten
                            minutes is well past the usual few seconds, and a
                            Buyer cannot tell "not running" from "asked a
                            moment ago" without being told. */}
                        {e && stalled(e) ? (
                          <div className="faint small">
                            No answer yet: it is worked out on the Partner&rsquo;s side, and waits
                            until their systems answer.
                          </div>
                        ) : null}
                      </td>
                      <td className="faint">{relative(e?.freshness_at ?? null)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {!isDraft && compatible.length > 0 && unasked ? <AskPartnersForm audienceId={id} /> : null}

        <p className="faint small" style={{ marginBottom: 0 }}>
          Each Partner works out a range from its own data; ranges are never added up, since one
          person can be with two Partners.
        </p>

        {excluded.length > 0 ? (
          <details className="more" style={{ marginBottom: 0 }}>
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
      </Card>

      {campaignCount > 0 ? (
        <Card title="Campaigns using it">
          <ul className="plain-list">
            {audience.linked_campaigns.map((c) => (
              <li key={c.campaign_id}>
                <Link href={`/campaigns/${c.campaign_id}`}>{c.campaign_name}</Link>{' '}
                <StatusBadge status={c.campaign_status} />
              </li>
            ))}
          </ul>
          <p className="faint small" style={{ marginBottom: 0 }}>
            Each keeps the settings it started with: editing here never changes them.
          </p>
        </Card>
      ) : null}

      {/* Editing and history are both real, both occasionally needed, and
          neither belongs in the reading path of someone who opened this page to
          check their reach. */}
      <Card title="More">
        {attributes.length > 0 && current ? (
          <details>
            <summary style={{ cursor: 'pointer' }}>Edit conditions</summary>
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
            Earlier settings are kept because campaigns approved against them still run on them.
          </p>
        </details>
      </Card>
    </Shell>
  );
}
