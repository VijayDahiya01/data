/**
 * Platform organization administration -- spec v5 §35.2, §66, §98.1.
 *
 * The missing half of the verification model. An organization is created at
 * BUSINESS_VERIFICATION_PENDING, and §66.3 lets it browse and draft but not
 * submit or publish. Nothing in the running system could move it on: the only
 * writer of BUSINESS_VERIFIED was the development seed, and `db:seed
 * --env=production` refuses by design. A real deployment could therefore
 * onboard an organization and then permanently refuse everything it tried to
 * do, with no route out except an UPDATE against the production database.
 *
 * Every route here is `admin:operate`, which OOLIX_ADMIN alone holds and which
 * `assertOrgScope` treats as cross-organization. §66's limit still binds and
 * is enforced by the absence of a permission rather than by a check here:
 * operating the platform never includes approving a campaign on a Data
 * Partner's behalf, or reading their customer data.
 */
import { Body, Controller, Get, Inject, Param, Post, Query } from '@nestjs/common';
import type { UserPrincipal } from '@oolix/auth-rbac';
import { RequirePermissions } from '../../common/auth/auth.guard.js';
import { Principal } from '../../common/auth/principal.decorator.js';
import { ZodValidationPipe } from '../../common/validation/zod.pipe.js';
import {
  IdentityOrgService,
  ListOrganizationsQuerySchema,
  RevokeVerificationSchema,
  VerifyOrganizationSchema,
  type RevokeVerificationInput,
  type VerifyOrganizationInput,
} from './identity-org.service.js';
import type { z } from 'zod';

type ListQuery = z.infer<typeof ListOrganizationsQuerySchema>;

@Controller('v1/admin/organizations')
export class AdminOrganizationsController {
  constructor(@Inject(IdentityOrgService) private readonly identity: IdentityOrgService) {}

  /** Every organization and where it stands, optionally filtered by state. */
  @Get()
  @RequirePermissions('admin:operate')
  async list(@Query(new ZodValidationPipe(ListOrganizationsQuerySchema)) query: ListQuery) {
    return {
      organizations: await this.identity.listOrganizations({
        verificationStatus: query.verification_status,
      }),
    };
  }

  /**
   * Record that an organization is a real legal entity.
   *
   * Idempotent: an organization already at or past BUSINESS_VERIFIED comes
   * back unchanged rather than being dragged backwards, so a retried request
   * cannot undo ROLE_ONBOARDING or ACTIVE.
   */
  @Post(':id/verify')
  @RequirePermissions('admin:operate')
  async verify(
    @Principal() p: UserPrincipal,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(VerifyOrganizationSchema)) body: VerifyOrganizationInput,
  ) {
    return this.identity.verifyOrganization(id, p.userId, body.note);
  }

  /**
   * Put a verified organization back to pending.
   *
   * A reason is required, because this is the one somebody will be asked to
   * explain later. Work already approved and running is untouched -- §66.3
   * gates the act of submitting, not what has already been submitted.
   */
  @Post(':id/revoke-verification')
  @RequirePermissions('admin:operate')
  async revoke(
    @Principal() p: UserPrincipal,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(RevokeVerificationSchema)) body: RevokeVerificationInput,
  ) {
    return this.identity.revokeVerification(id, p.userId, body.reason);
  }
}
