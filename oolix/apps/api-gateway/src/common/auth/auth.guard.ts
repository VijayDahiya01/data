/**
 * Authentication and authorization guard -- spec v5 §4.2, §56, §66, §82, §92.4.
 *
 * Two independent paths, deliberately never mixed:
 *
 *   /v1/*       user principal, OIDC bearer token
 *   /agent/v1/* agent principal, Oolix-issued workload token + X-Agent-Id
 *
 * The roles a user holds are read from the DATABASE for the active
 * organization, never from a token claim (§4.2: "never trust UI-only role
 * filtering"). An IdP misconfiguration therefore cannot become a privilege
 * escalation inside Oolix.
 */
import { CanActivate, ExecutionContext, Inject, Injectable, SetMetadata } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import { OolixError, canSubmitOrPublish, type Permission, type Role } from '@oolix/contracts';
import {
  buildUserPermissions,
  mfaSatisfied,
  verifyUserToken,
  verifyAgentAccessToken,
  type AgentScope,
  type Principal,
  type UserPrincipal,
} from '@oolix/auth-rbac';
import { MFA_REQUIRED_ROLES } from '@oolix/contracts';
import { PrismaService } from '../../prisma/prisma.service.js';
import { CONFIG, type OolixConfig } from '../../config/configuration.js';
import { enrichContext } from '../correlation/correlation.js';
import { AgentKeyService } from '../../keys/agent-key.service.js';
import { IdentityOrgService } from '../../modules/identity-org/identity-org.service.js';

// ---------------------------------------------------------------------------
// Route metadata decorators
// ---------------------------------------------------------------------------
export const PUBLIC_KEY = 'oolix:public';
export const PERMISSIONS_KEY = 'oolix:permissions';
export const AGENT_SCOPE_KEY = 'oolix:agentScope';
export const VERIFIED_KEY = 'oolix:requiresVerifiedBusiness';

/** No authentication. Health probes and the JWKS endpoint only. */
export const Public = () => SetMetadata(PUBLIC_KEY, true);

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
    @Inject(IdentityOrgService) private readonly identity: IdentityOrgService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const handler = context.getHandler();
    const cls = context.getClass();

    if (this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, [handler, cls])) return true;

    const req = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const isAgentRoute = req.url.startsWith('/agent/v1');

    const principal = isAgentRoute
      ? await this.authenticateAgent(req)
      : await this.authenticateUser(req);

    req.principal = principal;

    enrichContext(
      principal.kind === 'user'
        ? { orgId: principal.orgId, userId: principal.userId }
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

  private async authenticateUser(req: FastifyRequest): Promise<UserPrincipal> {
    const identity = await verifyUserToken(this.bearer(req), {
      issuerUrl: this.config.OIDC_ISSUER_URL,
      audience: this.config.OIDC_AUDIENCE,
    });

    const membershipInclude = {
      memberships: {
        where: { status: 'ACTIVE' as const },
        include: { organization: true },
      },
    };

    let user = await this.prisma.user.findUnique({
      where: { authSubject: identity.authSubject },
      include: membershipInclude,
    });

    // First login for an invited or seeded user (§35, §66).
    //
    // The row was created ahead of time keyed by email with a placeholder
    // subject; this binds the real OIDC subject to it. Requiring a VERIFIED
    // email is what makes the binding safe -- otherwise anyone who could
    // register that address at the IdP would inherit the invitation.
    if (!user && identity.emailVerified) {
      const linked = await this.identity.linkAuthSubject(
        identity.email,
        identity.authSubject,
        identity.name,
      );
      if (linked) {
        user = await this.prisma.user.findUnique({
          where: { id: linked.id },
          include: membershipInclude,
        });
      }
    }

    if (!user) throw new OolixError('AUTH_001', 'No Oolix user for this identity.');
    if (user.status === 'DISABLED') throw new OolixError('AUTH_001', 'User is disabled.');
    if (user.memberships.length === 0) {
      throw new OolixError('PERM_002', 'User belongs to no active organization.');
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

    // §4.2 / §82: MFA for privileged roles.
    const needsMfa = roles.some((r) => MFA_REQUIRED_ROLES.includes(r));
    const mfaOk = mfaSatisfied(identity);
    if (needsMfa && !mfaOk && this.config.APP_ENV === 'production') {
      throw new OolixError(
        'AUTH_001',
        'Multi-factor authentication is required for this role (spec §4.2, §82).',
      );
    }

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
      mfaSatisfied: mfaOk,
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
