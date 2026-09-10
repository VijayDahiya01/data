/**
 * Partner profile, policy and readiness -- spec v5 §6, §37, §41.
 *
 * §37 lays out ten onboarding steps ending at READY_FOR_CAMPAIGNS. Readiness
 * is DERIVED from observable facts rather than set by hand, so a Partner
 * cannot be marked ready while, say, its Agent has never checked in. §87.2
 * makes this a go-live gate: "Each Partner has one live-tested segment and
 * placement."
 */
import { Injectable, Inject } from '@nestjs/common';
import { z } from 'zod';
import { OolixError, type PartnerReadiness } from '@oolix/contracts';
// Prisma 7 names the row type <Model>Model.
import type { PartnerPolicyModel } from '@oolix/db';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AuditService } from '../../common/audit/audit.service.js';

export const PartnerPolicySchema = z.object({
  allowed_categories: z.array(z.string().max(80)).min(1),
  blocked_categories: z.array(z.string().max(80)).default([]),
  /** §41: named competitors this Partner will never carry. */
  blocked_advertisers: z.array(z.string().max(160)).default([]),
  geographies: z.array(z.string().max(80)).min(1),
  prohibited_use: z.array(z.string().max(200)).default([]),
  commercial_policy: z.record(z.string(), z.unknown()).default({}),
});
export type PartnerPolicyInput = z.infer<typeof PartnerPolicySchema>;

export const PartnerProfileSchema = z.object({
  /** §101: default 7-day review window; a Partner may shorten or extend it. */
  approval_sla_days: z.number().int().min(1).max(30).default(7),
  /** §72: a Partner may raise the publishable cohort floor, never lower it. */
  min_publishable_reach: z.number().int().min(1000).default(1000),
});
export type PartnerProfileInput = z.infer<typeof PartnerProfileSchema>;

export interface ReadinessReport {
  readiness: PartnerReadiness;
  checks: Array<{ step: string; complete: boolean; detail: string }>;
  blocking: string[];
}

@Injectable()
export class PartnerProfileService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async upsertProfile(partnerOrgId: string, input: PartnerProfileInput) {
    const profile = await this.prisma.partnerProfile.upsert({
      where: { orgId: partnerOrgId },
      create: {
        orgId: partnerOrgId,
        approvalSlaDays: input.approval_sla_days,
        minPublishableReach: input.min_publishable_reach,
      },
      update: {
        approvalSlaDays: input.approval_sla_days,
        minPublishableReach: input.min_publishable_reach,
      },
    });

    await this.audit.record({
      action: 'PARTNER_PROFILE_UPDATED',
      entityType: 'partner_profile',
      entityId: partnerOrgId,
      orgId: partnerOrgId,
      metadata: {
        approval_sla_days: input.approval_sla_days,
        min_publishable_reach: input.min_publishable_reach,
      },
    });

