/**
 * Partner supply endpoints -- spec v5 §52.2, §67.
 *
 * §67 canonical rule: "Use organization identity from the authenticated
 * context for self-service Partner routes. Do not place partner_org_id in a
 * path when the current organization is implied."
 *
 * So every route below acts on the caller's own organization. A Partner
 * cannot address another Partner's supply even by guessing an id.
 */
import { Body, Controller, Get, Inject, Param, Patch, Post } from '@nestjs/common';
import { OolixError } from '@oolix/contracts';
import {
  RequirePermissions,
  RequireVerifiedBusiness,
  type AuthenticatedRequest,
} from '../../common/auth/auth.guard.js';
import { Principal } from '../../common/auth/principal.decorator.js';
import { ZodValidationPipe } from '../../common/validation/zod.pipe.js';
import type { UserPrincipal } from '@oolix/auth-rbac';
import { SegmentService } from './segment.service.js';
import {
  PlacementService,
  CreatePlacementSchema,
  UpdatePlacementSchema,
  type CreatePlacementInput,
  type UpdatePlacementInput,
} from './placement.service.js';
import {
  PartnerProfileService,
  PartnerPolicySchema,
  PartnerProfileSchema,
  type PartnerPolicyInput,
  type PartnerProfileInput,
} from './partner-profile.service.js';
import {
  CreateSegmentSchema,
  SegmentFreshnessSchema,
  UpdateSegmentSchema,
  type CreateSegmentInput,
  type SegmentFreshnessInput,
  type UpdateSegmentInput,
} from './segment.schema.js';

@Controller('v1/partner')
export class PartnerSupplyController {
  constructor(
    @Inject(SegmentService) private readonly segments: SegmentService,
    @Inject(PlacementService) private readonly placements: PlacementService,
    @Inject(PartnerProfileService) private readonly profiles: PartnerProfileService,
  ) {}

  // --- profile and policy (§37) -------------------------------------------

  @Post('profile')
  @RequirePermissions('partner:policy:manage')
  async upsertProfile(
    @Principal() p: UserPrincipal,
    @Body(new ZodValidationPipe(PartnerProfileSchema)) body: PartnerProfileInput,
  ) {
    return this.profiles.upsertProfile(p.orgId, body);
  }

  @Post('policies')
  @RequirePermissions('partner:policy:manage')
  async publishPolicy(
    @Principal() p: UserPrincipal,
    @Body(new ZodValidationPipe(PartnerPolicySchema)) body: PartnerPolicyInput,
  ) {
    return this.profiles.publishPolicy(p.orgId, body);
  }

  /**
   * §37 step 10 readiness view. Returns the full checklist, not just the
   * status, so a Partner can see exactly what is blocking go-live.
   */
  @Get('readiness')
  @RequirePermissions('report:read')
  async readiness(@Principal() p: UserPrincipal) {
    return this.profiles.refreshReadiness(p.orgId);
  }

  // --- segments (§38, §72) -------------------------------------------------

  @Post('segments')
  @RequirePermissions('segment:manage')
  @RequireVerifiedBusiness()
  async createSegment(
    @Principal() p: UserPrincipal,
    @Body(new ZodValidationPipe(CreateSegmentSchema)) body: CreateSegmentInput,
  ) {
    const result = await this.segments.create(p.orgId, body);
    await this.profiles.refreshReadiness(p.orgId);
    return result;
  }

  @Get('segments')
  @RequirePermissions('segment:manage')
  async listSegments(@Principal() p: UserPrincipal) {
    return { items: await this.segments.list(p.orgId), next_cursor: null };
  }

  @Get('segments/:id')
  @RequirePermissions('segment:manage')
  async getSegment(@Principal() p: UserPrincipal, @Param('id') id: string) {
    return this.segments.get(p.orgId, id);
  }

  @Patch('segments/:id')
  @RequirePermissions('segment:manage')
  async updateSegment(
    @Principal() p: UserPrincipal,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(UpdateSegmentSchema)) body: UpdateSegmentInput,
  ) {
    return this.segments.update(p.orgId, id, body);
  }

  @Post('segments/:id/publish')
  @RequirePermissions('segment:publish')
  @RequireVerifiedBusiness()
  async publishSegment(@Principal() p: UserPrincipal, @Param('id') id: string) {
    const result = await this.segments.publish(p.orgId, id);
    await this.profiles.refreshReadiness(p.orgId);
    return result;
  }

  /**
   * Report a completed segment refresh (§38.1 freshness_at, §38.2).
   *
   * The exact count supplied here is used only to derive the published bucket
   * and is then discarded -- §72 keeps exact reach inside the Partner.
   */
  @Post('segments/:id/freshness')
  @RequirePermissions('segment:manage')
  async reportFreshness(
    @Principal() p: UserPrincipal,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(SegmentFreshnessSchema)) body: SegmentFreshnessInput,
  ) {
    const result = await this.segments.reportFreshness(p.orgId, id, body);
    await this.profiles.refreshReadiness(p.orgId);
    return result;
  }

  // --- placements (§43) ----------------------------------------------------

  @Post('placements')
  @RequirePermissions('placement:manage')
  @RequireVerifiedBusiness()
  async createPlacement(
    @Principal() p: UserPrincipal,
    @Body(new ZodValidationPipe(CreatePlacementSchema)) body: CreatePlacementInput,
  ) {
    const result = await this.placements.create(p.orgId, body);
    await this.profiles.refreshReadiness(p.orgId);
    return result;
  }

  @Get('placements')
  @RequirePermissions('placement:manage')
  async listPlacements(@Principal() p: UserPrincipal) {
    return { items: await this.placements.list(p.orgId), next_cursor: null };
  }

  @Patch('placements/:id')
  @RequirePermissions('placement:manage')
  async updatePlacement(
    @Principal() p: UserPrincipal,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(UpdatePlacementSchema)) body: UpdatePlacementInput,
  ) {
    return this.placements.update(p.orgId, id, body);
  }

  /**
   * Activate or disable a placement.
   *
   * §43 gives the Partner a unilateral kill switch here; disabling requires no
   * Buyer agreement and stops serving on the next control sync.
   */
  @Post('placements/:id/status')
  @RequirePermissions('placement:manage')
  async setPlacementStatus(
    @Principal() p: UserPrincipal,
    @Param('id') id: string,
    @Body() body: { status?: string },
  ) {
    if (body?.status !== 'ACTIVE' && body?.status !== 'DISABLED') {
      throw new OolixError('VAL_001', 'status must be ACTIVE or DISABLED.', {
        fieldErrors: [{ field: 'status', message: 'ACTIVE | DISABLED' }],
      });
    }
    const result = await this.placements.setStatus(p.orgId, id, body.status);
    await this.profiles.refreshReadiness(p.orgId);
    return result;
  }
}

export type { AuthenticatedRequest };
