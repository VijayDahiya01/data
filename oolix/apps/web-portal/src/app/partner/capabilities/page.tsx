/**
 * What Buyers can ask a Partner about — v6 §5.1, §5.2, §18.2.
 *
 * §18.2 asks for two things on this screen: the standardized attributes the
 * Partner can evaluate, and "local mapping health: mapping version, connector
 * health, freshness — no Buyer access to field names".
 *
 * That last clause is a constraint on this page, not a footnote. Everything a
 * Buyer sees about this Partner comes from the capability list — taxonomy keys
 * and nothing else. The mapping that turns `payment_method` into whatever this
 * Partner's own schema calls it lives with the Agent -- on its setup page
 * (Partner Connect) or in its config file -- on the Partner's own
 * infrastructure, and does not appear anywhere in Oolix.
 *
 * A Partner who connected through the setup page has an Agent that publishes
 * this list by itself after each refresh, so for them the page is the list,
 * with how complete each attribute is, and who can find them. Publishing by
 * hand, the mapping and capability versions and the operators are for
 * config-file Agents, and are folded under "Advanced" for everyone else.
 */
import { requireContext } from '@/lib/nav-entry';
import { apiOptional } from '@/lib/api';
import { Shell } from '@/components/Shell';
import { Card, Empty, Notice, PageHeader, StatusBadge, relative } from '@/components/ui';
import { CapabilitiesForm } from '@/components/CapabilitiesForm';
import { MarketplaceListingForm } from '@/components/MarketplaceListingForm';
import type { TaxonomyAttribute } from '@/components/AudienceBuilder';

/** How exactly the Agent's copy holds an attribute; absent when exactly. */
interface Precision {
  kind: 'APPROXIMATE' | 'BANDS' | 'WITHIN' | 'WINDOW';
  unit?: 'YEARS' | 'DAYS';
  width?: number;
  bands?: { lo: number; hi: number | null }[];
  days?: number;
}

function precisionText(p: Precision | undefined): string {
  if (!p) return 'Exactly';
  switch (p.kind) {
    case 'BANDS':
      return `As age groups: ${(p.bands ?? []).map((b) => (b.hi === null ? `${b.lo}+` : `${b.lo}-${b.hi}`)).join(', ')}`;
    case 'APPROXIMATE': {
      const unit = p.unit === 'DAYS' ? 'day' : 'year';
      return `To within ${p.width} ${unit}${p.width === 1 ? '' : 's'}`;
    }
    case 'WITHIN':
      return `Yes or no for the last ${p.days} days`;
    case 'WINDOW':
      return `Counted over the last ${p.days} days`;
  }
}

interface Capabilities {
  capability_version: number | null;
  attributes: {
    attribute_key: string;
    operators: string[];
    status?: string;
    precision?: Precision;
  }[];
  geographies: string[];
  channels: string[];
  mapping_version?: number | null;
  published_at?: string;
}

/** Partner Connect: how complete the managed Agent's copy is. Percentages only. */
interface DataQuality {
  reported_at: string | null;
  synced_at: string | null;
  sync_mode?: 'FULL' | 'INCREMENTAL';
  customers_bucket?: string;
  attributes: { attribute_key: string; coverage_pct: number; unreadable_pct: number }[];
}

/** The reach size bands, in words. */
const BUCKET_LABELS: Record<string, string> = {
  UNDER_10K: 'under 10,000',
  '10K_50K': '10,000 to 50,000',
  '50K_100K': '50,000 to 1 lakh',
  '100K_250K': '1 to 2.5 lakh',
  '250K_500K': '2.5 to 5 lakh',
  '500K_1M': '5 to 10 lakh',
  OVER_1M: 'over 10 lakh',
};

/** §66.2: whether every verified Buyer can find this Partner. */
interface Listing {
  listed: boolean;
  listed_at: string | null;
  capabilities_published: boolean;
}

interface AgentRow {
  agent_id: string;
  status: string;
  last_heartbeat_at?: string | null;
  agent_version?: string | null;
  config_version?: number | null;
}

