/**
 * Scheduled monitors (§55, §58, §78.2, §81, §99, §101).
 *
 * Each of these jobs acts on the ABSENCE of an event -- a heartbeat that
 * stopped, a decision nobody made, a record whose retention ran out. Nothing
 * publishes a message when nothing happens, so if one of these silently stops
 * working there is no other signal. That is what makes them worth pinning.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  JOBS,
  checkAgentHealth,
  expirePartnerRequests,
  startSchedulers,
  sweepExpiredTokens,
  sweepIdempotency,
  type SchedulerDeps,
} from './index.js';

function fakeLogger() {
  const entries: Array<{ level: string; event: unknown }> = [];
  const record = (level: string) => (_msg: string, meta?: Record<string, unknown>) =>
    entries.push({ level, event: meta?.event });
  return {
    entries,
    logger: {
      debug: record('debug'),
      info: record('info'),
      warn: record('warn'),
      error: record('error'),
    },
  };
}

const events = (entries: Array<{ level: string; event: unknown }>) => entries.map((e) => e.event);

const deps = (prisma: unknown, logger: unknown) => ({ prisma, logger }) as unknown as SchedulerDeps;

describe('checkAgentHealth (§58, §78.2)', () => {
  const agent = (over: Record<string, unknown>) => ({
    id: 'agent-1',
    partnerOrgId: 'org-1',
    lastHeartbeatAt: new Date(),
    configAgeSeconds: 0,
    version: '1.0.0',
    ...over,
  });

  const run = async (agents: unknown[]) => {
    const { entries, logger } = fakeLogger();
    const prisma = { agent: { findMany: vi.fn().mockResolvedValue(agents) } };
    await checkAgentHealth(deps(prisma, logger));
    return { entries, prisma };
  };

  it('stays quiet when the Agent is healthy', async () => {
    const { entries } = await run([agent({})]);
    expect(entries).toEqual([]);
  });

  it('warns rather than pages when an Agent has never checked in (§37)', async () => {
    // Registered but never seen is an onboarding state, not an outage --
    // Partner readiness already blocks campaigns for it.
    const { entries } = await run([agent({ lastHeartbeatAt: null })]);
    expect(events(entries)).toEqual(['AGENT_NEVER_SEEN']);
    expect(entries[0]!.level).toBe('warn');
  });

  it('raises an error once the heartbeat passes 5 minutes (§78.2)', async () => {
    const { entries } = await run([agent({ lastHeartbeatAt: new Date(Date.now() - 301_000) })]);
    expect(events(entries)).toContain('AGENT_HEARTBEAT_STALE');
    expect(entries[0]!.level).toBe('error');
  });

  it('does not fire one second before the threshold', async () => {
    const { entries } = await run([agent({ lastHeartbeatAt: new Date(Date.now() - 299_000) })]);
    expect(events(entries)).toEqual([]);
  });

  it('escalates config staleness from warning to critical (§75, §78.2)', async () => {
    // §75 lets an Agent keep serving from cache inside the stale grace, so 5
    // minutes is a warning; past 15 it must not start anything new, which is
    // an incident.
    const warn = await run([agent({ configAgeSeconds: 301 })]);
    expect(events(warn.entries)).toEqual(['AGENT_CONFIG_STALE']);
    expect(warn.entries[0]!.level).toBe('warn');

    const critical = await run([agent({ configAgeSeconds: 901 })]);
    expect(events(critical.entries)).toEqual(['AGENT_CONFIG_CRITICAL']);
    expect(critical.entries[0]!.level).toBe('error');
  });

  it('only looks at ACTIVE Agents', async () => {
    // A revoked Agent (§69.3) is expected to stop sending heartbeats; alerting
    // on it would train operators to ignore the alert.
    const { prisma } = await run([]);
    expect(prisma.agent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { status: 'ACTIVE' } }),
    );
  });
});

describe('sweepIdempotency (§99)', () => {
  it('removes only expired records', async () => {
    const deleteMany = vi.fn().mockResolvedValue({ count: 3 });
    const { entries, logger } = fakeLogger();
    await sweepIdempotency(deps({ idempotencyRecord: { deleteMany } }, logger));

    const where = deleteMany.mock.calls[0]![0].where;
    expect(where.expiresAt.lte).toBeInstanceOf(Date);
    expect(events(entries)).toEqual(['IDEMPOTENCY_SWEEP']);
  });

  it('says nothing when there was nothing to sweep', async () => {
    const { entries, logger } = fakeLogger();
    await sweepIdempotency(
      deps({ idempotencyRecord: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) } }, logger),
    );
    expect(entries).toEqual([]);
  });
});

describe('sweepExpiredTokens (§81)', () => {
  it('never deletes a token that produced a lead', async () => {
    // §50 requires settlement to stay reproducible from immutable inputs, so a
    // redeemed token is evidence, not garbage.
    const deleteMany = vi.fn().mockResolvedValue({ count: 2 });
    const { logger } = fakeLogger();
    await sweepExpiredTokens(deps({ attributionToken: { deleteMany } }, logger));

    expect(deleteMany.mock.calls[0]![0].where.leadState).toBe('UNREDEEMED');
  });
});

describe('expirePartnerRequests (§101)', () => {
  it('expires only requests still awaiting a decision', async () => {
    const findMany = vi.fn().mockResolvedValue([{ id: 'req-1', partnerOrgId: 'org-1' }]);
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const { entries, logger } = fakeLogger();

    await expirePartnerRequests(deps({ partnerRequest: { findMany, updateMany } }, logger));

    expect(findMany.mock.calls[0]![0].where.status).toBe('PARTNER_REVIEW');
    // The status filter is repeated on the write: a Partner who decides
    // between the read and the update must win, not be overwritten.
    expect(updateMany.mock.calls[0]![0].where.status).toBe('PARTNER_REVIEW');
    expect(updateMany.mock.calls[0]![0].data.status).toBe('EXPIRED');
    expect(events(entries)).toEqual(['PARTNER_REQUEST_EXPIRED']);
  });

  it('never turns silence into approval or rejection (§101)', async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const { logger } = fakeLogger();
    await expirePartnerRequests(
      deps(
        {
          partnerRequest: {
            findMany: vi.fn().mockResolvedValue([{ id: 'req-1', partnerOrgId: 'org-1' }]),
            updateMany,
          },
        },
        logger,
      ),
    );

    const status = updateMany.mock.calls[0]![0].data.status;
    expect(status).not.toBe('APPROVED');
    expect(status).not.toBe('REJECTED');
  });

  it('does not write at all when nothing is due', async () => {
    const updateMany = vi.fn();
    const { logger } = fakeLogger();
    await expirePartnerRequests(
      deps({ partnerRequest: { findMany: vi.fn().mockResolvedValue([]), updateMany } }, logger),
    );
    expect(updateMany).not.toHaveBeenCalled();
  });
});

describe('startSchedulers', () => {
  const fakePrisma = () => ({
    agent: { findMany: vi.fn().mockResolvedValue([]) },
    idempotencyRecord: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
    attributionToken: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
    partnerRequest: { findMany: vi.fn().mockResolvedValue([]), updateMany: vi.fn() },
  });

  it('keeps running when one job throws', async () => {
    // A single failing monitor must not silence the other three.
    const { entries, logger } = fakeLogger();
    const prisma = fakePrisma();
    prisma.agent.findMany = vi.fn().mockRejectedValue(new Error('db down'));

    const stop = startSchedulers(deps(prisma, logger));
    await new Promise((r) => setImmediate(r));
    stop();

    expect(events(entries)).toContain('SCHEDULER_JOB_FAILED');
    expect(prisma.idempotencyRecord.deleteMany).toHaveBeenCalled();
    expect(prisma.partnerRequest.findMany).toHaveBeenCalled();
  });

  it('runs each job immediately rather than waiting a full interval', async () => {
    // The longest interval is an hour; waiting for the first tick would leave
    // an hour of blindness after every deploy.
    const { logger } = fakeLogger();
    const prisma = fakePrisma();

    const stop = startSchedulers(deps(prisma, logger));
    await new Promise((r) => setImmediate(r));
    stop();

    expect(prisma.agent.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.attributionToken.deleteMany).toHaveBeenCalledTimes(1);
  });

  it('returns a stop function and does not hold the process open (§80)', () => {
    const { logger } = fakeLogger();
    const stop = startSchedulers(deps(fakePrisma(), logger));
    expect(typeof stop).toBe('function');
    stop();
  });

  it('schedules every job it defines', () => {
    expect(JOBS.map((j) => j.name)).toEqual([
      'agent-health',
      'idempotency-sweep',
      'attribution-token-sweep',
      'partner-request-expiry',
    ]);
    for (const job of JOBS) expect(job.intervalMs).toBeGreaterThan(0);
  });
});
