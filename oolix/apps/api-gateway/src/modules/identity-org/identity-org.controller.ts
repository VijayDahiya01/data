/**
 * Identity and organization endpoints -- spec v5 §52.1, §67.
 */
import { Body, Controller, Delete, Get, Inject, Param, Post } from '@nestjs/common';
import type { OnboardingPrincipal, UserPrincipal } from '@oolix/auth-rbac';
import { AllowWithoutOrganization, RequirePermissions } from '../../common/auth/auth.guard.js';
import { Principal } from '../../common/auth/principal.decorator.js';
import { ZodValidationPipe } from '../../common/validation/zod.pipe.js';
import {
  IdentityOrgService,
  CreateOrganizationSchema,
  InviteMemberSchema,
  type CreateOrganizationInput,
  type InviteMemberInput,
} from './identity-org.service.js';

@Controller('v1')
export class IdentityOrgController {
  constructor(@Inject(IdentityOrgService) private readonly identity: IdentityOrgService) {}

  /**
   * Everything the portal needs to render role-aware navigation (§34) in one
   * call, so the frontend never infers permissions from a role name.
   *
   * Also answers someone who belongs to no organization yet, with
   * `active_organization: null`, which is how the portal knows to send them to
   * organization setup.
   */
  @Get('me/context')
  @AllowWithoutOrganization()
  async meContext(@Principal() p: UserPrincipal | OnboardingPrincipal) {
    return this.identity.meContext(p.userId, p.kind === 'user' ? p.orgId : null);
  }

  /**
   * Create an organization.
   *
   * Requires no permission: an authenticated user with no organization yet is
   * exactly who calls this (§35.2). Authorization begins once they have one.
   * Until 2026-09-24 the guard refused anyone without an organization, so
   * this route could not be reached by the very person it was written for.
   */
  @Post('organizations')
  @AllowWithoutOrganization()
  async createOrganization(
    @Principal() p: UserPrincipal | OnboardingPrincipal,
    @Body(new ZodValidationPipe(CreateOrganizationSchema)) body: CreateOrganizationInput,
  ) {
    return this.identity.createOrganization(p.userId, body);
  }

  @Get('organizations/members')
  @RequirePermissions('org:member:manage')
  async listMembers(@Principal() p: UserPrincipal) {
    return { items: await this.identity.listMembers(p.orgId), next_cursor: null };
  }

  @Post('organizations/members/invite')
  @RequirePermissions('org:member:manage')
  async invite(
    @Principal() p: UserPrincipal,
    @Body(new ZodValidationPipe(InviteMemberSchema)) body: InviteMemberInput,
  ) {
    return this.identity.inviteMember(p.orgId, p.userId, body);
  }

  @Delete('organizations/members/:userId')
  @RequirePermissions('org:member:manage')
  async removeMember(@Principal() p: UserPrincipal, @Param('userId') userId: string) {
    return this.identity.removeMember(p.orgId, userId, p.userId);
  }
}
