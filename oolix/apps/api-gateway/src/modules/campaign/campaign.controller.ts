/**
 * Campaign endpoints -- spec v5 §52.3, §67.1-67.3.
 */
import { Body, Controller, Delete, Get, Inject, Param, Patch, Post } from '@nestjs/common';
import { Idempotent } from '../../common/idempotency/idempotency.interceptor.js';
import type { UserPrincipal } from '@oolix/auth-rbac';
import { RequirePermissions, RequireVerifiedBusiness } from '../../common/auth/auth.guard.js';
import { Principal } from '../../common/auth/principal.decorator.js';
import { ZodValidationPipe } from '../../common/validation/zod.pipe.js';
import { CampaignService } from './campaign.service.js';
import {
  CreateCampaignSchema,
  CreatePartnerRequestSchema,
  LinkAudienceSchema,
  UpdateCampaignSchema,
  type CreateCampaignInput,
  type CreatePartnerRequestInput,
  type LinkAudienceInput,
  type UpdateCampaignInput,
} from './campaign.schema.js';

@Controller('v1/campaigns')
export class CampaignController {
  constructor(@Inject(CampaignService) private readonly campaigns: CampaignService) {}

  /**
   * §66.3: drafting is allowed while verification is pending, so creating a
   * campaign needs only campaign:draft. Submitting it does not (Phase 3).
   */
  @Post()
  @RequirePermissions('campaign:draft')
  @Idempotent()
  async create(
    @Principal() p: UserPrincipal,
    @Body(new ZodValidationPipe(CreateCampaignSchema)) body: CreateCampaignInput,
  ) {
    return this.campaigns.create(p, body);
  }

  @Get()
  @RequirePermissions('campaign:read')
  async list(@Principal() p: UserPrincipal) {
    return this.campaigns.list(p);
  }

  @Get(':id')
  @RequirePermissions('campaign:read')
  async get(@Principal() p: UserPrincipal, @Param('id') id: string) {
    return this.campaigns.get(p, id);
  }

  @Patch(':id')
  @RequirePermissions('campaign:draft')
  async update(
    @Principal() p: UserPrincipal,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(UpdateCampaignSchema)) body: UpdateCampaignInput,
  ) {
    return this.campaigns.update(p, id, body);
  }

  /**
   * v6 §9 step 3: choose the campaign's audience.
   *
   * Only campaign:draft is required. Linking an audience is a drafting act --
   * it names who the campaign is for; §66.3's verification gate applies at the
   * point real supply is requested, one route down.
   */
  @Post(':id/audience-link')
  @RequirePermissions('campaign:draft')
  @Idempotent()
  async linkAudience(
    @Principal() p: UserPrincipal,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(LinkAudienceSchema)) body: LinkAudienceInput,
  ) {
    return this.campaigns.linkAudience(p, id, body);
  }

  /** §9 step 10: the frozen audience, for the wizard and the review screen. */
  @Get(':id/audience-link')
  @RequirePermissions('campaign:read')
  async getAudienceLink(@Principal() p: UserPrincipal, @Param('id') id: string) {
    return this.campaigns.getAudienceLink(p, id);
  }

  @Delete(':id/audience-link')
  @RequirePermissions('campaign:draft')
  async unlinkAudience(@Principal() p: UserPrincipal, @Param('id') id: string) {
    return this.campaigns.unlinkAudience(p, id);
  }

  /**
   * §40.4: add one Partner request. Requesting real supply from a real
   * Partner is a business action, so §66.3 verification applies here even
   * though plain drafting does not.
   */
  @Post(':id/partner-requests')
  @RequirePermissions('campaign:draft')
  @RequireVerifiedBusiness()
  @Idempotent()
  async addPartnerRequest(
    @Principal() p: UserPrincipal,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(CreatePartnerRequestSchema)) body: CreatePartnerRequestInput,
  ) {
    return this.campaigns.addPartnerRequest(p, id, body);
  }
}
