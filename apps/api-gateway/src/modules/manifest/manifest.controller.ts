/**
 * Agent control-sync endpoints -- spec v5 §52.4, §75.
 *
 * Scoped entirely by the AGENT principal established in the guard, whose
 * partner id comes from its registration record (§92.4: "never trust a
 * partner_org_id supplied in the body"). There is no path parameter that could
 * be swapped to reach another Partner's configuration.
 */
import { Body, Controller, Get, Inject, Post, Query } from '@nestjs/common';
import type { AgentPrincipal } from '@oolix/auth-rbac';
import { RequireAgentScope } from '../../common/auth/auth.guard.js';
import { Principal } from '../../common/auth/principal.decorator.js';
import { ManifestService } from './manifest.service.js';

@Controller('agent/v1/config')
export class AgentConfigController {
  constructor(@Inject(ManifestService) private readonly manifests: ManifestService) {}

  /** §75: the Agent polls this every 30 seconds. */
  @Get('pull')
  @RequireAgentScope('config:read')
  async pull(@Principal() p: AgentPrincipal, @Query('since_version') since?: string) {
    const sinceVersion = since !== undefined ? Number(since) : undefined;
    return this.manifests.configPull(
      p.partnerOrgId,
      Number.isFinite(sinceVersion) ? sinceVersion : undefined,
    );
  }

  @Post('ack')
  @RequireAgentScope('config:read')
  async ack(@Principal() p: AgentPrincipal, @Body() body: { config_version?: number }) {
    return this.manifests.configAck(p.agentId, p.partnerOrgId, Number(body?.config_version ?? 0));
  }
}
