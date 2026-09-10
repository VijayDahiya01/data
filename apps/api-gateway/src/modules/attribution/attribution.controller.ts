/**
 * Agent-facing attribution endpoint -- spec v5 §71, §90.
 */
import { Body, Controller, Inject, Post } from '@nestjs/common';
import type { AgentPrincipal } from '@oolix/auth-rbac';
import { RequireAgentScope } from '../../common/auth/auth.guard.js';
import { Principal } from '../../common/auth/principal.decorator.js';
import { ZodValidationPipe } from '../../common/validation/zod.pipe.js';
import {
  AttributionService,
  RegisterTokensSchema,
  type RegisterTokensInput,
} from './attribution.service.js';

@Controller('agent/v1/attribution')
export class AgentAttributionController {
  constructor(@Inject(AttributionService) private readonly attribution: AttributionService) {}

  /**
   * The Agent uploads token HASHES only. The raw token went to the browser and
   * exists nowhere else (§90).
   */
  @Post('tokens')
  @RequireAgentScope('reporting:write')
  async registerTokens(
    @Principal() p: AgentPrincipal,
    @Body(new ZodValidationPipe(RegisterTokensSchema)) body: RegisterTokensInput,
  ) {
    return this.attribution.registerTokens(p.partnerOrgId, body);
  }
}
