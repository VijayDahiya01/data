/**
 * Partner Agent control endpoints -- spec v5 §52.4, §67, §92.
 *
 * Two surfaces with different authentication, deliberately kept apart:
 *
 *   /v1/partner/agents/*  PARTNER_SECURITY_ADMIN, signed-in user token
 *   /agent/v1/*           the Agent workload itself
 *
 * Registration and token issuance are @Public because the caller has no
 * access token yet -- they authenticate with the bootstrap token and the
 * client assertion respectively, both verified inside the service.
 */
import { Body, Controller, Get, Headers, Inject, Param, Post, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { OolixError } from '@oolix/contracts';
import type { AgentPrincipal, UserPrincipal } from '@oolix/auth-rbac';
import { Public, RequireAgentScope, RequirePermissions } from '../../common/auth/auth.guard.js';
import { Principal } from '../../common/auth/principal.decorator.js';
import { ZodValidationPipe } from '../../common/validation/zod.pipe.js';
import {
  AgentRegistryService,
  AgentTokenSchema,
  HeartbeatSchema,
  RegisterAgentSchema,
  type AgentTokenInput,
  type HeartbeatInput,
  type RegisterAgentInput,
} from './agent-registry.service.js';

/**
 * Partner-facing Agent administration (§92.1).
 *
 * PARTNER_SECURITY_ADMIN only: §66 puts Agent registration and revocation in
 * the security role, separate from the commercial PARTNER_ADMIN.
 */
@Controller('v1/partner/agents')
export class PartnerAgentAdminController {
  constructor(@Inject(AgentRegistryService) private readonly agents: AgentRegistryService) {}

  @Get()
  @RequirePermissions('agent:register')
  async list(@Principal() p: UserPrincipal) {
    return { items: await this.agents.list(p.orgId), next_cursor: null };
  }

  /**
   * Generate a bootstrap token.
   *
   * §92.1: single-use, 15 minutes, returned exactly once. The UI must warn
   * that it cannot be displayed again -- only its hash is stored.
   */
  @Post('bootstrap-tokens')
  @RequirePermissions('agent:register')
  async createBootstrapToken(@Principal() p: UserPrincipal) {
    return this.agents.createBootstrapToken(p.orgId, p.userId);
  }

  @Post('bootstrap-tokens/revoke')
  @RequirePermissions('agent:revoke')
  async revokeBootstrapTokens(@Principal() p: UserPrincipal) {
    return this.agents.revokeBootstrapTokens(p.orgId);
  }

  /** §69.3 / §80: immediate revocation for incident response. */
  @Post(':id/revoke')
  @RequirePermissions('agent:revoke')
  async revoke(
    @Principal() p: UserPrincipal,
    @Param('id') id: string,
    @Body() body: { reason?: string },
  ) {
    if (!body?.reason) {
      throw new OolixError('VAL_001', 'A revocation reason is required for the audit trail.', {
        fieldErrors: [{ field: 'reason', message: 'required' }],
      });
    }
    return this.agents.revoke(p.orgId, id, body.reason);
  }
}

/**
 * The Agent's own control-plane surface (§52.4, §67).
 */
@Controller('agent/v1')
export class AgentControlController {
  constructor(@Inject(AgentRegistryService) private readonly agents: AgentRegistryService) {}

  /**
   * §92.2 registration. Public because the Agent has no access token yet; it
   * authenticates with the single-use bootstrap token in the body.
   */
  @Public()
  @Post('register')
  async register(@Body(new ZodValidationPipe(RegisterAgentSchema)) body: RegisterAgentInput) {
    return this.agents.register(body);
  }

  /**
   * §92.3 token exchange. Public for the same reason: the ES256 client
   * assertion in the body IS the credential, verified against the public key
   * recorded at registration.
   */
  @Public()
  @Post('token')
  async token(@Body(new ZodValidationPipe(AgentTokenSchema)) body: AgentTokenInput) {
    return this.agents.issueToken(body);
  }

  /**
   * The Partner Connect bundle (a docker-compose.yml). Public and free of
   * secrets, so a Partner can fetch it straight onto the server that will run
   * the Agent:
   *
   *   curl -fsSLo docker-compose.yml <API_PUBLIC_URL>/agent/v1/compose
   *
   * Written to the reply rather than returned: the response envelope would
   * turn the YAML into JSON.
   */
  @Public()
  @Get('compose')
  async compose(@Res() reply: FastifyReply): Promise<void> {
    await reply
      .header('Content-Type', 'text/yaml; charset=utf-8')
      .header('Content-Disposition', 'attachment; filename="docker-compose.yml"')
      .send(this.agents.composeBundle());
  }

  /** §52.4 heartbeat. Feeds the §78.2 staleness alerts. */
  @Post('heartbeat')
  @RequireAgentScope('heartbeat:write')
  async heartbeat(
    @Principal() p: AgentPrincipal,
    @Body(new ZodValidationPipe(HeartbeatSchema)) body: HeartbeatInput,
    @Headers('x-correlation-id') _correlationId?: string,
  ) {
    return this.agents.heartbeat(p.agentId, p.partnerOrgId, body);
  }
}
