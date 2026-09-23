/**
 * Audience Builder endpoints — v6 §14.
 *
 * Three surfaces in one module because they are three views of one idea: a
 * Buyer writes rules, a Partner declares what it can evaluate, and the match
 * between them decides who can be asked for an estimate.
 */
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import type { UserPrincipal } from '@oolix/auth-rbac';
import { RequirePermissions, RequireVerifiedBusiness } from '../../common/auth/auth.guard.js';
import { Principal } from '../../common/auth/principal.decorator.js';
import { ZodValidationPipe } from '../../common/validation/zod.pipe.js';
import { Idempotent } from '../../common/idempotency/idempotency.interceptor.js';
import { AudienceService } from './audience.service.js';
import {
  CreateAudienceSchema,
  PublishCapabilitiesSchema,
  RequestReachEstimatesSchema,
  UpdateAudienceSchema,
  type CreateAudienceInput,
  type PublishCapabilitiesInput,
  type RequestReachEstimatesInput,
  type UpdateAudienceInput,
} from './audience.schema.js';

@Controller('v1/audiences')
export class AudienceController {
  constructor(@Inject(AudienceService) private readonly audiences: AudienceService) {}

  /**
   * §4: the shared vocabulary BOTH sides compose from.
   *
   * Authenticated, but with no permission gate, because the taxonomy is
   * Oolix-controlled platform reference data (§4) rather than either party's
   * information. A Buyer renders the Audience Builder from it; a Data Partner
   * renders the capability form from it and needs the display names to review
   * a request's rules (§5.1, §18.2).
   *
   * It carried `campaign:read` — a Buyer-only permission — and since the guard
   * requires EVERY listed permission, that 403'd for every Partner persona.
   * The Partner capability page then rendered "the attribute taxonomy could not
   * be loaded" and §5.1 publishing was impossible from the UI.
   *
   * There is nothing confidential here to gate: it is a list of attribute names
   * and operators, identical for everyone.
   */
  @Get('taxonomy')
  async taxonomy() {
    return this.audiences.taxonomy();
  }

  @Post()
  @RequirePermissions('campaign:draft')
  @Idempotent()
  async create(
    @Principal() p: UserPrincipal,
    @Body(new ZodValidationPipe(CreateAudienceSchema)) body: CreateAudienceInput,
  ) {
    return this.audiences.create(p, body);
  }

  @Get()
  @RequirePermissions('campaign:read')
  async list(@Principal() p: UserPrincipal) {
    return this.audiences.list(p);
  }

  @Get(':id')
  @RequirePermissions('campaign:read')
  async get(@Principal() p: UserPrincipal, @Param('id') id: string) {
    return this.audiences.get(p, id);
  }

  /** §16: editing a READY audience forks a new version rather than mutating one. */
  @Patch(':id')
  @RequirePermissions('campaign:draft')
  async update(
    @Principal() p: UserPrincipal,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(UpdateAudienceSchema)) body: UpdateAudienceInput,
  ) {
    return this.audiences.update(p, id, body);
  }

  @Post(':id/publish')
  @RequirePermissions('campaign:draft')
  async publish(@Principal() p: UserPrincipal, @Param('id') id: string) {
    return this.audiences.publish(p, id);
  }

  /**
   * Point 17: change history for one audience.
   *
   * Separate from the detail response because it is opened rarely -- the portal
   * keeps it behind "More" -- and there is no reason to carry it on every page
   * load of the audience itself.
   */
  @Get(':id/history')
  @RequirePermissions('campaign:read')
  async history(@Principal() p: UserPrincipal, @Param('id') id: string) {
    return this.audiences.history(p, id);
  }

  /** §7: which Partners can evaluate these rules. */
  @Get(':id/partner-matches')
  @RequirePermissions('campaign:read')
  async partnerMatches(
    @Principal() p: UserPrincipal,
    @Param('id') id: string,
    @Query('audience_version') version?: string,
  ) {
    return this.audiences.partnerMatches(p, id, version ? Number(version) : undefined);
  }

  /**
   * §8.1: ask selected Partners to evaluate locally.
   *
   * Needs a verified business: this reaches into a Partner's systems to run a
   * query, so §66.3's gate applies as it does to submission.
   */
  @Post(':id/reach-estimates')
  // 202, not 201: v6 §8.1 shows `202` because nothing is finished when this
  // returns. The estimates are QUEUED for each Partner's Agent to evaluate
  // locally, and the answer arrives minutes later. A 201 would tell the Buyer's
  // client that a result exists.
  @HttpCode(202)
  @RequirePermissions('campaign:draft')
  @RequireVerifiedBusiness()
  async requestEstimates(
    @Principal() p: UserPrincipal,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(RequestReachEstimatesSchema)) body: RequestReachEstimatesInput,
  ) {
    return this.audiences.requestReachEstimates(p, id, body.partner_org_ids, body.audience_version);
  }

  @Get(':id/reach-estimates')
  @RequirePermissions('campaign:read')
  async listEstimates(@Principal() p: UserPrincipal, @Param('id') id: string) {
    return this.audiences.listReachEstimates(p, id);
  }
}

/**
 * §5.1: Partner capability publication.
 *
 * Under `/v1/partner` because it is supply-side. `segment:manage` rather than a
 * new permission: declaring what you can evaluate is the same act of publishing
 * supply as defining a segment.
 */
@Controller('v1/partner/capabilities')
export class PartnerCapabilityController {
  constructor(@Inject(AudienceService) private readonly audiences: AudienceService) {}

  @Get()
  @RequirePermissions('segment:manage')
  async mine(@Principal() p: UserPrincipal) {
    return this.audiences.myCapabilities(p);
  }

  @Put()
  @RequirePermissions('segment:manage')
  @RequireVerifiedBusiness()
  async publish(
    @Principal() p: UserPrincipal,
    @Body(new ZodValidationPipe(PublishCapabilitiesSchema)) body: PublishCapabilitiesInput,
  ) {
    return this.audiences.publishCapabilities(p, body);
  }
}
