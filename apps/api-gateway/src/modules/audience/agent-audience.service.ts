/**
 * Agent-facing audience operations — v6 §8.2, §11.
 *
 * Everything here is scoped by the Agent's REGISTERED Partner, taken from the
 * authenticated principal. §92.4: "never trust a partner_org_id supplied in the
 * body." Without that, a valid token for one Partner could be used to collect
 * another Partner's work or report results against their activations.
 */
import { Inject, Injectable } from '@nestjs/common';
import {
  OolixError,
  REACH_ESTIMATE_TTL_HOURS,
  type AudienceRule,
  type ReachBucket,
} from '@oolix/contracts';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AuditService } from '../../common/audit/audit.service.js';
import { BUCKET_TO_DB } from '../../common/reach.js';
import type {
  MaterializationReportInput,
  ReachEstimateResultInput,
} from './agent-audience.controller.js';

/** How long an Agent may sit on a claimed request before it is offered again. */
const CLAIM_TIMEOUT_MINUTES = 10;

@Injectable()
export class AgentAudienceService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  /**
   * §8.1: estimate requests waiting for this Partner's Agent.
   *
   * A PROCESSING request whose claim has gone stale is offered again — an Agent
   * that crashed mid-evaluation would otherwise leave the Buyer waiting
   * forever on a request nobody will pick up.
   */
  async pendingEstimates(partnerOrgId: string) {
    const staleClaimBefore = new Date(Date.now() - CLAIM_TIMEOUT_MINUTES * 60_000);

    const rows = await this.prisma.reachEstimate.findMany({
      where: {
        partnerOrgId,
        OR: [
          { status: 'REQUESTED' },
          { status: 'PROCESSING', requestedAt: { lt: staleClaimBefore } },
        ],
      },
      include: { audienceVersionRef: true },
      orderBy: { requestedAt: 'asc' },
      take: 20,
    });

    if (rows.length === 0) return { items: [] };

    // Claim them so two Agent replicas do not evaluate the same request twice.
    await this.prisma.reachEstimate.updateMany({
      where: { id: { in: rows.map((r) => r.id) } },
      data: { status: 'PROCESSING' },
    });

    return {
      items: rows.map((r) => ({
        reach_estimate_id: r.id,
        audience_group_id: r.audienceGroupId,
        audience_version: r.audienceVersion,
        // §10: the Agent recomputes this from the rules and refuses if it
        // disagrees. Sending it means the Agent never has to trust the
        // transport.
        audience_rule_hash: r.ruleHash,
        rules: (r.audienceVersionRef?.rulesJson ?? []) as unknown as AudienceRule[],
        requested_at: r.requestedAt.toISOString(),
      })),
    };
  }

  /**
   * §8.2: record the bucket the Agent computed.
   *
   * The count that produced it was discarded inside the Partner. This method
   * has no parameter that could carry one.
   */
  async recordEstimate(partnerOrgId: string, agentId: string, input: ReachEstimateResultInput) {
    const estimate = await this.prisma.reachEstimate.findFirst({
      where: { id: input.reach_estimate_id, partnerOrgId },
    });
    if (!estimate) {
      // §92.4 in practice: an Agent reporting against another Partner's
      // estimate gets the same answer as one reporting against nothing.
      throw new OolixError('PART_001', 'Reach estimate not found for this Partner.');
    }

    // An Agent answering about rules other than the ones it was asked about
    // would be answering a different question. Refuse rather than store it.
    if (input.audience_rule_hash !== estimate.ruleHash) {
      throw new OolixError(
        'VAL_001',
        'The reported rule hash does not match the rules this estimate was requested for.',
        { fieldErrors: [{ field: 'audience_rule_hash', message: 'does not match the request' }] },
      );
    }

    // §8: an estimate describes a population that moves, so it expires.
    const expiresAt = new Date(Date.now() + REACH_ESTIMATE_TTL_HOURS * 3_600_000);

    const updated = await this.prisma.reachEstimate.update({
      where: { id: estimate.id },
      data: {
        status: input.status as never,
        // Only a READY estimate carries a bucket. BELOW_THRESHOLD deliberately
        // does not: "fewer than the minimum cohort" is itself a disclosure
        // (§17), and UNAVAILABLE/FAILED never ran to completion.
        reachBucket:
          input.status === 'READY' && input.reach_bucket
            ? (BUCKET_TO_DB[input.reach_bucket as ReachBucket] as never)
            : null,
        mappingVersion: input.mapping_version ?? null,
        freshnessAt: new Date(input.freshness_at),
        expiresAt: input.status === 'READY' ? expiresAt : null,
        failureReason: input.failure_reason ?? null,
        completedAt: new Date(),
      },
    });

    await this.audit.record({
      action: 'REACH_ESTIMATE_REPORTED',
      entityType: 'reach_estimate',
      entityId: estimate.id,
      orgId: partnerOrgId,
      actorType: 'AGENT',
      actor: agentId,
      metadata: {
        status: input.status,
        // The bucket is safe to audit; there was never a count to omit.
        reach_bucket: input.reach_bucket ?? null,
        audience_version: estimate.audienceVersion,
        mapping_version: input.mapping_version ?? null,
      },
    });

    return {
      reach_estimate_id: updated.id,
      status: updated.status,
      expires_at: updated.expiresAt?.toISOString() ?? null,
    };
  }

  /**
   * §11: record that an approved audience has been compiled locally.
   *
   * Stored on the activation so an operator can answer "is this actually live
   * at the Partner" without being able to answer "who is in it".
   */
  async recordMaterialization(
    partnerOrgId: string,
    agentId: string,
    input: MaterializationReportInput,
  ) {
    const activation = await this.prisma.activation.findFirst({
      where: { id: input.activation_id, request: { partnerOrgId } },
      include: { request: true },
    });
    if (!activation) {
      throw new OolixError('PART_001', 'Activation not found for this Partner.');
    }

    // §10: the Agent should be materializing the rules the Partner approved. A
    // hash that disagrees means it compiled something else, which is worth
    // recording as a failure rather than accepting as progress.
    const approvedHash = activation.request.audienceRuleHash;
    if (input.audience_rule_hash && approvedHash && input.audience_rule_hash !== approvedHash) {
      await this.audit.record({
        action: 'MATERIALIZATION_HASH_MISMATCH',
        entityType: 'activation',
        entityId: activation.id,
        orgId: partnerOrgId,
        actorType: 'AGENT',
        actor: agentId,
        metadata: { reported: input.audience_rule_hash, approved: approvedHash },
      });

      throw new OolixError(
        'VAL_001',
        'The materialized rule hash does not match what this Partner approved.',
      );
    }

    await this.prisma.activation.update({
      where: { id: activation.id },
      data: {
        // §11 lets Oolix keep "status/version/freshness" and nothing else, so
        // these three are stored for §18.2's Activation page. There is no
        // member-count field to store, and adding one would be a privacy
        // change rather than a schema change.
        materializationStatus: input.status,
        materializationVersion: input.materialization_version,
        materializedAt: input.built_at ? new Date(input.built_at) : new Date(),

        // §11's local states map onto the activation the Buyer sees: an
        // audience that failed to build is an activation that cannot serve.
        ...(input.status === 'FAILED'
          ? {
              status: 'FAILED' as never,
              statusReason: input.last_error ?? 'materialization failed',
            }
          : {}),
        ...(input.status === 'READY' && activation.status === 'SYNCING'
          ? { status: 'READY' as never, statusReason: null }
          : {}),
      },
    });

    await this.audit.record({
      action: 'AUDIENCE_MATERIALIZATION_REPORTED',
      entityType: 'activation',
      entityId: activation.id,
      orgId: partnerOrgId,
      actorType: 'AGENT',
      actor: agentId,
      metadata: {
        status: input.status,
        materialization_version: input.materialization_version,
        built_at: input.built_at ?? null,
      },
    });

    return { activation_id: activation.id, recorded: true };
  }
}
