/**
 * Partner Agent and connector (§69, §92).
 *
 * This is the screen where a Partner takes physical control of the thing that
 * touches their customer data. The Agent runs in their infrastructure, mints
 * its own private key, and can be cut off from Oolix immediately — all three
 * facts are visible here rather than buried in a runbook.
 */
import { requireContext, can } from '@/lib/nav-entry';
import { apiOptional } from '@/lib/api';
import { Shell } from '@/components/Shell';
import { Card, Empty, Notice, PageHeader, StatusBadge, duration, relative } from '@/components/ui';
import {
  BootstrapTokenForm,
  RevokeAgentForm,
  RevokeBootstrapTokensForm,
} from '@/components/OpsForms';

interface Agent {
  /** The API names this `agent_id`, not `id`. */
  agent_id: string;
  client_id?: string;
  version: string;
  status: string;
  last_heartbeat_at: string | null;
  config_age_seconds: number | null;
  heartbeat_age_seconds?: number | null;
  capabilities?: string[];
  created_at?: string;
}

/** Short, readable handle for an Agent. Tolerates a missing id rather than throwing. */
const shortId = (id: string | undefined) => (id ? `${id.slice(0, 8)}…` : 'unknown');

/** §78.2: heartbeat stale past 5 minutes, control sync critical past 15. */
function health(agent: Agent): { tone: string; text: string } {
  if (agent.status !== 'ACTIVE') return { tone: 'badge badge-danger', text: 'revoked' };
  if (!agent.last_heartbeat_at) return { tone: 'badge badge-warn', text: 'never seen' };

  const ageSeconds = (Date.now() - Date.parse(agent.last_heartbeat_at)) / 1000;
  if (ageSeconds > 300) return { tone: 'badge badge-danger', text: 'heartbeat stale' };

  const configAge = agent.config_age_seconds ?? 0;
  if (configAge > 900) return { tone: 'badge badge-danger', text: 'config critically stale' };
  if (configAge > 300) return { tone: 'badge badge-warn', text: 'config lagging' };

  return { tone: 'badge badge-ok', text: 'healthy' };
}

export default async function IntegrationsPage() {
  const ctx = await requireContext('/partner/integrations');
  const data = await apiOptional<{ items: Agent[] }>('/v1/partner/agents');
  const all = data?.items ?? [];

  // Active first, then most recently seen. A long-running environment
  // accumulates registrations, and the ones that matter operationally are the
  // ones still running.
  const agents = [...all]
    .sort((a, b) => {
      if (a.status !== b.status) return a.status === 'ACTIVE' ? -1 : 1;
      return (
        Date.parse(b.last_heartbeat_at ?? b.created_at ?? '0') -
        Date.parse(a.last_heartbeat_at ?? a.created_at ?? '0')
      );
    })
    .slice(0, 12);

  const mayRegister = can(ctx, 'agent:register');
  const mayRevoke = can(ctx, 'agent:revoke');

  return (
    <Shell ctx={ctx}>
      <PageHeader
        title="Integrations"
        lead="The Agent that runs inside your infrastructure and decides every ad locally."
      />

      <Card
        title={
          all.length > agents.length
            ? `Agents (${agents.length} of ${all.length}, most recent first)`
            : `Agents (${all.length})`
        }
      >
        {agents.length === 0 ? (
          <Empty>
            No Agent registered yet. Generate a bootstrap token below and start the Agent with it.
          </Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Agent</th>
                  <th>Version</th>
                  <th>Health</th>
                  <th>Last heartbeat</th>
                  <th>Config age</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {agents.map((a) => {
                  const h = health(a);
                  return (
                    <tr key={a.agent_id}>
                      <td>
                        <code>{shortId(a.agent_id)}</code>
                        {a.capabilities?.length ? (
                          <div className="faint">
                            {a.capabilities
                              .map((c) => c.replace('PARTNER_', '').toLowerCase())
                              .join(', ')}
                          </div>
                        ) : null}
                      </td>
                      <td className="muted">{a.version}</td>
                      <td>
                        <span className={h.tone}>{h.text}</span>
                      </td>
                      <td className="muted">
                        {a.last_heartbeat_at ? relative(a.last_heartbeat_at) : 'never'}
                      </td>
                      <td className="muted">{duration(a.config_age_seconds)}</td>
                      <td>
                        <StatusBadge status={a.status} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {mayRegister ? (
        <Card title="Register a new Agent">
          <BootstrapTokenForm />
          <div
            style={{
              marginTop: '1rem',
              paddingTop: '0.9rem',
              borderTop: '1px solid var(--border)',
            }}
          >
            <RevokeBootstrapTokensForm />
            <div className="field-hint" style={{ marginTop: '0.4rem' }}>
              Invalidates every token that has been generated but not yet used.
            </div>
          </div>
        </Card>
      ) : (
        <Notice tone="warn">
          Registering an Agent needs your security admin, not your commercial admin. The two are
          kept separate on purpose.
        </Notice>
      )}

      {mayRevoke && agents.some((a) => a.status === 'ACTIVE') ? (
        <Card title="Emergency revocation">
          <p className="muted" style={{ marginTop: 0 }}>
            Revocation takes effect <strong>immediately</strong> — not whenever the Agent&rsquo;s
            current credentials would have run out. The Agent is refused on its very next check-in
            and reports itself unhealthy, so it drops out of service instead of carrying on with old
            instructions.
          </p>
          {agents
            .filter((a) => a.status === 'ACTIVE')
            .map((a) => (
              <details key={a.agent_id} style={{ marginBottom: '0.6rem' }}>
                <summary style={{ cursor: 'pointer' }} className="muted">
                  Revoke <code>{shortId(a.agent_id)}</code>
                </summary>
                <div style={{ marginTop: '0.75rem' }}>
                  <RevokeAgentForm agentId={a.agent_id} />
                </div>
              </details>
            ))}
        </Card>
      ) : null}

      <Card title="How the Agent gets its identity">
        <ol className="muted" style={{ margin: 0, paddingLeft: '1.15rem' }}>
          <li>
            You generate a bootstrap token above. It is single-use, expires in 15 minutes, and Oolix
            keeps only its SHA-256.
          </li>
          <li>
            The Agent starts, generates a <strong>P-256 keypair inside your infrastructure</strong>,
            and registers with the token plus its <em>public</em> key. The private key never leaves
            your infrastructure.
          </li>
          <li>
            From then on it proves possession of that key to get a 15-minute access token. Oolix
            cannot produce a signature that appears to come from your Agent.
          </li>
        </ol>
        <p className="faint" style={{ marginBottom: 0, marginTop: '0.7rem' }}>
          The connector — which database the Agent reads and with which query — is configured in
          your own config file, not here. Nothing Oolix sends can widen what it reads.
        </p>
      </Card>
    </Shell>
  );
}
