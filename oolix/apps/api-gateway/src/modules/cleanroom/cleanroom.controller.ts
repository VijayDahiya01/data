/**
 * The cross-Partner clean room (docs/DESIGN-PARTNER-DATA.md phase 7): the
 * Partner's choices, and the Agent's part in a run.
 */
import { Body, Controller, Get, Inject, Param, Post, Put } from '@nestjs/common';
import type { AgentPrincipal, UserPrincipal } from '@oolix/auth-rbac';
import {
  RequireAgentScope,
  RequirePermissions,
  RequireVerifiedBusiness,
} from '../../common/auth/auth.guard.js';
import { Principal } from '../../common/auth/principal.decorator.js';
import { ZodValidationPipe } from '../../common/validation/zod.pipe.js';
import {
  CleanRoomService,
  DecisionSchema,
  InputPartSchema,
  ParticipationSchema,
  RequestRunSchema,
  type InputPart,
  type RequestRunInput,
} from './cleanroom.service.js';

@Controller('v1/partner/cleanroom')
export class PartnerCleanRoomController {
  constructor(@Inject(CleanRoomService) private readonly cleanroom: CleanRoomService) {}

  /** Whether this Partner takes part, and which others do. */
  @Get()
  @RequirePermissions('report:read')
  async status(@Principal() p: UserPrincipal) {
    return this.cleanroom.status(p.orgId);
  }

  @Put('participation')
  @RequirePermissions('partner:policy:manage')
  @RequireVerifiedBusiness()
  async participate(
    @Principal() p: UserPrincipal,
    @Body(new ZodValidationPipe(ParticipationSchema)) body: { enabled: boolean },
  ) {
    return this.cleanroom.setParticipation(p.orgId, body.enabled);
  }

  @Get('runs')
  @RequirePermissions('report:read')
  async runs(@Principal() p: UserPrincipal) {
    return this.cleanroom.runs(p.orgId);
  }

  /** Asks another Partner for an overlap count or a joint audience. */
  @Post('runs')
  @RequirePermissions('partner:policy:manage')
  @RequireVerifiedBusiness()
  async request(
    @Principal() p: UserPrincipal,
    @Body(new ZodValidationPipe(RequestRunSchema)) body: RequestRunInput,
  ) {
    return this.cleanroom.request(p.orgId, body);
  }

  /** The asked Partner's answer. */
  @Post('runs/:id/decision')
  @RequirePermissions('partner:policy:manage')
  @RequireVerifiedBusiness()
  async decide(
    @Principal() p: UserPrincipal,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(DecisionSchema)) body: { approve: boolean },
  ) {
    return this.cleanroom.decide(p.orgId, id, body.approve);
  }
}

@Controller('agent/v1/cleanroom')
export class AgentCleanRoomController {
  constructor(@Inject(CleanRoomService) private readonly cleanroom: CleanRoomService) {}

  @Get('tasks')
  @RequireAgentScope('config:read')
  async tasks(@Principal() p: AgentPrincipal) {
    return this.cleanroom.tasks(p.partnerOrgId);
  }

  @Put('tasks/:runId/parts/:index')
  @RequireAgentScope('capabilities:write')
  async part(
    @Principal() p: AgentPrincipal,
    @Param('runId') runId: string,
    @Param('index') index: string,
    @Body(new ZodValidationPipe(InputPartSchema)) body: InputPart,
  ) {
    return this.cleanroom.submitPart(p.partnerOrgId, runId, Number(index), body);
  }

  @Get('results')
  @RequireAgentScope('config:read')
  async results(@Principal() p: AgentPrincipal) {
    return this.cleanroom.results(p.partnerOrgId);
  }

  @Post('results/:runId/ack')
  @RequireAgentScope('capabilities:write')
  async ack(@Principal() p: AgentPrincipal, @Param('runId') runId: string) {
    return this.cleanroom.ack(p.partnerOrgId, runId);
  }
}
