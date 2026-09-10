/**
 * Reporting endpoints -- spec v5 §49, §52.4, §52.5.
 */
import { Body, Controller, Get, Inject, Param, Post, Query } from '@nestjs/common';
import type { AgentPrincipal, UserPrincipal } from '@oolix/auth-rbac';
import { RequireAgentScope, RequirePermissions } from '../../common/auth/auth.guard.js';
import { Principal } from '../../common/auth/principal.decorator.js';
import { ZodValidationPipe } from '../../common/validation/zod.pipe.js';
import { Idempotent } from '../../common/idempotency/idempotency.interceptor.js';
import {
  ReportingService,
  DeliveryBatchSchema,
  type DeliveryBatchInput,
} from './reporting.service.js';

/** Agent-facing delivery ingest (§52.4). */
@Controller('agent/v1/reporting')
export class AgentReportingController {
  constructor(@Inject(ReportingService) private readonly reporting: ReportingService) {}

  @Post('batches')
  @RequireAgentScope('reporting:write')
  // Belt and braces: the service already dedupes on (partner, batch_id), but
  // §53 lists report batches explicitly and a second guard costs nothing.
  @Idempotent()
  async ingest(
    @Principal() p: AgentPrincipal,
    @Body(new ZodValidationPipe(DeliveryBatchSchema)) body: DeliveryBatchInput,
  ) {
    return this.reporting.ingestBatch(p.partnerOrgId, p.agentId, body);
  }
}

/** Buyer, Partner and Ops reporting (§49, §52.5). */
@Controller('v1/reports')
export class ReportsController {
  constructor(@Inject(ReportingService) private readonly reporting: ReportingService) {}

  @Get('campaigns/:id')
  @RequirePermissions('report:read')
  async campaign(@Principal() p: UserPrincipal, @Param('id') id: string) {
    return this.reporting.campaignReport(p.orgId, id);
  }

  /**
   * §67: the Partner's own report, scoped to the authenticated organization.
   * There is deliberately no path parameter that could address another
   * Partner's data.
   */
  @Get('partner')
  @RequirePermissions('report:read')
  async partner(@Principal() p: UserPrincipal) {
    return this.reporting.partnerReport(p.orgId);
  }

  /** §77.3 reconciliation, run on demand by Partner Finance or Oolix Ops. */
  @Post('reconcile/:activationId')
  @RequirePermissions('reconciliation:manage')
  async reconcile(
    @Param('activationId') activationId: string,
    @Query('date') date: string | undefined,
    @Body() body: { agent_count?: number },
  ) {
    return this.reporting.reconcile(
      activationId,
      date ? new Date(date) : new Date(),
      BigInt(body?.agent_count ?? 0),
    );
  }
}