    await this.refreshReadiness(partnerOrgId);
    return profile;
  }

  /**
   * Publish a new policy version.
   *
   * Policies are versioned and never edited in place: §41 and §83 bind every
   * approval to the exact `policy_version` in force at the time, so editing a
   * policy must not retroactively change what a Partner agreed to.
   */
  async publishPolicy(partnerOrgId: string, input: PartnerPolicyInput) {
    const latest = await this.prisma.partnerPolicy.findFirst({
      where: { partnerOrgId },
      orderBy: { version: 'desc' },
      select: { version: true },
    });
    const version = (latest?.version ?? 0) + 1;

    const policy = await this.prisma.partnerPolicy.create({
      data: {
        partnerOrgId,
        version,
        allowedCategories: input.allowed_categories,
        blockedCategories: input.blocked_categories,
        blockedAdvertisers: input.blocked_advertisers,
        geographies: input.geographies,
        prohibitedUse: input.prohibited_use,
        commercialPolicy: input.commercial_policy as never,
      },
    });

    await this.prisma.partnerProfile.upsert({
      where: { orgId: partnerOrgId },
      create: { orgId: partnerOrgId, activePolicyId: policy.id },
      update: { activePolicyId: policy.id },
    });

    await this.audit.record({
      action: 'PARTNER_POLICY_PUBLISHED',
      entityType: 'partner_policy',
      entityId: policy.id,
      orgId: partnerOrgId,
      metadata: { version, allowed_categories: input.allowed_categories.length },
    });

    await this.refreshReadiness(partnerOrgId);
    return { policy_id: policy.id, version, policy_version: `P-${version}` };
  }

  // Explicit return type: without it TypeScript infers a type that references
  // Prisma's runtime module by relative path, which is not portable across
  // workspace packages.
  async activePolicy(partnerOrgId: string): Promise<PartnerPolicyModel> {
    const policy = await this.prisma.partnerPolicy.findFirst({
      where: { partnerOrgId },
      orderBy: { version: 'desc' },
    });
    if (!policy) throw new OolixError('PART_001', 'Partner has published no policy.');
    return policy;
  }

  /**
   * Evaluate the §37 checklist against observable state.
   *
   * Every check asks "did this actually happen?" rather than "did someone
   * tick a box?" -- an Agent that registered but never sent a heartbeat is
   * not a working integration, and a segment with no freshness timestamp has
   * never successfully materialized.
   */
  async evaluateReadiness(partnerOrgId: string): Promise<ReadinessReport> {
    const [org, profile, policyCount, agent, segments, placements] = await Promise.all([
      this.prisma.organization.findUnique({ where: { id: partnerOrgId } }),
      this.prisma.partnerProfile.findUnique({ where: { orgId: partnerOrgId } }),
      this.prisma.partnerPolicy.count({ where: { partnerOrgId } }),
      this.prisma.agent.findFirst({
        where: { partnerOrgId, status: 'ACTIVE' },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.segment.findMany({
        where: { partnerOrgId },
        select: { id: true, status: true, freshnessAt: true },
      }),
      this.prisma.placement.findMany({
        where: { partnerOrgId },
        select: { id: true, status: true },
      }),
    ]);

    if (!org) throw new OolixError('PART_001', 'Organization not found.');

    const publishedSegments = segments.filter((s) => s.status === 'PUBLISHED' && s.freshnessAt);
    const activePlacements = placements.filter((p) => p.status === 'ACTIVE');

    const checks = [
      {
        step: 'business_verified',
        complete: ['BUSINESS_VERIFIED', 'ROLE_ONBOARDING', 'ACTIVE'].includes(
          org.verificationStatus,
        ),
        detail: `organization verification is ${org.verificationStatus}`,
      },
      {
        step: 'profile',
        complete: Boolean(profile),
        detail: profile ? 'partner profile created' : 'partner profile missing',
      },
      {
        step: 'policy',
        complete: policyCount > 0,
        detail:
          policyCount > 0 ? `${policyCount} policy version(s)` : 'no advertising policy published',
      },
      {
        step: 'agent_registered',
        complete: Boolean(agent),
        detail: agent ? `agent ${agent.id} active` : 'no active Partner Agent',
      },
      {
        step: 'agent_heartbeat',
        // §58 / §78.2: registration alone proves nothing; the Agent must have
        // actually reported in.
        complete: Boolean(agent?.lastHeartbeatAt),
        detail: agent?.lastHeartbeatAt
          ? `last heartbeat ${agent.lastHeartbeatAt.toISOString()}`
          : 'agent has never sent a heartbeat',
      },
      {
        step: 'segment_published',
        complete: publishedSegments.length > 0,
        detail: `${publishedSegments.length} published segment(s) with a freshness timestamp`,
      },
      {
        step: 'placement_active',
        complete: activePlacements.length > 0,
        detail: `${activePlacements.length} active placement(s)`,
      },
    ];

    const blocking = checks.filter((c) => !c.complete).map((c) => c.step);

    let readiness: PartnerReadiness;
    if (org.verificationStatus === 'SUSPENDED') readiness = 'SUSPENDED';
    else if (!checks[0]!.complete || !checks[1]!.complete) readiness = 'PROFILE_INCOMPLETE';
    else if (!checks[2]!.complete) readiness = 'POLICY_PENDING';
    else if (!checks[3]!.complete) readiness = 'AGENT_PENDING';
    else if (!checks[4]!.complete) readiness = 'CONNECTOR_PENDING';
    else if (!checks[5]!.complete) readiness = 'SEGMENTS_PENDING';
    else if (!checks[6]!.complete) readiness = 'PLACEMENTS_PENDING';
    else readiness = 'READY_FOR_CAMPAIGNS';

    return { readiness, checks, blocking };
  }

  /** Recompute and persist readiness after any change that could affect it. */
  async refreshReadiness(partnerOrgId: string): Promise<ReadinessReport> {
    const report = await this.evaluateReadiness(partnerOrgId);

    const existing = await this.prisma.partnerProfile.findUnique({
      where: { orgId: partnerOrgId },
      select: { readinessStatus: true },
    });

    if (existing && existing.readinessStatus !== report.readiness) {
      await this.prisma.partnerProfile.update({
        where: { orgId: partnerOrgId },
        data: { readinessStatus: report.readiness as never },
      });
      await this.audit.record({
        action: 'PARTNER_READINESS_CHANGED',
        entityType: 'partner_profile',
        entityId: partnerOrgId,
        orgId: partnerOrgId,
        metadata: { from: existing.readinessStatus, to: report.readiness },
      });
    }

    return report;
  }
}
