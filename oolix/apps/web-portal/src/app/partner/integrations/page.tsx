/**
 * Partner Agent and connector (§69, §92) -- "Connection" under Your data.
 *
 * This is the screen where a Partner takes physical control of the thing that
 * touches their customer data. The Agent runs in their infrastructure, mints
 * its own private key, and can be cut off from Oolix immediately — all three
 * facts are here, and the second and third are folded away until wanted.
 *
 * With no Agent running, "Connect your data" leads: one command with a
 * one-time code in it, and the Agent's own setup page does the rest. Once one
 * is running, its status leads. The config-file Agent, revocation and how the
 * Agent proves who it is sit under closed sections at the bottom.
 */
import { requireContext, can } from '@/lib/nav-entry';
import { apiOptional } from '@/lib/api';
import { env } from '@/lib/env';
import { Shell } from '@/components/Shell';
import { Card, Empty, Notice, PageHeader, relative } from '@/components/ui';
import {
  BootstrapTokenForm,
  InstallCommandForm,
  OneTimeCodeForm,
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
  if (ageSeconds > 300) return { tone: 'badge badge-danger', text: 'not heard from' };

  const configAge = agent.config_age_seconds ?? 0;
  if (configAge > 900) return { tone: 'badge badge-danger', text: 'settings out of date' };
  if (configAge > 300) return { tone: 'badge badge-warn', text: 'settings lagging' };

  return { tone: 'badge badge-ok', text: 'running' };
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
  const active = agents.filter((a) => a.status === 'ACTIVE');
  const composeUrl = `${env().API_PUBLIC_URL.replace(/\/+$/, '')}/agent/v1/compose`;

  const connect = mayRegister ? (
    <Card title="Connect your data">
      <p className="muted" style={{ marginTop: 0 }}>
        About fifteen minutes. Nothing is created in your database, and your customers&rsquo;
        details never leave your server.
      </p>
      <InstallCommandForm composeUrl={composeUrl} />
      <p className="muted">
        Then open the setup page on that server, <code>http://localhost:8083</code>, and follow it:
        a read-only login to your database or a folder of exports, your customer table, the matches
        it found, and publish. From your laptop, run{' '}
        <code>ssh -L 8083:localhost:8083 you@that-server</code> first. The password is in{' '}
        <code>docker compose logs agent | grep setup_password</code>.
      </p>
      <details className="more" style={{ marginBottom: 0 }}>
        <summary>Started the Agent without a code?</summary>
        <p className="faint small" style={{ marginTop: 0 }}>
          Get one here and paste it into its setup page. Or{' '}
          <a href={composeUrl}>download docker-compose.yml</a> to copy to the server yourself.
        </p>
        <OneTimeCodeForm />
      </details>
    </Card>
  ) : (
    <Notice tone="warn">
      Connecting an Agent needs your security admin, not your commercial admin. The two are kept
      separate on purpose.
    </Notice>
  );

  return (
    <Shell ctx={ctx}>
      <PageHeader
        title="Connection"
        lead="The Agent runs on your server, reads your data there, and decides every ad there."
      />

      {active.length === 0 ? connect : null}

      <Card title="Your Agent">
        {agents.length === 0 ? (
          <Empty>No Agent yet.</Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Agent</th>
                  <th>Status</th>
                  <th>Last heard from</th>
                  <th>Version</th>
                </tr>
              </thead>
              <tbody>
                {agents.map((a) => {
                  const h = health(a);
                  return (
                    <tr key={a.agent_id}>
                      <td>
                        <code>{shortId(a.agent_id)}</code>
                      </td>
                      <td>
                        <span className={h.tone}>{h.text}</span>
                      </td>
                      <td className="muted">
                        {a.last_heartbeat_at ? relative(a.last_heartbeat_at) : 'never'}
                      </td>
                      <td className="muted">{a.version}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {active.length > 0 && mayRegister ? (
        <details className="more">
          <summary>Connect another Agent</summary>
          {connect}
        </details>
      ) : null}

      {mayRevoke && active.length > 0 ? (
        <details className="more">
          <summary>Disconnect an Agent</summary>
          <p className="faint small" style={{ marginTop: 0 }}>
            At once: the Agent is refused at its next check-in and stops serving, rather than
            carrying on with old instructions.
          </p>
          {active.map((a) => (
            <details key={a.agent_id} style={{ marginBottom: '0.6rem' }}>
              <summary style={{ cursor: 'pointer' }} className="muted">
                Disconnect <code>{shortId(a.agent_id)}</code>
              </summary>
              <div style={{ marginTop: '0.75rem' }}>
                <RevokeAgentForm agentId={a.agent_id} />
              </div>
            </details>
          ))}
        </details>
      ) : null}

      {mayRegister ? (
        <details className="more">
          <summary>Advanced: an Agent with your own configuration file</summary>
          <p className="faint small" style={{ marginTop: 0 }}>
            For teams that run the Agent from a hand-written config against tables they prepare
            themselves (see the integration guide).
          </p>
          <BootstrapTokenForm />
          <div style={{ marginTop: '1rem' }}>
            <RevokeBootstrapTokensForm />
            <div className="field-hint" style={{ marginTop: '0.4rem' }}>
              Cancels every code that has been created but not used.
            </div>
          </div>
        </details>
      ) : null}

      <details className="more">
        <summary>How the Agent proves who it is</summary>
        <ol className="muted" style={{ margin: 0, paddingLeft: '1.15rem' }}>
          <li>The one-time code works once, for 15 minutes, and Oolix keeps only its SHA-256.</li>
          <li>
            The Agent makes a <strong>P-256 key pair on your server</strong> and registers with the
            code and its <em>public</em> key. The private key never leaves your server.
          </li>
          <li>
            From then on it proves it holds that key to get a 15-minute access token. Oolix cannot
            produce a signature that appears to come from your Agent.
          </li>
        </ol>
        <p className="faint small" style={{ marginBottom: 0 }}>
          Which data the Agent reads is chosen on its own setup page, or in its config file — never
          here. Nothing Oolix sends can widen what it reads.
        </p>
      </details>
    </Shell>
  );
}
