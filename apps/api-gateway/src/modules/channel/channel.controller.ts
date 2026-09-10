/**
 * Channel connection and eligibility endpoints -- spec v5 §17, §47, §48.
 *
 * `channel:connect` gates all of it, and that single permission is held by
 * both BUYER_ADMIN and PARTNER_SECURITY_ADMIN. That is deliberate: §47's
 * account topology has assets on both sides -- the Partner holds the audience,
 * the advertiser holds the page and pays -- so both have a connection to
 * register. @RequirePermissions is all-of, so listing a second permission here
 * would silently 403 whichever side lacked it.
 */
import { Body, Controller, Delete, Get, Inject, Param, Post, Put } from '@nestjs/common';
import type { AgentPrincipal, UserPrincipal } from '@oolix/auth-rbac';
import { OolixError } from '@oolix/contracts';
import { RequireAgentScope, RequirePermissions } from '../../common/auth/auth.guard.js';
import { Principal } from '../../common/auth/principal.decorator.js';
import { ZodValidationPipe } from '../../common/validation/zod.pipe.js';
import { Idempotent } from '../../common/idempotency/idempotency.interceptor.js';
import { ChannelService } from './channel.service.js';
import { ChannelStatusService } from './channel-status.service.js';
import { ReportChannelSyncSchema, type ReportChannelSyncInput } from './channel-status.schema.js';
import { ChannelActivationService } from './channel-activation.service.js';
import {
  ProviderParamSchema,
  UpsertConnectionSchema,
  type UpsertConnectionInput,
} from './channel.schema.js';

function parseProvider(raw: string) {
  const parsed = ProviderParamSchema.safeParse(raw?.toUpperCase());
  if (!parsed.success) {
    throw new OolixError('VAL_001', `Unknown channel provider "${raw}". Expected META or GOOGLE.`);
  }
  return parsed.data;
}

@Controller('v1/channel-connections')
export class ChannelConnectionController {
  constructor(@Inject(ChannelService) private readonly channels: ChannelService) {}

  @Get()
  @RequirePermissions('channel:connect')
  async list(@Principal() p: UserPrincipal) {
    return this.channels.list(p);
  }

  @Get(':provider')
  @RequirePermissions('channel:connect')
  async get(@Principal() p: UserPrincipal, @Param('provider') provider: string) {
    return this.channels.get(p, parseProvider(provider));
  }

  @Put(':provider')
  @RequirePermissions('channel:connect')
  async upsert(
    @Principal() p: UserPrincipal,
    @Param('provider') provider: string,
    @Body(new ZodValidationPipe(UpsertConnectionSchema)) body: UpsertConnectionInput,
  ) {
    return this.channels.upsert(p, parseProvider(provider), body);
  }

  @Delete(':provider')
  @RequirePermissions('channel:connect')
  async disconnect(@Principal() p: UserPrincipal, @Param('provider') provider: string) {
    return this.channels.disconnect(p, parseProvider(provider));
  }
}

@Controller('v1/activations')
export class ActivationEligibilityController {
  constructor(
    @Inject(ChannelActivationService) private readonly activations: ChannelActivationService,
  ) {}

  /**
   * Run, or re-run, the §47.5 / §48.4 eligibility check.
   *
   * Idempotent because the honest answer to a retried request is the previous
   * answer, not a second evaluation: an operator refreshing after a timeout
   * should not cause two manifests to be signed.
   */
  @Post(':id/eligibility-check')
  @RequirePermissions('channel:connect')
  @Idempotent()
  async check(@Param('id') id: string) {
    const outcome = await this.activations.runCheck(id);
    return {
      activation_id: outcome.activationId,
      eligible: outcome.eligible,
      status: outcome.status,
      manifest_version: outcome.manifestVersion,
      summary: outcome.verdict.summary,
      // Every check, not just the failures: a Partner fixing a connection
      // wants to see what already passed as much as what did not.
      checks: outcome.verdict.checks.map((c) => ({
        id: c.id,
        description: c.description,
        passed: c.passed,
        detail: c.detail,
      })),
    };
  }
}

/**
 * The Agent's report of what it did with an external audience -- §47.11.
 *
 * On the `agent/v1` surface rather than `v1`, because the caller is a Partner
 * Agent holding a scoped assertion, not a signed-in person. `channel_status:write`
 * is a default Agent scope, so an Agent that can serve can also report -- but
 * an Agent whose scopes were narrowed at registration cannot.
 */
@Controller('agent/v1')
export class AgentChannelStatusController {
  constructor(@Inject(ChannelStatusService) private readonly status: ChannelStatusService) {}

  @Post('channel-status')
  @RequireAgentScope('channel_status:write')
  async report(
    @Principal() p: AgentPrincipal,
    @Body(new ZodValidationPipe(ReportChannelSyncSchema)) body: ReportChannelSyncInput,
  ) {
    return this.status.report(p.partnerOrgId, body);
  }
}
