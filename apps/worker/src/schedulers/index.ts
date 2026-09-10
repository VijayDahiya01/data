/**
 * Scheduled monitors -- spec v5 §55, §58, §78.2, §99, §101.
 *
 * These evaluate conditions the queue cannot: staleness, expiry and retention
 * are all "nothing happened" events, and nothing publishes a message when
 * nothing happens.
 */
import type { PrismaClient } from '@oolix/db';
import type { OolixLogger } from '@oolix/observability';
import { METRICS } from '@oolix/observability';

export interface SchedulerDeps {
  prisma: PrismaClient;
  logger: OolixLogger;
}

/** §78.2: alert when an Agent heartbeat is older than 5 minutes. */
const HEARTBEAT_STALE_SECONDS = 300;

/** §78.2: control sync warning at 5 minutes, critical at 15. */
const CONFIG_STALE_SECONDS = 300;
const CONFIG_CRITICAL_SECONDS = 900;

/**
 * §58 / §78.2: Partner Agent health.
 *
 * A stale heartbeat is the earliest signal that a Partner's owned-media path
 * has stopped working. It does not stop serving by itself -- §75 lets an Agent
 * keep serving a cached manifest inside the stale grace window -- but it does
 * mean Oolix can no longer confirm what is running.
 */
export async function checkAgentHealth({ prisma, logger }: SchedulerDeps): Promise<void> {
  const agents = await prisma.agent.findMany({
    where: { status: 'ACTIVE' },
    select: {
      id: true,
      partnerOrgId: true,
      lastHeartbeatAt: true,
      configAgeSeconds: true,
      version: true,
    },
  });

  const now = Date.now();

  for (const agent of agents) {
    const heartbeatAgeSeconds = agent.lastHeartbeatAt
      ? Math.round((now - agent.lastHeartbeatAt.getTime()) / 1000)
      : null;

    if (heartbeatAgeSeconds === null) {
      // Registered but never checked in. Partner readiness already treats this
      // as incomplete (§37), so log at warn rather than paging.
      logger.warn('agent has never sent a heartbeat', {
        event: 'AGENT_NEVER_SEEN',
        entity_type: 'agent',
        entity_id: agent.id,
        org_id: agent.partnerOrgId,
        metric: METRICS.agentHeartbeatAgeSeconds,
      });
      continue;
    }

    if (heartbeatAgeSeconds > HEARTBEAT_STALE_SECONDS) {
      logger.error('agent heartbeat is stale', {
        event: 'AGENT_HEARTBEAT_STALE',
        entity_type: 'agent',
        entity_id: agent.id,
        org_id: agent.partnerOrgId,
        metric: METRICS.agentHeartbeatAgeSeconds,
        heartbeat_age_seconds: heartbeatAgeSeconds,
        threshold_seconds: HEARTBEAT_STALE_SECONDS,
      });
    }

    const configAge = agent.configAgeSeconds ?? 0;
    if (configAge > CONFIG_CRITICAL_SECONDS) {
      // §75: past the stale grace the Agent must not start anything new.
      logger.error('agent control sync critically stale', {
        event: 'AGENT_CONFIG_CRITICAL',
        entity_type: 'agent',
        entity_id: agent.id,
        org_id: agent.partnerOrgId,
        metric: METRICS.agentConfigAgeSeconds,
        config_age_seconds: configAge,
      });
    } else if (configAge > CONFIG_STALE_SECONDS) {
      logger.warn('agent control sync lagging', {
        event: 'AGENT_CONFIG_STALE',
        entity_type: 'agent',
        entity_id: agent.id,
        org_id: agent.partnerOrgId,
        metric: METRICS.agentConfigAgeSeconds,
        config_age_seconds: configAge,
      });
    }
  }
}

/** §99: idempotency records expire after 24h (longer for financial writes). */
export async function sweepIdempotency({ prisma, logger }: SchedulerDeps): Promise<void> {
  const { count } = await prisma.idempotencyRecord.deleteMany({
    where: { expiresAt: { lte: new Date() } },
  });
  if (count > 0) {
    logger.info('swept expired idempotency records', {
      event: 'IDEMPOTENCY_SWEEP',
      removed: count,
    });
  }
}

/**
 * §81: click token records are retained 7 days active.
 *
 * Only UNREDEEMED tokens are removed. A token that produced a lead is part of
 * the settlement evidence chain (§50: "Every financial calculation should be
 * reproducible from immutable settlement inputs") and is retained under the
 * campaign/finance audit rule instead.
 */
export async function sweepExpiredTokens({ prisma, logger }: SchedulerDeps): Promise<void> {
  const { count } = await prisma.attributionToken.deleteMany({
    where: { expiresAt: { lte: new Date() }, leadState: 'UNREDEEMED' },
  });
  if (count > 0) {
    logger.info('swept expired unredeemed attribution tokens', {
      event: 'ATTRIBUTION_TOKEN_SWEEP',
      removed: count,
    });
  }
}

/**
 * §101: a Partner request left un-decided for its SLA window becomes EXPIRED.
 *
 * §101 is emphatic that this is "not rejection and never auto-approves" -- the
 * Buyer may clone and resubmit, and the Partner's silence is recorded as
 * silence.
 */
export async function expirePartnerRequests({ prisma, logger }: SchedulerDeps): Promise<void> {
  const due = await prisma.partnerRequest.findMany({
    where: { status: 'PARTNER_REVIEW', expiresAt: { lte: new Date() } },
    select: { id: true, partnerOrgId: true },
  });

  if (due.length === 0) return;

  const { count } = await prisma.partnerRequest.updateMany({
    where: { id: { in: due.map((r) => r.id) }, status: 'PARTNER_REVIEW' },
    data: { status: 'EXPIRED' },
  });

  logger.info('partner requests expired without a decision', {
    event: 'PARTNER_REQUEST_EXPIRED',
    count,
    note: 'Expiry is neither approval nor rejection (spec §101).',
  });
}

export interface Job {
  name: string;
  intervalMs: number;
  run: (deps: SchedulerDeps) => Promise<void>;
}

export const JOBS: Job[] = [
  { name: 'agent-health', intervalMs: 60_000, run: checkAgentHealth },
  { name: 'idempotency-sweep', intervalMs: 15 * 60_000, run: sweepIdempotency },
  { name: 'attribution-token-sweep', intervalMs: 60 * 60_000, run: sweepExpiredTokens },
  { name: 'partner-request-expiry', intervalMs: 15 * 60_000, run: expirePartnerRequests },
];

/** Start every scheduled job. Returns a function that stops them all. */
export function startSchedulers(deps: SchedulerDeps): () => void {
  const timers = JOBS.map((job) => {
    const tick = async () => {
      try {
        await job.run(deps);
      } catch (err) {
        // One failing job must never stop the others.
        deps.logger.error('scheduled job failed', {
          event: 'SCHEDULER_JOB_FAILED',
          job: job.name,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), job.intervalMs);
    // Do not hold the process open on this timer alone.
    timer.unref?.();
    return timer;
  });

  deps.logger.info('schedulers started', {
    event: 'SCHEDULERS_START',
    jobs: JOBS.map((j) => `${j.name}@${j.intervalMs / 1000}s`),
  });

  return () => timers.forEach((t) => clearInterval(t));
}
