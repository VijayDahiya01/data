/**
 * Prometheus exposition of the §78.2 signals.
 *
 * `packages/observability` already named these metrics and the worker already
 * logs against them -- but nothing ever exposed them for scraping, so the
 * thresholds existed only as log lines nobody was watching. A threshold with
 * no collector behind it is documentation, not monitoring.
 *
 * Everything here is derived from the control plane's own database on each
 * scrape. That is deliberate: it needs no in-process counters to be correct
 * after a restart, and an API replica that has just started reports the same
 * numbers as one that has been up for a week.
 *
 * NOTHING HERE IS PER-PERSON. These are counts of agents, campaigns and
 * approvals. There is no customer in the control plane to count (§54, §73),
 * and a metric label is exactly the sort of place a partner_user_id would
 * accidentally end up.
 */
import { Injectable, Inject } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';

interface StatusCount {
  status: string;
  count: number;
  oldest?: Date | null;
}

interface Sample {
  name: string;
  help: string;
  type: 'gauge' | 'counter';
  values: Array<{ labels?: Record<string, string>; value: number }>;
}

@Injectable()
export class MetricsService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async render(): Promise<string> {
    const samples = await this.collect();
    const lines: string[] = [];

    for (const s of samples) {
      lines.push(`# HELP ${s.name} ${s.help}`);
      lines.push(`# TYPE ${s.name} ${s.type}`);
      for (const v of s.values) {
        lines.push(`${s.name}${formatLabels(v.labels)} ${v.value}`);
      }
    }
    // Prometheus requires a trailing newline.
    return lines.join('\n') + '\n';
  }

  private async collect(): Promise<Sample[]> {
    const now = Date.now();

    const [agents, activations, approvals] = await Promise.all([
      this.prisma.agent.findMany({
        select: {
          id: true,
          status: true,
          partnerOrgId: true,
          lastHeartbeatAt: true,
          configAgeSeconds: true,
        },
      }),
      // Plain SQL rather than groupBy. An aggregate over a handful of rows
      // does not need the query builder, and the builder's shape for grouped
      // aggregates with a nullable _min is awkward enough that two casts were
      // needed just to satisfy the compiler -- casts that would have hidden a
      // renamed column instead of failing on it.
      this.prisma.$queryRaw<StatusCount[]>`
        SELECT status::text AS status, count(*)::int AS count
        FROM activations GROUP BY status`,
      // §101: the Partner's review window. `submitted_at`, not `created_at` --
      // the clock a Partner is held to starts when the request reaches them,
      // not when the Buyer began drafting it.
      this.prisma.$queryRaw<StatusCount[]>`
        SELECT status::text AS status, count(*)::int AS count,
               min(submitted_at) AS oldest
        FROM partner_requests GROUP BY status`,
    ]);

    type AgentRow = (typeof agents)[number];
    const active: AgentRow[] = agents.filter((a: AgentRow) => a.status === 'ACTIVE');

    // Per-agent, because "one Partner's Agent is down" is the alert that
    // matters and an average across every Partner hides it completely.
    const heartbeatAge = active
      .filter((a: AgentRow) => a.lastHeartbeatAt !== null)
      .map((a: AgentRow) => ({
        labels: { agent: a.id, partner_org: a.partnerOrgId },
        value: Math.round((now - a.lastHeartbeatAt!.getTime()) / 1000),
      }));

    const configAge = active
      .filter((a: AgentRow) => a.configAgeSeconds !== null && a.configAgeSeconds !== undefined)
      .map((a: AgentRow) => ({
        labels: { agent: a.id, partner_org: a.partnerOrgId },
        value: Number(a.configAgeSeconds),
      }));

    const byStatus = new Map<string, number>();
    for (const a of agents as AgentRow[]) byStatus.set(a.status, (byStatus.get(a.status) ?? 0) + 1);

    // An Agent that registered and never checked in is a stalled onboarding,
    // not an outage -- a different number, and a different response.
    const neverSeen = active.filter((a: AgentRow) => a.lastHeartbeatAt === null).length;

    const samples: Sample[] = [
      {
        name: 'oolix_agent_heartbeat_age_seconds',
        help: 'Seconds since this Agent last checked in. Serving stops when it exceeds the stale grace.',
        type: 'gauge',
        values: heartbeatAge,
      },
      {
        name: 'oolix_agent_config_age_seconds',
        help: 'Age of the control config this Agent is serving from (§25).',
        type: 'gauge',
        values: configAge,
      },
      {
        name: 'oolix_agents',
        help: 'Registered Agents by status.',
        type: 'gauge',
        values: [...byStatus].map(([status, value]) => ({ labels: { status }, value })),
      },
      {
        name: 'oolix_agents_never_seen',
        help: 'Active Agents that have never sent a heartbeat: onboarding that stalled.',
        type: 'gauge',
        values: [{ value: neverSeen }],
      },
      {
        name: 'oolix_activations',
        help: 'Activations by status.',
        type: 'gauge',
        values: activations.map((a) => ({ labels: { status: a.status }, value: a.count })),
      },
      {
        name: 'oolix_partner_requests',
        help: 'Partner requests by status: what is waiting on a Partner decision.',
        type: 'gauge',
        values: approvals.map((a) => ({ labels: { status: a.status }, value: a.count })),
      },
    ];

    // How long the oldest Partner decision has been outstanding. The approval
    // SLA is a commercial commitment (§87), so it needs a number rather than
    // an impression.
    const waiting = approvals.find((a) => a.status === 'PARTNER_REVIEW');
    const oldest = waiting?.oldest;
    samples.push({
      name: 'oolix_partner_review_oldest_seconds',
      help: 'Age of the longest-waiting campaign request in PARTNER_REVIEW.',
      type: 'gauge',
      values: [{ value: oldest ? Math.round((now - oldest.getTime()) / 1000) : 0 }],
    });

    return samples;
  }
}

function formatLabels(labels?: Record<string, string>): string {
  if (!labels || Object.keys(labels).length === 0) return '';
  const parts = Object.entries(labels).map(([k, v]) => `${k}="${escapeLabel(v)}"`);
  return `{${parts.join(',')}}`;
}

// A label value containing a quote or newline produces a file Prometheus
// rejects wholesale -- one bad value discards the entire scrape.
function escapeLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}
