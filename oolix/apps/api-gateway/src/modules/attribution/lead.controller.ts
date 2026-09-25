/**
 * Attribution and lead endpoints -- spec v5 §52.5, §71.
 *
 * The lead endpoints are authenticated by the Buyer's CRM API KEY, not a
 * user's sign-in token: the caller is a machine in the Buyer's own stack (§71).
 * They are marked @Public so the global auth guard steps aside, and the key is
 * verified inside the handler instead.
 */
import { Body, Controller, Headers, HttpCode, Inject, Param, Post } from '@nestjs/common';
import { OolixError } from '@oolix/contracts';
import type { UserPrincipal } from '@oolix/auth-rbac';
import { Public, RequirePermissions } from '../../common/auth/auth.guard.js';
import { Principal } from '../../common/auth/principal.decorator.js';
import { ZodValidationPipe } from '../../common/validation/zod.pipe.js';
import { Idempotent } from '../../common/idempotency/idempotency.interceptor.js';
import {
  LeadService,
  LeadEventBatchSchema,
  LeadEventSchema,
  type LeadEventBatchInput,
  type LeadEventInput,
} from './lead.service.js';

@Controller('v1')
export class LeadController {
  constructor(@Inject(LeadService) private readonly leads: LeadService) {}

  /**
   * §52.5 click redirect target.
   *
   * Public: the visitor arriving here is anonymous to Oolix by construction,
   * and the opaque token is the only thing identifying the click (§90).
   */
  @Public()
  @Post('attribution/click/:token')
  // Fixed 200, not Nest's default 201. The response must be IDENTICAL whether
  // or not the token is recognised -- a differing status code would itself let
  // a caller probe for valid tokens.
  @HttpCode(200)
  async click(@Param('token') token: string) {
    return this.leads.recordClick(token);
  }

  /** §52.5 / §71 CRM lead event. */
  @Public()
  @Post('leads/events')
  // §53: lead events are listed explicitly. The service also dedupes on
  // (buyer_org_id, crm_event_id); this covers a retry that reuses neither.
  @Idempotent({ retentionHours: 720 })
  async leadEvent(
    @Headers('authorization') authorization: string | undefined,
    @Body(new ZodValidationPipe(LeadEventSchema)) body: LeadEventInput,
  ) {
    const buyerOrgId = await this.authenticate(authorization);
    const result = await this.leads.ingestEvents(buyerOrgId, { events: [body] });
    return result.results[0];
  }

  /** Batched variant, for a CRM syncing many outcomes at once (§86). */
  @Public()
  @Post('leads/events/batch')
  async leadEventBatch(
    @Headers('authorization') authorization: string | undefined,
    @Body(new ZodValidationPipe(LeadEventBatchSchema)) body: LeadEventBatchInput,
  ) {
    const buyerOrgId = await this.authenticate(authorization);
    return this.leads.ingestEvents(buyerOrgId, body);
  }

  /**
   * §52.5 conversion events.
   *
   * A conversion is a lead-state transition, not a separate object: §71 says a
   * click token maps to ONE logical lead that moves through states.
   */
  @Public()
  @Post('conversions/events')
  async conversionEvent(
    @Headers('authorization') authorization: string | undefined,
    @Body(new ZodValidationPipe(LeadEventSchema)) body: LeadEventInput,
  ) {
    const buyerOrgId = await this.authenticate(authorization);
    const result = await this.leads.ingestEvents(buyerOrgId, {
      events: [{ ...body, status: 'CONVERTED' }],
    });
    return result.results[0];
  }

  /** §71: issue or rotate the Buyer's CRM API key. */
  @Post('buyer/crm-keys')
  @RequirePermissions('crm:connect')
  async issueCrmKey(@Principal() p: UserPrincipal) {
    return this.leads.issueCrmKey(p.orgId);
  }

  private async authenticate(authorization: string | undefined): Promise<string> {
    if (!authorization?.startsWith('Bearer ')) {
      throw new OolixError('AUTH_001', 'Missing CRM API key.');
    }
    return this.leads.authenticateCrm(authorization.slice(7).trim());
  }
}
