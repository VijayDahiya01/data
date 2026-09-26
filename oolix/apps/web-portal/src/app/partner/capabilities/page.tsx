/**
 * Partner capabilities and local mapping health — v6 §5.1, §5.2, §18.2.
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
 */
import { requireContext } from '@/lib/nav-entry';
import { apiOptional } from '@/lib/api';
import { Shell } from '@/components/Shell';
import { Card, Empty, Notice, PageHeader, StatusBadge, relative } from '@/components/ui';
import { CapabilitiesForm } from '@/components/CapabilitiesForm';
import type { TaxonomyAttribute } from '@/components/AudienceBuilder';

interface Capabilities {
  capability_version: number | null;
  attributes: { attribute_key: string; operators: string[]; status?: string }[];
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

interface AgentRow {
  agent_id: string;
  status: string;
  last_heartbeat_at?: string | null;
  agent_version?: string | null;
  config_version?: number | null;
}

export default async function CapabilitiesPage() {
  const ctx = await requireContext('/partner/capabilities');

  const [capabilities, taxonomy, agents, quality] = await Promise.all([
    apiOptional<Capabilities>('/v1/partner/capabilities'),
    apiOptional<{ items: TaxonomyAttribute[] }>('/v1/audiences/taxonomy'),
    apiOptional<{ items: AgentRow[] }>('/v1/partner/agents'),
    apiOptional<DataQuality>('/v1/partner/capabilities/quality'),
  ]);

  const attributes = taxonomy?.items ?? [];
  const declared = capabilities?.attributes ?? [];
  const declaredKeys = declared.map((a) => a.attribute_key);
  const agent = agents?.items?.[0];

  return (
    <Shell ctx={ctx}>
      <PageHeader title="Audience capabilities" lead="What Buyers can ask you about." />

      <Notice tone="info">
        Buyers are matched to you on this list alone.{' '}
        <strong>No Buyer sees your data or your customers.</strong> If you connected your data with
        the setup page, your Agent publishes this list itself after each nightly refresh, offering
        only attributes your customer table actually holds.
      </Notice>

      <Card title="Local mapping health">
        <dl className="kv">
          <dt>Capability version</dt>
          <dd>
            {capabilities?.capability_version ? (
              <>
                v{capabilities.capability_version}
                <span className="faint small">
                  {' '}
                  published {relative(capabilities.published_at)}
                </span>
              </>
            ) : (
              <span className="faint">not published yet</span>
            )}
          </dd>

          <dt>Mapping version</dt>
          <dd>
            {capabilities?.mapping_version ?? <span className="faint">not declared</span>}
            <div className="faint small">Must match your Agent&apos;s setting.</div>
          </dd>

          <dt>Agent</dt>
          <dd>
            {agent ? (
              <>
                <StatusBadge status={agent.status} />
                <span className="faint small">
                  {' '}
                  {agent.agent_version ?? 'unknown version'} · last heartbeat{' '}
                  {relative(agent.last_heartbeat_at)}
                </span>
              </>
            ) : (
              <span className="faint">No Agent connected yet</span>
            )}
          </dd>

          <dt>Attributes declared</dt>
          <dd>{declared.length}</dd>
        </dl>
      </Card>

      {quality?.reported_at ? (
        <Card title="How complete your data is">
          <p className="muted" style={{ marginTop: 0 }}>
            From your Agent&rsquo;s last full refresh, {relative(quality.synced_at)}:{' '}
            {BUCKET_LABELS[quality.customers_bucket ?? ''] ?? 'an unknown number of'} customers who
            agreed to marketing. Only these percentages reach Oolix, and only you see them.
          </p>
          <table className="table">
            <thead>
              <tr>
                <th>Attribute</th>
                <th>Customers with a value</th>
                <th>Values that could not be read</th>
              </tr>
            </thead>
            <tbody>
              {quality.attributes.map((q) => {
                const def = attributes.find((t) => t.key === q.attribute_key);
                return (
                  <tr key={q.attribute_key}>
                    <td>{def?.display_name ?? q.attribute_key}</td>
                    <td>{q.coverage_pct}%</td>
                    <td className="faint">{q.unreadable_pct}%</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="faint small" style={{ marginBottom: 0 }}>
            To raise these, answer the unknown values on your Agent&rsquo;s setup page.
          </p>
        </Card>
      ) : null}

      <Card title="What Buyers can ask you">
        {declared.length === 0 ? (
          <Empty>Nothing published yet, so Buyers cannot find you.</Empty>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Attribute</th>
                <th>Operators</th>
              </tr>
            </thead>
            <tbody>
              {declared.map((a) => {
                const def = attributes.find((t) => t.key === a.attribute_key);
                return (
                  <tr key={a.attribute_key}>
                    <td>
                      {def?.display_name ?? a.attribute_key}
                      <div className="faint small">{a.attribute_key}</div>
                    </td>
                    <td className="faint">{a.operators.join(', ')}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Card>

      {attributes.length === 0 ? (
        <Notice tone="danger">The attribute taxonomy could not be loaded.</Notice>
      ) : (
        <Card title="Publish capabilities">
          <CapabilitiesForm
            attributes={attributes}
            selectedKeys={declaredKeys}
            geographies={capabilities?.geographies ?? ['IN']}
            channels={capabilities?.channels ?? ['PARTNER_WEB']}
            mappingVersion={capabilities?.mapping_version ?? null}
          />
        </Card>
      )}
    </Shell>
  );
}
