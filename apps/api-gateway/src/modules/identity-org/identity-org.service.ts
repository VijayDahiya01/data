/**
 * Identity, organizations and membership -- spec v5 §35, §36, §66.
 *
 * Authentication is the IdP's job; this module owns AUTHORIZATION FACTS: which
 * organizations exist, who belongs to them, in what role, and how far through
 * verification they are. §4.2 requires those facts to live here rather than in
 * a token claim, so an IdP misconfiguration cannot grant Oolix permissions.
 */
import { Injectable, Inject } from '@nestjs/common';
import { z } from 'zod';
import {
  OolixError,
  ROLES,
  canSubmitOrPublish,
  permissionsForRoles,
  type Role,
} from '@oolix/contracts';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AuditService } from '../../common/audit/audit.service.js';

export const CreateOrganizationSchema = z.object({
  name: z.string().min(2).max(200),
  domain: z
    .string()
    .min(3)
    .max(253)
    .regex(/^[a-z0-9.-]+\.[a-z]{2,}$/i, 'a bare domain, e.g. partner.example'),
  type: z.enum(['BUYER', 'DATA_PARTNER', 'BUYER_AND_PARTNER', 'NETWORK_SPONSOR', 'AGENCY']),
  country: z.string().length(2),
  industry: z.string().max(120).optional(),
  tax_id: z.string().max(60).optional(),
  invite_code: z.string().max(120).optional(),
});
export type CreateOrganizationInput = z.infer<typeof CreateOrganizationSchema>;

export const InviteMemberSchema = z.object({
  email: z.string().email(),
  name: z.string().min(2).max(200),
  role: z.enum(ROLES),
});
export type InviteMemberInput = z.infer<typeof InviteMemberSchema>;

