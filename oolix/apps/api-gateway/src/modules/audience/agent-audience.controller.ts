/**
 * The Agent's side of v6 — reach estimation and materialization status.
 *
 * v6 §8.2 puts evaluation inside the Partner: the Agent pulls the rules, runs
 * them against its own attribute source, and posts back a BUCKET. §11 does the
 * same for materialization: the Agent compiles and stores members locally and
 * reports only "status/version/freshness/aggregate outcomes".
 *
 * So both endpoints here are deliberately narrow. Neither has a field that
 * could carry a count or a member, and §92.4 scopes everything to the Agent's
 * own registered Partner — never to an id supplied in the body.
 */
import { Body, Controller, Get, Inject, Post } from '@nestjs/common';
import { z } from 'zod';
import type { AgentPrincipal } from '@oolix/auth-rbac';
import { RequireAgentScope } from '../../common/auth/auth.guard.js';
import { Principal } from '../../common/auth/principal.decorator.js';
import { ZodValidationPipe } from '../../common/validation/zod.pipe.js';
import { AgentAudienceService } from './agent-audience.service.js';
import { AudienceService } from './audience.service.js';
import {
  DataQualityReportSchema,
  PublishCapabilitiesSchema,
  type DataQualityReportInput,
  type PublishCapabilitiesInput,
} from './audience.schema.js';

/**
 * v6 §8.2's return shape.
 *
 * There is no count field, and adding one would be a privacy change rather
 * than a schema change. BELOW_THRESHOLD is how the Agent says "I ran the rule
 * and the cohort is too small to describe" without describing it.
 */
export const ReachEstimateResultSchema = z.object({
  reach_estimate_id: z.string().uuid(),
  status: z.enum(['READY', 'BELOW_THRESHOLD', 'UNAVAILABLE', 'FAILED']),
  reach_bucket: z
    .enum(['UNDER_10K', '10K_50K', '50K_100K', '100K_250K', '250K_500K', '500K_1M', 'OVER_1M'])
    .optional(),
  /** §8.2: ties the answer to the exact rules that were evaluated. */
  audience_rule_hash: z.string().length(64),
  mapping_version: z.number().int().positive().optional(),
  freshness_at: z.string().refine((v) => !Number.isNaN(Date.parse(v)), 'ISO-8601 date-time'),
  failure_reason: z.string().max(500).optional(),
});
export type ReachEstimateResultInput = z.infer<typeof ReachEstimateResultSchema>;

/** v6 §11: status, version and freshness. Never a member. */
export const MaterializationReportSchema = z.object({
  activation_id: z.string().uuid(),
  status: z.enum(['NOT_STARTED', 'BUILDING', 'READY', 'STALE', 'FAILED', 'REMOVED']),
  materialization_version: z.number().int().nonnegative(),
  audience_rule_hash: z.string().length(64).optional(),
  built_at: z
    .string()
    .refine((v) => !Number.isNaN(Date.parse(v)), 'ISO-8601 date-time')
    .optional(),
  last_error: z.string().max(500).optional(),
});
export type MaterializationReportInput = z.infer<typeof MaterializationReportSchema>;

@Controller('agent/v1/audience')
export class AgentAudienceController {
  constructor(
    @Inject(AgentAudienceService) private readonly service: AgentAudienceService,
    @Inject(AudienceService) private readonly audiences: AudienceService,
  ) {}

  /**
   * §8.1: the work queue for this Agent.
   *
   * Scoped entirely by the Agent's registered Partner (§92.4: "never trust a
   * partner_org_id supplied in the body"), so an Agent cannot collect another
   * Partner's estimate requests even with a valid token.
   *
   * The rules travel with the request because the Agent has to compile them —
   * that is the point of v6. What does not travel is anything about people.
   */
  @Get('estimate-requests')
  @RequireAgentScope('config:read')
  async pendingEstimates(@Principal() p: AgentPrincipal) {
    return this.service.pendingEstimates(p.partnerOrgId);
  }

  /**
   * §8.2: the Agent reports what it found, as a bucket.
   *
   * The rule hash is re-checked against the stored request: an Agent reporting
   * a bucket for rules other than the ones it was asked about would otherwise
   * quietly answer a different question.
   */
  @Post('estimate-results')
  @RequireAgentScope('reporting:write')
  async reportEstimate(
    @Principal() p: AgentPrincipal,
    @Body(new ZodValidationPipe(ReachEstimateResultSchema)) body: ReachEstimateResultInput,
  ) {
    return this.service.recordEstimate(p.partnerOrgId, p.agentId, body);
  }

  /**
   * §11: what the Agent has compiled locally, and at which version.
   *
   * Oolix stores this so an operator can see whether an approved audience is
   * actually live at a Partner. It stores nothing about who is in it.
   */
  @Post('materializations')
  @RequireAgentScope('reporting:write')
  async reportMaterialization(
    @Principal() p: AgentPrincipal,
    @Body(new ZodValidationPipe(MaterializationReportSchema)) body: MaterializationReportInput,
  ) {
    return this.service.recordMaterialization(p.partnerOrgId, p.agentId, body);
  }

  /**
   * §5.1, published by the Agent itself (Partner Connect).
   *
   * A managed Agent keeps its own cleaned copy of the Partner's customer
   * table, so after a sync it knows exactly which attributes it can answer. The
   * body is the portal's own capability shape: attribute keys, operators,
   * geographies and channels. Nothing in it can carry a local column name, a
   * value or a customer (§17).
   */
  @Post('capabilities')
  @RequireAgentScope('capabilities:write')
  async publishCapabilities(
    @Principal() p: AgentPrincipal,
    @Body(new ZodValidationPipe(PublishCapabilitiesSchema)) body: PublishCapabilitiesInput,
  ) {
    return this.audiences.publishCapabilitiesFromAgent(p, body);
  }

  /**
   * How complete the Agent's copy is, after a full sync (Partner Connect).
   * Percentages and a size band, for the Partner's own portal -- never a count
   * of anything, and never shown to a Buyer.
   */
  @Post('quality')
  @RequireAgentScope('reporting:write')
  async reportQuality(
    @Principal() p: AgentPrincipal,
    @Body(new ZodValidationPipe(DataQualityReportSchema)) body: DataQualityReportInput,
  ) {
    return this.audiences.recordDataQuality(p, body);
  }
}
