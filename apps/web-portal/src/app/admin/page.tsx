/**
 * Oolix platform operations (§98).
 *
 * §98.1 permits aggregates and health signals only, and this screen is a good
 * place to notice what that excludes: no customer, no membership, no segment
 * size. §66 is equally firm that OOLIX_ADMIN "cannot bypass Partner approval or
 * access Partner raw DB" — there is no button here that would let it.
 */
import { requireContext } from '@/lib/nav-entry';
import { apiOptional } from '@/lib/api';
import { Shell } from '@/components/Shell';
import { Card, Empty, Notice, PageHeader, StatusBadge, relative } from '@/components/ui';

interface AgentRow {
  agent_id: string;
  partner: string;
  version: string;
  heartbeat_age_seconds: number | null;
  config_age_seconds: number | null;
  config_version: number;
  status: string;
}

interface Dashboard {
  generated_at: string;
  agent_health: { total: number; healthy: number; degraded: number; agents: AgentRow[] };
  activations?: Record<string, number>;
  requests?: Record<string, number>;
  queue?: Record<string, number>;
}

interface NoAdRow {
  reason: string;
  count: number;
}

function ageLabel(seconds: number | null): string {
  if (seconds === null) return 'never';
  if (seconds < 60) return `${Math.round(seconds)}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  return `${Math.round(seconds / 3600)}h ago`;
}

export default async function AdminPage() {
  const ctx = await requireContext('/admin');

  const [dashboard, noAd] = await Promise.all([
    apiOptional<Dashboard>('/v1/admin/ops/dashboard'),
    apiOptional<{ items: NoAdRow[] }>('/v1/admin/ops/no-ad-distribution'),
  ]);

  if (!dashboard) {
    return (
      <Shell ctx={ctx}>
        <PageHeader title="Operations" lead="Platform health and activity." />
        <Notice tone="warn">
          This dashboard needs the platform operator role, and your active organization does not
          hold it. Switch organization in the sidebar if you have another.
        </Notice>
      </Shell>
    );
  }

  const health = dashboard.agent_health;
  const reasons = noAd?.items ?? [];
  const totalNoAd = reasons.reduce((s, r) => s + r.count, 0);

  return (
    <Shell ctx={ctx}>
      <PageHeader
        title="Operations"
        lead={`Aggregate health and activity. Generated ${relative(dashboard.generated_at)}.`}
      />

      <div className="grid" style={{ marginBottom: '1.4rem' }}>
        <div className="stat">
          <div className="stat-label">Agents</div>
          <div className="stat-value">{health.total}</div>
          <div className="stat-note">across all Partners</div>
        </div>
        <div className="stat">
          <div className="stat-label">Healthy</div>
          <div className="stat-value" style={{ color: 'var(--ok)' }}>
            {health.healthy}
          </div>
        </div>
        <div className="stat">
          <div className="stat-label">Degraded</div>
          <div
            className="stat-value"
            style={{ color: health.degraded ? 'var(--warn)' : undefined }}
          >
            {health.degraded}
          </div>
          <div className="stat-note">Stale heartbeat or config</div>
        </div>
      </div>

      <Card title="Partner Agent health">
        {health.agents.length === 0 ? (
          <Empty>No Agents registered.</Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Agent</th>
                  <th>Partner</th>
                  <th>Version</th>
                  <th>Heartbeat</th>
                  <th>Config age</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {health.agents.map((a) => (
                  <tr key={a.agent_id}>
                    <td>
                      <code>{a.agent_id.slice(0, 8)}…</code>
                    </td>
                    <td className="muted">{a.partner}</td>
                    <td className="muted">{a.version}</td>
                    <td className="muted">{ageLabel(a.heartbeat_age_seconds)}</td>
                    <td className="muted">{ageLabel(a.config_age_seconds)}</td>
                    <td>
                      <StatusBadge status={a.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="faint" style={{ marginBottom: 0, marginTop: '0.7rem' }}>
          A quiet Agent has not stopped serving. It keeps running the last instructions it was
          given, for a limited time. What this tells you is that Oolix can no longer confirm what is
          running — worth looking into, but not an outage.
        </p>
      </Card>

      {reasons.length ? (
        <Card title="Why ads were not served">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Reason</th>
                  <th>Count</th>
                  <th>Share</th>
                </tr>
              </thead>
              <tbody>
                {reasons.map((r) => (
                  <tr key={r.reason}>
                    <td>{r.reason.replaceAll('_', ' ').toLowerCase()}</td>
                    <td style={{ fontVariantNumeric: 'tabular-nums' }}>{r.count}</td>
                    <td className="muted">
                      {totalNoAd ? `${Math.round((r.count / totalNoAd) * 100)}%` : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="faint" style={{ marginBottom: 0, marginTop: '0.7rem' }}>
            These describe a decision, not a person — which is why they are safe to add up at all.
          </p>
        </Card>
      ) : null}

      <Notice tone="plain">
        Everything here is a total. No customer, no membership and no exact audience size appears on
        this page — or on any other. Running the platform does not include the power to approve on a
        Data Partner&rsquo;s behalf, or to reach into their data.
      </Notice>
    </Shell>
  );
}
