/**
 * Audience discovery endpoints -- spec v5 §52.2, §67.5.
 */
import { Controller, Get, Inject, Param, Query } from '@nestjs/common';
import { OolixError } from '@oolix/contracts';
import type { UserPrincipal } from '@oolix/auth-rbac';
import { RequirePermissions } from '../../common/auth/auth.guard.js';
import { Principal } from '../../common/auth/principal.decorator.js';
import { ZodValidationPipe } from '../../common/validation/zod.pipe.js';
import {
  CatalogueService,
  CatalogueQuerySchema,
  type CatalogueQuery,
} from './catalogue.service.js';

@Controller('v1/catalogue')
export class CatalogueController {
  constructor(@Inject(CatalogueService) private readonly catalogue: CatalogueService) {}

  /**
   * §39: a Buyer filters published metadata. There is deliberately no
   * free-form query parameter that reaches a Partner database.
   */
  @Get('segments')
  @RequirePermissions('campaign:read')
  async search(
    @Principal() p: UserPrincipal,
    @Query(new ZodValidationPipe(CatalogueQuerySchema)) query: CatalogueQuery,
  ) {
    return this.catalogue.search(p, query);
  }

  /**
   * v6 §9 step 6: the placements a Partner publishes.
   *
   * An audience-targeted campaign has no segment to reach them through, so the
   * Buyer asks about the Partner directly. A Partner this Buyer may not
   * transact with returns "not found" rather than "forbidden" — confirming
   * existence would itself leak supply (§66.2).
   */
  @Get('partners/:partnerOrgId/placements')
  @RequirePermissions('campaign:read')
  async partnerPlacements(
    @Principal() p: UserPrincipal,
    @Param('partnerOrgId') partnerOrgId: string,
  ) {
    const result = await this.catalogue.partnerPlacements(p, partnerOrgId);
    if (!result) throw new OolixError('PART_001', 'Partner not found.');
    return result;
  }

  @Get('segments/:id')
  @RequirePermissions('campaign:read')
  async get(@Principal() p: UserPrincipal, @Param('id') id: string) {
    const segment = await this.catalogue.get(p, id);
    // A segment the Buyer may not see returns "not found" rather than
    // "forbidden": confirming existence would itself leak supply (§66.2).
    if (!segment) throw new OolixError('PART_001', 'Segment not found.');
    return segment;
  }
}