export default async function CapabilitiesPage() {
  const ctx = await requireContext('/partner/capabilities');

  const [capabilities, taxonomy, agents, quality, listing] = await Promise.all([
    apiOptional<Capabilities>('/v1/partner/capabilities'),
    apiOptional<{ items: TaxonomyAttribute[] }>('/v1/audiences/taxonomy'),
    apiOptional<{ items: AgentRow[] }>('/v1/partner/agents'),
    apiOptional<DataQuality>('/v1/partner/capabilities/quality'),
    apiOptional<Listing>('/v1/partner/listing'),
  ]);

  const attributes = taxonomy?.items ?? [];
  const declared = (capabilities?.attributes ?? []).filter((a) => a.status !== 'UNAVAILABLE');
  const declaredKeys = declared.map((a) => a.attribute_key);
  const agent = agents?.items?.[0];
  // An Agent that reports quality was set up on its setup page and publishes
  // this list by itself.
  const managed = Boolean(quality?.reported_at);
  const nameOf = (key: string) => attributes.find((t) => t.key === key)?.display_name ?? key;
  const coverage = new Map((quality?.attributes ?? []).map((q) => [q.attribute_key, q]));
  const anyInexact = declared.some((a) => a.precision);

  return (
    <Shell ctx={ctx}>
      <PageHeader
        title="What Buyers can ask"
        lead="Buyers are matched to you on this list alone. No Buyer sees your data or your customers."
      />

      <Card title="Attributes">
        {declared.length === 0 ? (
          <Empty>
            Nothing published yet, so Buyers cannot find you.{' '}
            {managed ? null : 'Connect your data, or publish by hand under Advanced below.'}
          </Empty>
        ) : (
          <>
            {managed ? (
              <p className="muted" style={{ marginTop: 0 }}>
                From your Agent&rsquo;s last refresh, {relative(quality?.synced_at ?? null)}:{' '}
                {BUCKET_LABELS[quality?.customers_bucket ?? ''] ?? 'an unknown number of'} customers
                who agreed to marketing.
              </p>
            ) : null}
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Attribute</th>
                    {managed ? <th>Customers with a value</th> : null}
                    {anyInexact ? <th>How exactly</th> : null}
                  </tr>
                </thead>
                <tbody>
                  {declared.map((a) => {
                    const q = coverage.get(a.attribute_key);
                    return (
                      <tr key={a.attribute_key}>
                        <td>{nameOf(a.attribute_key)}</td>
                        {managed ? (
                          <td>
                            {q ? `${q.coverage_pct}%` : '—'}
                            {q && q.unreadable_pct > 0 ? (
                              <span className="faint small"> · {q.unreadable_pct}% unreadable</span>
                            ) : null}
                          </td>
                        ) : null}
                        {anyInexact ? (
                          <td className="muted">{precisionText(a.precision)}</td>
                        ) : null}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="faint small" style={{ marginBottom: 0 }}>
              {managed
                ? 'Only these percentages reach Oolix, and only you see them. To raise them, answer the open questions on your Agent’s setup page.'
                : 'Advertisers are matched only with customers who certainly fit their rules.'}
            </p>
          </>
        )}
      </Card>

      {listing ? (
        <Card title="Who can find you">
          <MarketplaceListingForm
            listed={listing.listed}
            capabilitiesPublished={listing.capabilities_published}
          />
        </Card>
      ) : null}

      <details className="more" open={!managed || undefined}>
        <summary>Advanced: publish by hand</summary>
        <p className="faint small" style={{ marginTop: 0 }}>
          For an Agent run from its own config file. An Agent set up on its setup page publishes by
          itself.
        </p>

        <dl className="kv">
          <dt>Published</dt>
          <dd>
            {capabilities?.capability_version ? (
              <>
                version {capabilities.capability_version}
                <span className="faint small"> · {relative(capabilities.published_at)}</span>
              </>
            ) : (
              <span className="faint">not yet</span>
            )}
          </dd>
          <dt>Mapping version</dt>
          <dd>
            {capabilities?.mapping_version ?? <span className="faint">not declared</span>}
            <span className="faint small"> · must match your Agent&apos;s setting</span>
          </dd>
          <dt>Agent</dt>
          <dd>
            {agent ? (
              <>
                <StatusBadge status={agent.status} />
                <span className="faint small">
                  {' '}
                  {agent.agent_version ?? 'unknown version'} · last heard from{' '}
                  {relative(agent.last_heartbeat_at)}
                </span>
              </>
            ) : (
              <span className="faint">none connected</span>
            )}
          </dd>
        </dl>

        {attributes.length === 0 ? (
          <Notice tone="danger">The attribute list could not be loaded.</Notice>
        ) : (
          <CapabilitiesForm
            attributes={attributes}
            selectedKeys={declaredKeys}
            geographies={capabilities?.geographies ?? ['IN']}
            channels={capabilities?.channels ?? ['PARTNER_WEB']}
            mappingVersion={capabilities?.mapping_version ?? null}
          />
        )}
      </details>
    </Shell>
  );
}
