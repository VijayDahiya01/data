/**
 * Authentication and authorization guard -- spec v5 §4.2, §56, §66, §82, §92.4.
 *
 * Two independent paths, deliberately never mixed:
 *
 *   /v1/*       user principal, Oolix-issued user access token
 *   /agent/v1/* agent principal, Oolix-issued workload token + X-Agent-Id
 *
 * Both tokens are signed by Oolix, with different keys and audiences, so one
 * can never stand in for the other. The roles a user holds are read from the
 * DATABASE for the active organization, never from a token claim (§4.2:
 * "never trust UI-only role filtering"), so no signing mistake can become a
 * privilege escalation inside Oolix.
 */
import { CanActivate, ExecutionContext, Inject, Injectable, SetMetadata } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import { OolixError, canSubmitOrPublish, type Permission, type Role } from '@oolix/contracts';
import {
  buildUserPermissions,
  verifyUserAccessToken,
  verifyAgentAccessToken,
  type AgentScope,
  type OnboardingPrincipal,
  type Principal,
  type UserPrincipal,
} from '@oolix/auth-rbac';
import { PrismaService } from '../../prisma/prisma.service.js';
import { CONFIG, type OolixConfig } from '../../config/configuration.js';
import { enrichContext } from '../correlation/correlation.js';
import { AgentKeyService } from '../../keys/agent-key.service.js';
import { UserKeyService } from '../../keys/user-key.service.js';

// ---------------------------------------------------------------------------
// Route metadata decorators
// ---------------------------------------------------------------------------
export const PUBLIC_KEY = 'oolix:public';
export const PERMISSIONS_KEY = 'oolix:permissions';
export const AGENT_SCOPE_KEY = 'oolix:agentScope';
export const VERIFIED_KEY = 'oolix:requiresVerifiedBusiness';
export const ALLOW_WITHOUT_ORG_KEY = 'oolix:allowWithoutOrganization';

/** No authentication: health probes, JWKS endpoints and the /v1/auth routes. */
export const Public = () => SetMetadata(PUBLIC_KEY, true);

/**
 * §35.1 → §35.2: also admit a signed-in person who belongs to no
 * organization yet, as an OnboardingPrincipal. Only for the few routes that
 * step needs -- reading who you are and creating your first organization --
 * because every other route relies on an organization being present.
 */
export const AllowWithoutOrganization = () => SetMetadata(ALLOW_WITHOUT_ORG_KEY, true);

/** Require a user principal holding every listed permission. */
export const RequirePermissions = (...perms: Permission[]) => SetMetadata(PERMISSIONS_KEY, perms);

/** Require an Agent principal holding this scope (§92.4). */
export const RequireAgentScope = (scope: AgentScope) => SetMetadata(AGENT_SCOPE_KEY, scope);

/** §66.3: require BUSINESS_VERIFIED (campaign submit, supply publication). */
export const RequireVerifiedBusiness = () => SetMetadata(VERIFIED_KEY, true);

