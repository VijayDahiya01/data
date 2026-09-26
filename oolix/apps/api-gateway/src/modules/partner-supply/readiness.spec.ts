/**
 * §37 readiness, with audience supply from either path.
 *
 * A Partner connected through Partner Connect publishes capabilities and no
 * prebuilt segment. Before this was pinned, readiness demanded a segment, so
 * such a Partner could never become ready for campaigns however well its
 * Agent was working.
 */
import { PartnerProfileService } from './partner-profile.service.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { AuditService } from '../../common/audit/audit.service.js';

function serviceWith(opts: {
  segments?: Array<{ id: string; status: string; freshnessAt: Date | null }>;
  capability?: { capabilityVersion: number; attributesJson: unknown } | null;
}) {
  const prisma = {
    organization: {
      findUnique: async () => ({ id: 'p1', verificationStatus: 'BUSINESS_VERIFIED' }),
    },
    partnerProfile: { findUnique: async () => ({ orgId: 'p1' }) },
    partnerPolicy: { count: async () => 1 },
    agent: { findFirst: async () => ({ id: 'a1', lastHeartbeatAt: new Date() }) },
    segment: { findMany: async () => opts.segments ?? [] },
    placement: { findMany: async () => [{ id: 'pl1', status: 'ACTIVE' }] },
    partnerCapability: { findFirst: async () => opts.capability ?? null },
  } as unknown as PrismaService;
  return new PartnerProfileService(prisma, {} as AuditService);
}

const step = (report: { checks: { step: string; complete: boolean }[] }) =>
  report.checks.find((c) => c.step === 'audience_published');

describe('PartnerProfileService.evaluateReadiness', () => {
  it('is ready with published capabilities and no segment', async () => {
    const report = await serviceWith({
      capability: {
        capabilityVersion: 1,
        attributesJson: [{ attribute_key: 'age', operators: ['BETWEEN'], status: 'AVAILABLE' }],
      },
    }).evaluateReadiness('p1');
    expect(step(report)?.complete).toBe(true);
    expect(report.readiness).toBe('READY_FOR_CAMPAIGNS');
  });

  it('is still ready with a published segment and no capabilities', async () => {
    const report = await serviceWith({
      segments: [{ id: 's1', status: 'PUBLISHED', freshnessAt: new Date() }],
    }).evaluateReadiness('p1');
    expect(report.readiness).toBe('READY_FOR_CAMPAIGNS');
  });

  it('does not count attributes the Partner withdrew', async () => {
    const report = await serviceWith({
      capability: {
        capabilityVersion: 2,
        attributesJson: [{ attribute_key: 'age', operators: ['BETWEEN'], status: 'UNAVAILABLE' }],
      },
    }).evaluateReadiness('p1');
    expect(step(report)?.complete).toBe(false);
    expect(report.readiness).toBe('SEGMENTS_PENDING');
    expect(report.blocking).toContain('audience_published');
  });
});