@Injectable()
export class IdentityOrgService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  /**
   * Create an organization and make the caller its first admin.
   *
   * The initial role follows organization type: whoever creates a Data Partner
   * needs PARTNER_ADMIN to proceed with §37 onboarding. New organizations
   * start at BUSINESS_VERIFICATION_PENDING -- §66.3 allows browsing and
   * drafting while pending, but not submitting or publishing.
   */
  async createOrganization(userId: string, input: CreateOrganizationInput) {
    const existing = await this.prisma.organization.findFirst({
      where: { domain: input.domain.toLowerCase() },
      select: { id: true },
    });
    if (existing) {
      throw new OolixError('VAL_001', 'An organization already claims this domain.', {
        fieldErrors: [{ field: 'domain', message: 'already registered' }],
      });
    }

    const initialRoles: Role[] =
      input.type === 'DATA_PARTNER'
        ? ['PARTNER_ADMIN', 'PARTNER_SECURITY_ADMIN']
        : input.type === 'NETWORK_SPONSOR'
          ? ['NETWORK_ADMIN']
          : input.type === 'BUYER_AND_PARTNER'
            ? ['BUYER_ADMIN', 'PARTNER_ADMIN', 'PARTNER_SECURITY_ADMIN']
            : ['BUYER_ADMIN'];

    const org = await this.prisma.$transaction(async (tx) => {
      const created = await tx.organization.create({
        data: {
          name: input.name,
          domain: input.domain.toLowerCase(),
          type: input.type as never,
          country: input.country.toUpperCase(),
          industry: input.industry ?? null,
          taxId: input.tax_id ?? null,
          // §66.3: manual Oolix Operations verification for the MVP.
          verificationStatus: 'BUSINESS_VERIFICATION_PENDING',
        },
      });

      await tx.organizationMember.createMany({
        data: initialRoles.map((role) => ({
          orgId: created.id,
          userId,
          role: role as never,
          status: 'ACTIVE' as never,
        })),
      });

      if (input.type === 'DATA_PARTNER' || input.type === 'BUYER_AND_PARTNER') {
        await tx.partnerProfile.create({ data: { orgId: created.id } });
      }
      if (input.type === 'BUYER' || input.type === 'BUYER_AND_PARTNER') {
        await tx.buyerProfile.create({ data: { orgId: created.id } });
      }

      return created;
    });

    await this.audit.record({
      action: 'ORGANIZATION_CREATED',
      entityType: 'organization',
      entityId: org.id,
      orgId: org.id,
      actor: userId,
      metadata: { type: input.type, domain: org.domain, roles: initialRoles },
    });

    return this.orgToWire(org);
  }

  /**
   * Invite a member.
   *
   * The user row is created in advance keyed by email, with a placeholder
   * auth_subject. The real subject is bound on first login, which keeps
   * identity ownership with the IdP while letting a Partner set up its team
   * before those people have ever signed in.
   */
  async inviteMember(orgId: string, actorUserId: string, input: InviteMemberInput) {
    const org = await this.prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) throw new OolixError('PART_001', 'Organization not found.');

    const user = await this.prisma.user.upsert({
      where: { email: input.email.toLowerCase() },
      create: {
        email: input.email.toLowerCase(),
        name: input.name,
        // Replaced with the real OIDC subject at first login.
        authSubject: `pending:${input.email.toLowerCase()}`,
        status: 'PENDING_EMAIL_VERIFICATION',
      },
      update: {},
    });

    const membership = await this.prisma.organizationMember.upsert({
      where: {
        orgId_userId_role: { orgId, userId: user.id, role: input.role as never },
      },
      create: {
        orgId,
        userId: user.id,
        role: input.role as never,
        status: 'INVITED',
      },
      update: { status: 'INVITED' },
    });

    await this.audit.record({
      action: 'MEMBER_INVITED',
      entityType: 'organization_member',
      entityId: `${orgId}:${user.id}`,
      orgId,
      actor: actorUserId,
      // §78.1: the invited address is PII and is not written to the audit log.
      metadata: { role: input.role },
    });

    return {
      user_id: user.id,
      role: membership.role,
      status: membership.status,
    };
  }

  async listMembers(orgId: string) {
    const rows = await this.prisma.organizationMember.findMany({
      where: { orgId },
      include: { user: { select: { id: true, email: true, name: true, status: true } } },
      orderBy: { invitedAt: 'asc' },
    });

    // Collapse per-role rows into one entry per user.
    const byUser = new Map<
      string,
      { user_id: string; email: string; name: string; roles: string[]; status: string }
    >();
    for (const r of rows) {
      const entry = byUser.get(r.userId) ?? {
        user_id: r.user.id,
        email: r.user.email,
        name: r.user.name,
        roles: [],
        status: r.status,
      };
      entry.roles.push(r.role);
      byUser.set(r.userId, entry);
    }
    return [...byUser.values()];
  }

  async removeMember(orgId: string, userId: string, actorUserId: string) {
    if (userId === actorUserId) {
      // Removing yourself can orphan an organization with no admin.
      throw new OolixError('VAL_001', 'You cannot remove your own membership.');
    }
    await this.prisma.organizationMember.updateMany({
      where: { orgId, userId },
      data: { status: 'REMOVED' },
    });
    await this.audit.record({
      action: 'MEMBER_REMOVED',
      entityType: 'organization_member',
      entityId: `${orgId}:${userId}`,
      orgId,
      actor: actorUserId,
    });
    return { removed: true };
  }

  /**
   * §52.1 GET /v1/me/context.
   *
   * Everything the portal needs to render role-aware navigation (§34) in one
   * call: organizations, roles, resolved permissions, network memberships and
   * what the verification state currently permits.
   */
  async meContext(userId: string, activeOrgId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        memberships: {
          where: { status: 'ACTIVE' },
          include: { organization: true },
        },
      },
    });
    if (!user) throw new OolixError('AUTH_001', 'User not found.');

    const orgs = new Map<
      string,
      { id: string; name: string; type: string; verification_status: string; roles: Role[] }
    >();
    for (const m of user.memberships) {
      const entry = orgs.get(m.orgId) ?? {
        id: m.organization.id,
        name: m.organization.name,
        type: m.organization.type,
        verification_status: m.organization.verificationStatus,
        roles: [],
      };
      entry.roles.push(m.role as Role);
      orgs.set(m.orgId, entry);
    }

    const active = orgs.get(activeOrgId);
    if (!active) throw new OolixError('PERM_002', 'Not a member of the active organization.');

    const networks = await this.prisma.networkMembership.findMany({
      where: { orgId: activeOrgId, status: 'ACTIVE' },
      include: { network: { select: { id: true, name: true, mode: true } } },
    });

    const partnerProfile = await this.prisma.partnerProfile.findUnique({
      where: { orgId: activeOrgId },
      select: { readinessStatus: true },
    });

    return {
      user: { id: user.id, email: user.email, name: user.name, status: user.status },
      active_organization: {
        ...active,
        // §66.3: what this organization may do right now.
        can_submit_campaigns: canSubmitOrPublish(active.verification_status as never),
        can_publish_supply: canSubmitOrPublish(active.verification_status as never),
        partner_readiness: partnerProfile?.readinessStatus ?? null,
      },
      organizations: [...orgs.values()],
      permissions: [...permissionsForRoles(active.roles)].sort(),
      networks: networks.map((n) => ({
        id: n.network.id,
        name: n.network.name,
        mode: n.network.mode,
      })),
    };
  }

  /**
   * Bind an OIDC subject to a pre-created invited user on first login.
   *
   * Matching on the verified email is what turns an invitation into a real
   * account without Oolix ever handling a credential.
   */
  async linkAuthSubject(email: string, authSubject: string, name?: string) {
    const user = await this.prisma.user.findUnique({ where: { email: email.toLowerCase() } });
    if (!user) return null;
    if (user.authSubject === authSubject) return user;
    if (!user.authSubject.startsWith('pending:')) {
      throw new OolixError('AUTH_001', 'This email is already bound to a different identity.');
    }

    const updated = await this.prisma.user.update({
      where: { id: user.id },
      data: {
        authSubject,
        status: 'ACTIVE',
        ...(name ? { name } : {}),
      },
    });

    await this.prisma.organizationMember.updateMany({
      where: { userId: user.id, status: 'INVITED' },
      data: { status: 'ACTIVE' },
    });

    return updated;
  }

  private orgToWire(org: {
    id: string;
    name: string;
    domain: string;
    type: string;
    country: string;
    verificationStatus: string;
  }) {
    return {
      organization_id: org.id,
      name: org.name,
      domain: org.domain,
      type: org.type,
      country: org.country,
      verification_status: org.verificationStatus,
    };
  }
}