export interface AuthenticatedRequest extends FastifyRequest {
  principal?: Principal;
}

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject('Reflector') private readonly reflector: Reflector,
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(CONFIG) private readonly config: OolixConfig,
    @Inject(AgentKeyService) private readonly agentKeys: AgentKeyService,
    @Inject(UserKeyService) private readonly userKeys: UserKeyService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const handler = context.getHandler();
    const cls = context.getClass();

    if (this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, [handler, cls])) return true;

    const req = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const isAgentRoute = req.url.startsWith('/agent/v1');

    const allowWithoutOrg =
      this.reflector.getAllAndOverride<boolean>(ALLOW_WITHOUT_ORG_KEY, [handler, cls]) ?? false;

    const principal = isAgentRoute
      ? await this.authenticateAgent(req)
      : await this.authenticateUser(req, allowWithoutOrg);

    req.principal = principal;

    enrichContext(
      principal.kind === 'user'
        ? { orgId: principal.orgId, userId: principal.userId }
        : principal.kind === 'onboarding'
          ? { userId: principal.userId }
          : { orgId: principal.partnerOrgId, agentId: principal.agentId },
    );

    // --- authorization -----------------------------------------------------
    const agentScope = this.reflector.getAllAndOverride<AgentScope>(AGENT_SCOPE_KEY, [
      handler,
      cls,
    ]);
    if (agentScope) {
      if (principal.kind !== 'agent') {
        throw new OolixError('AUTH_001', 'This endpoint requires a Partner Agent principal.');
      }
      if (!principal.scopes.includes(agentScope)) {
        throw new OolixError('PERM_001', `Agent is missing scope: ${agentScope}`);
      }
      return true;
    }

    const required = this.reflector.getAllAndOverride<Permission[]>(PERMISSIONS_KEY, [
      handler,
      cls,
    ]);
    if (required?.length) {
      if (principal.kind !== 'user') {
        throw new OolixError('PERM_001', 'This endpoint requires a user principal.');
      }
      for (const perm of required) {
        if (!principal.permissions.has(perm)) {
          throw new OolixError('PERM_001', `Missing permission: ${perm}`);
        }
      }
    }

    if (
      this.reflector.getAllAndOverride<boolean>(VERIFIED_KEY, [handler, cls]) &&
      principal.kind === 'user' &&
      !principal.businessVerified
    ) {
      throw new OolixError(
        'PERM_001',
        'This action requires a verified business (spec §66.3). Drafting and browsing remain available.',
      );
    }

    return true;
  }

  // -------------------------------------------------------------------------
  private bearer(req: FastifyRequest): string {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      throw new OolixError('AUTH_001', 'Missing bearer token.');
    }
    return header.slice(7).trim();
  }

  private async authenticateUser(
    req: FastifyRequest,
    allowWithoutOrg: boolean,
  ): Promise<UserPrincipal | OnboardingPrincipal> {
    const token = await verifyUserAccessToken(this.bearer(req), this.userKeys.jwks(), {
      issuer: this.config.API_PUBLIC_URL,
    });

    const user = await this.prisma.user.findFirst({
      where: {
        id: token.userId,
        // The sign-in this token came from must still be live. Signing out, a
        // refresh token presented twice, or the session's absolute end then
        // stop its access tokens on the next call, not only its refresh --
        // otherwise a copied token would outlive a sign-out by ten minutes.
        // An EXISTS inside this same query, so it costs no extra round trip.
        authSessions: {
          some: {
            familyId: token.sessionFamilyId,
            revokedAt: null,
            expiresAt: { gt: new Date() },
          },
        },
      },
      include: {
        memberships: {
          where: { status: 'ACTIVE' as const },
          include: { organization: true },
        },
      },
    });

    if (!user) throw new OolixError('AUTH_001', 'Your session has ended. Please sign in again.');
    // Read per request, so disabling an account takes effect on the next call
    // rather than when its token expires.
    if (user.status === 'DISABLED') throw new OolixError('AUTH_001', 'User is disabled.');
    if (user.status !== 'ACTIVE') {
      throw new OolixError('AUTH_002', 'Confirm your email address before signing in.');
    }
    // A password change or reset signs out every session. Refresh tokens are
    // revoked outright; an access token issued before the change is refused
    // here, so a stolen one dies with the old password instead of living out
    // its ten minutes. Compared in whole seconds, the unit `iat` carries.
    if (
      user.passwordChangedAt &&
      token.issuedAt < Math.floor(user.passwordChangedAt.getTime() / 1000)
    ) {
      throw new OolixError('AUTH_001', 'Your session has ended. Please sign in again.');
    }

    if (user.memberships.length === 0) {
      if (allowWithoutOrg) return { kind: 'onboarding', userId: user.id, email: user.email };
      throw new OolixError('PERM_002', 'Create or join an organization first.');
    }

    // A user may belong to several organizations. X-Org-Id selects which one
    // this request acts within; §34 requires role switching without a second
    // account, and every downstream check is scoped to this single org.
    const requestedOrg = req.headers['x-org-id'];
    const orgId = typeof requestedOrg === 'string' ? requestedOrg : user.memberships[0]!.orgId;

    const memberships = user.memberships.filter((m) => m.orgId === orgId);
    if (memberships.length === 0) {
      throw new OolixError(
        'PERM_002',
        'User is not an active member of the requested organization.',
      );
    }

    const org = memberships[0]!.organization;
    const roles = memberships.map((m) => m.role as Role);

    const networkIds = (
      await this.prisma.networkMembership.findMany({
        where: { orgId, status: 'ACTIVE' },
        select: { networkId: true },
      })
    ).map((n) => n.networkId);

    return {
      kind: 'user',
      userId: user.id,
      authSubject: user.authSubject,
      email: user.email,
      orgId,
      roles,
      permissions: buildUserPermissions(roles),
      networkIds,
      businessVerified: canSubmitOrPublish(org.verificationStatus as never),
    };
  }

  private async authenticateAgent(req: FastifyRequest): Promise<Principal> {
    const agentIdHeader = req.headers['x-agent-id'];
    if (typeof agentIdHeader !== 'string') {
      throw new OolixError('AUTH_001', 'Missing X-Agent-Id header.');
    }

    const verified = await verifyAgentAccessToken(
      this.bearer(req),
      agentIdHeader,
      await this.agentKeys.publicJwks(),
      {
        issuer: this.config.AGENT_TOKEN_ISSUER,
        audience: this.config.AGENT_TOKEN_AUDIENCE,
      },
    );

    // §92.4 steps 4-6: the token is not enough. The Agent record must still be
    // ACTIVE and its Partner must still be active, so revocation takes effect
    // immediately rather than when the 15-minute token expires.
    const agent = await this.prisma.agent.findUnique({
      where: { id: verified.agentId },
      include: { organization: true },
    });

    if (!agent || agent.status !== 'ACTIVE') {
      throw new OolixError('AUTH_001', 'Agent is revoked or unknown.');
    }
    if (agent.partnerOrgId !== verified.partnerOrgId) {
      throw new OolixError('PERM_002', 'Agent partner binding mismatch.');
    }
    if (agent.organization.verificationStatus === 'SUSPENDED') {
      throw new OolixError('PERM_002', 'Partner organization is suspended.');
    }

    return {
      kind: 'agent',
      agentId: agent.id,
      clientId: agent.clientId,
      // §92.4: authoritative, from the registration record.
      partnerOrgId: agent.partnerOrgId,
      scopes: verified.scopes,
      agentVersion: verified.agentVersion,
    };
  }
}
