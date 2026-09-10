/**
 * Partner matches — v6 §7, §18.1.
 *
 * §18.1 replaces the old segment cards with "Partner-match cards with
 * supported/missing fields and estimate status", and asks for "compatible
 * first, incompatible below, missing optional rules, channels, Request
 * Estimate".
 *
 * The single most important thing this screen has to communicate is what the
 * match score is NOT. It measures whether a Partner's data can EVALUATE these
 * rules — schema compatibility — and says nothing about whether their audience
 * is any good. A Buyer who reads 91% as "91% as valuable" will pick the wrong
 * Partner, so the page says so in as many words (§7).
 */
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireContext } from '@/lib/nav-entry';
import { apiOptional } from '@/lib/api';
import { Shell } from '@/components/Shell';
import { Card, Empty, Notice, PageHeader, Reach, StatusBadge, relative } from '@/components/ui';
import { RequestEstimatesForm } from '@/components/AudienceForms';
import type { TaxonomyAttribute } from '@/components/AudienceBuilder';

interface MatchItem {
  partner_org_id: string;
  partner_name: string;
  partner_industry: string | null;
  status: string;
  match_score: number;
  supported_rules: string[];
  missing_required_rules: string[];
  missing_optional_rules: string[];
  capability_version: number;
  geographies: string[];
  channels: { channel: string; status: string }[];
  reach_estimate: {
    reach_estimate_id: string;
    status: string;
    reach_bucket: string | null;
    freshness_at: string | null;
    expires_at: string | null;
  } | null;
}

interface MatchResponse {
  audience_group_id: string;
  audience_version: number;
  rule_hash: string;
  items: MatchItem[];
  notice?: string;
}

const CHANNEL_LABELS: Record<string, string> = {
  PARTNER_WEB: 'Their website',
  PARTNER_APP: 'Their app',
  META: 'Meta',
  GOOGLE: 'Google',
};

export default async function PartnerMatchesPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireContext(`/audiences/${id}/matches`);

  const [matches, taxonomy, audience] = await Promise.all([
    apiOptional<MatchResponse>(`/v1/audiences/${id}/partner-matches`),
    apiOptional<{ items: TaxonomyAttribute[] }>('/v1/audiences/taxonomy'),
    apiOptional<{ name: string }>(`/v1/audiences/${id}`),
  ]);
  if (!matches) notFound();

  const nameOf = (key: string) => taxonomy?.items.find((a) => a.key === key)?.display_name ?? key;

  const compatible = matches.items.filter((m) => m.status !== 'INCOMPATIBLE');
  const incompatible = matches.items.filter((m) => m.status === 'INCOMPATIBLE');

  return (
    <Shell ctx={ctx}>
      <PageHeader
        title="Partner matches"
        lead={`${audience?.name ?? 'This audience'} · version ${matches.audience_version}`}
        actions={
          <Link className="btn-secondary" href={`/audiences/${id}`}>
            Back to audience
          </Link>
        }
      />

      <Notice tone="info">
        <strong>Match score is about fit, not quality.</strong> It shows how much of your audience a
        Partner can match — not how good their customers are for you.
      </Notice>

      {compatible.length === 0 ? (
        <Card title="Compatible Partners">
          <Empty>
            No Partner can evaluate every required rule in this audience. Look at the excluded
            Partners below: each names the attribute it is missing, and relaxing that one rule from
            required to optional is usually enough.
          </Empty>
        </Card>
      ) : (
        compatible.map((m) => (
          <Card key={m.partner_org_id} title={m.partner_name}>
            <div className="btn-row" style={{ marginTop: 0, marginBottom: '0.75rem' }}>
              <StatusBadge status={m.status} />
              <span className="faint small">
                {m.match_score}% match{m.partner_industry ? ` · ${m.partner_industry}` : ''}
              </span>
            </div>

            <dl className="kv">
              <dt>Can match</dt>
              <dd>{m.supported_rules.map(nameOf).join(', ') || '—'}</dd>

              {m.missing_optional_rules.length > 0 ? (
                <>
                  <dt>Cannot match</dt>
                  <dd>
                    {m.missing_optional_rules.map(nameOf).join(', ')}
                    <div className="faint small">
                      Optional only — your Required conditions still apply.
                    </div>
                  </dd>
                </>
              ) : null}

              <dt>Geographies</dt>
              <dd>{m.geographies.join(', ') || '—'}</dd>

              <dt>Channels</dt>
              <dd>
                {m.channels.length === 0
                  ? '—'
                  : m.channels.map((c) => (
                      <span key={c.channel} style={{ marginRight: '0.75rem' }}>
                        {CHANNEL_LABELS[c.channel] ?? c.channel}
                        {c.status === 'CONDITIONAL' ? (
                          <span className="faint small"> (conditional)</span>
                        ) : null}
                      </span>
                    ))}
              </dd>

              <dt>Safe reach</dt>
              <dd>
                {!m.reach_estimate ? (
                  <span className="faint">not estimated yet</span>
                ) : m.reach_estimate.status === 'BELOW_THRESHOLD' ? (
                  <span className="faint">too small to report</span>
                ) : m.reach_estimate.status === 'READY' ? (
                  <>
                    <Reach bucket={m.reach_estimate.reach_bucket} />
                    <span className="faint small">
                      {' '}
                      computed {relative(m.reach_estimate.freshness_at)}
                    </span>
                  </>
                ) : (
                  <StatusBadge status={m.reach_estimate.status} />
                )}
              </dd>
            </dl>
          </Card>
        ))
      )}

      <Card title="Request a reach estimate">
        <RequestEstimatesForm
          audienceId={id}
          partners={matches.items.map((m) => ({
            partner_org_id: m.partner_org_id,
            partner_name: m.partner_name,
            status: m.status,
          }))}
        />
      </Card>

      {incompatible.length > 0 ? (
        <Card title="Excluded Partners">
          <p className="faint small">
            These Partners cannot match a condition you marked Required.
          </p>
          <table className="table">
            <thead>
              <tr>
                <th>Partner</th>
                <th>Missing required</th>
                <th>Coverage</th>
              </tr>
            </thead>
            <tbody>
              {incompatible.map((m) => (
                <tr key={m.partner_org_id}>
                  <td>{m.partner_name}</td>
                  <td>
                    <strong>{m.missing_required_rules.map(nameOf).join(', ')}</strong>
                  </td>
                  <td className="faint">{m.match_score}%</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="faint small">
            To include them, change that condition to Optional in your audience.
          </p>
        </Card>
      ) : null}
    </Shell>
  );
}
