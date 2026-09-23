/**
 * Brand endpoints -- spec v5 §36 step 4, §40.2.
 *
 * §40.2 requires every campaign to name a brand belonging to the verified
 * Buyer organization, so this is a prerequisite for the campaign builder
 * rather than an optional extra.
 */
import { Body, Controller, Get, Inject, Post } from '@nestjs/common';
import type { UserPrincipal } from '@oolix/auth-rbac';
import { RequirePermissions } from '../../common/auth/auth.guard.js';
import { Principal } from '../../common/auth/principal.decorator.js';
import { ZodValidationPipe } from '../../common/validation/zod.pipe.js';
import { BrandService, CreateBrandSchema, type CreateBrandInput } from './brand.service.js';

@Controller('v1/brands')
export class BrandController {
  constructor(@Inject(BrandService) private readonly brands: BrandService) {}

  @Get()
  @RequirePermissions('campaign:read')
  async list(@Principal() p: UserPrincipal) {
    return this.brands.list(p);
  }

  /**
   * §66.3 allows drafting while business verification is pending, and a brand
   * is part of drafting -- so this needs campaign:draft, not a verified
   * organization. Submission is where verification bites.
   */
  @Post()
  @RequirePermissions('campaign:draft')
  async create(
    @Principal() p: UserPrincipal,
    @Body(new ZodValidationPipe(CreateBrandSchema)) body: CreateBrandInput,
  ) {
    return this.brands.create(p, body);
  }
}
