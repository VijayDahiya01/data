/**
 * The exposition format, and the privacy property.
 *
 * Prometheus rejects a malformed scrape wholesale -- one bad line discards
 * every metric in it, including the ones an alert depends on. So the format is
 * asserted rather than eyeballed.
 *
 * The second test is the one that matters more. A metric label is exactly the
 * sort of place a customer identifier ends up by accident, and the control
 * plane holding no such identifier (§54, §73) is the product's central claim.
 */
import { MetricsService } from './metrics.service.js';
import type { PrismaService } from '../../prisma/prisma.service.js';

function serviceWith(overrides: Partial<Record<string, unknown>> = {}): MetricsService {
  const prisma = {
    agent: {
      findMany: async () => [
        {
          id: 'agent-1',
          status: 'ACTIVE',
          partnerOrgId: 'partner-a',
          lastHeartbeatAt: new Date(Date.now() - 90_000),
          configAgeSeconds: 42,
        },
        {
          id: 'agent-2',
          status: 'ACTIVE',
          partnerOrgId: 'partner-b',
          lastHeartbeatAt: null,
          configAgeSeconds: null,
        },
        {
          id: 'agent-3',
          status: 'REVOKED',
          partnerOrgId: 'partner-b',
          lastHeartbeatAt: new Date(),
          configAgeSeconds: 1,
        },
      ],
    },
    $queryRaw: async () => [],
    ...overrides,
  } as unknown as PrismaService;
  return new MetricsService(prisma);
}

describe('MetricsService', () => {
  it('emits HELP and TYPE before every metric it reports', async () => {
    const body = await serviceWith().render();
    const lines = body.split('\n').filter(Boolean);

    const declared = new Set(
      lines.filter((l) => l.startsWith('# TYPE ')).map((l) => l.split(' ')[2]),
    );
    const helped = new Set(
      lines.filter((l) => l.startsWith('# HELP ')).map((l) => l.split(' ')[2]),
    );
    const emitted = new Set(lines.filter((l) => !l.startsWith('#')).map((l) => l.split(/[{ ]/)[0]));

    for (const name of emitted) {
      expect(declared.has(name)).toBe(true);
      expect(helped.has(name)).toBe(true);
    }
    expect(body.endsWith('\n')).toBe(true);
  });

  it('reports heartbeat age per agent, and counts the ones never seen', async () => {
    const body = await serviceWith().render();

    // Per agent, not averaged: one Partner's Agent being down is the alert
    // that matters, and a mean across every Partner hides it entirely.
    expect(body).toMatch(
      /oolix_agent_heartbeat_age_seconds\{agent="agent-1",partner_org="partner-a"\} 9[0-9]/,
    );
    // Never checked in: a stalled onboarding, not an outage. It must not
    // appear as an age of zero, which would read as perfectly healthy.
    expect(body).not.toContain('agent="agent-2"');
    expect(body).toContain('oolix_agents_never_seen 1');
    // A revoked Agent is not "down" and must not page anyone.
    expect(body).not.toContain('agent="agent-3"');
    expect(body).toContain('oolix_agents{status="ACTIVE"} 2');
    expect(body).toContain('oolix_agents{status="REVOKED"} 1');
  });

  it('never emits a per-person label', async () => {
    const body = await serviceWith({
      $queryRaw: async () => [{ status: 'LIVE', count: 3, oldest: new Date() }],
    }).render();

    // The control plane holds no customer identifier at all (§54, §73). If one
    // ever reaches a metric label, it reaches every scrape, every dashboard and
    // every long-term store that collects them.
    for (const forbidden of ['partner_user_id', 'user_id', 'customer', 'email', 'msisdn']) {
      expect(body.toLowerCase()).not.toContain(forbidden);
    }
  });

  it('escapes a label value rather than emitting a scrape Prometheus rejects', async () => {
    const body = await serviceWith({
      agent: {
        findMany: async () => [
          {
            id: 'a"b',
            status: 'ACTIVE',
            partnerOrgId: 'p\nq',
            lastHeartbeatAt: new Date(Date.now() - 1000),
            configAgeSeconds: 1,
          },
        ],
      },
    }).render();

    expect(body).toContain('agent="a\\"b"');
    expect(body).toContain('partner_org="p\\nq"');
    // A raw newline inside a label would split the line and invalidate the
    // whole scrape.
    const metricLines = body.split('\n').filter((l) => l && !l.startsWith('#'));
    for (const line of metricLines) expect(line).toMatch(/ -?[0-9]+(\.[0-9]+)?$/);
  });
});
