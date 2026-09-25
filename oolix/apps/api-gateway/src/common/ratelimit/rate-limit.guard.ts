/**
 * Rate limit enforcement -- spec v5 §86, §94.
 *
 * `RateLimitService` implements the window; this guard is what makes it
 * actually apply to traffic. Registered globally and AFTER `AuthGuard`, so the
 * principal is already resolved and the window can be scoped to a caller
 * rather than to an IP that hundreds of users may share behind a corporate
 * NAT.
 *
 * The default class is derived from the route rather than required on every
 * handler. §94 wants every endpoint limited; if the limit were opt-in, the one
 * endpoint someone forgets to annotate is exactly the one that gets abused.
 * `@RateLimit()` overrides the derived class where the spec names a specific
 * budget.
 */
import { CanActivate, ExecutionContext, Inject, Injectable, SetMetadata } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import type { FastifyReply } from 'fastify';
import { createHash } from 'node:crypto';
import { OolixError, type RateLimitClass } from '@oolix/contracts';
import type { AuthenticatedRequest } from '../auth/auth.guard.js';
import { RateLimitService } from './rate-limit.service.js';

export const RATE_LIMIT_KEY = 'oolix:rateLimitClass';

/** Pin a route to a specific §86 budget instead of the derived default. */
export const RateLimit = (cls: RateLimitClass) => SetMetadata(RATE_LIMIT_KEY, cls);

/** Exempt from limiting. Health probes only -- an orchestrator polls these. */
export const NO_RATE_LIMIT_KEY = 'oolix:noRateLimit';

/** Classes counted per client address rather than per signed-in principal. */
const IP_SCOPED: ReadonlySet<RateLimitClass> = new Set([
  'signup',
  'login',
  'passwordReset',
  'emailVerification',
  'authLink',
]);
export const NoRateLimit = () => SetMetadata(NO_RATE_LIMIT_KEY, true);

@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    @Inject(RateLimitService) private readonly limiter: RateLimitService,
    // Injected by token: `Reflector` is a type-only import here, so
    // emitDecoratorMetadata would otherwise record `Object` and Nest could not
    // resolve it. Matches how AuthGuard takes it.
    @Inject('Reflector') private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;

    const exempt = this.reflector.getAllAndOverride<boolean>(NO_RATE_LIMIT_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (exempt) return true;

    const req = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const res = context.switchToHttp().getResponse<FastifyReply>();

    const explicit = this.reflector.getAllAndOverride<RateLimitClass>(RATE_LIMIT_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const cls = explicit ?? deriveClass(req);

    // §86 scopes the signup budget to the IP, not the caller: the whole point
    // is that one actor creating a stream of fresh accounts stays inside one
    // window. Sign-in and recovery work the same way, for the same reason --
    // before authentication there is no caller to scope by.
    const principal = IP_SCOPED.has(cls) ? `ip:${req.ip}` : derivePrincipalKey(req);

    // §94: "production configuration may override by organization without
    // changing code". Overrides live in Redis so raising a Buyer's CRM quota
    // by contract is an ops action, not a deploy.
    const override = await this.limiter.overrideFor(orgOf(req), cls);
    const decision = await this.limiter.consume(principal, cls, override);

    // §94: the standard headers on EVERY response, not only on the 429. A
    // client that can only see its budget once it has already been throttled
    // has no way to pace itself.
    void res.header('X-RateLimit-Limit', String(decision.limit));
    void res.header('X-RateLimit-Remaining', String(decision.remaining));
    void res.header('X-RateLimit-Reset', String(decision.resetAt));

    if (!decision.allowed) {
      void res.header('Retry-After', String(decision.retryAfterSeconds));
      // SYS_001 already carries http 429 + retryable in the §77.2 registry;
      // the filter derives both from the code.
      throw new OolixError('SYS_001', 'Rate limit exceeded.', {
        retryAfterSeconds: decision.retryAfterSeconds,
      });
    }

    return true;
  }
}

/** The organization a per-org limit override would be keyed by, if any. */
export function orgOf(req: AuthenticatedRequest): string | undefined {
  const p = req.principal;
  if (p?.kind === 'user') return p.orgId;
  if (p?.kind === 'agent') return p.partnerOrgId;
  return undefined;
}

/**
 * §94 scopes the window by principal. Falling back to the IP for unauthenticated
 * calls is deliberate: signup and the CRM endpoints are `@Public`, and those are
 * precisely the ones where the limit IS the anti-abuse control.
 */
export function derivePrincipalKey(req: AuthenticatedRequest): string {
  const p = req.principal;
  if (p?.kind === 'agent') return `agent:${p.agentId}`;
  if (p?.kind === 'user') return `user:${p.orgId}:${p.userId}`;
  if (p?.kind === 'onboarding') return `user:none:${p.userId}`;

  // CRM callers present a bearer API key that the HANDLER verifies, not the
  // guard. Hashing the presented key gives a stable window per integration
  // without the guard needing to resolve (or trust) it.
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ')) {
    const digest = createHash('sha256').update(auth.slice(7).trim()).digest('hex');
    return `crm:${digest.slice(0, 32)}`;
  }

  return `ip:${req.ip}`;
}

/** §86's per-endpoint-class budgets, derived from the route shape. */
export function deriveClass(req: AuthenticatedRequest): RateLimitClass {
  const url = req.url.split('?')[0] ?? '';
  const method = req.method.toUpperCase();

  if (url.startsWith('/agent/v1/')) {
    return url.startsWith('/agent/v1/reporting') || url.startsWith('/agent/v1/attribution')
      ? 'agentReporting'
      : 'agentControl';
  }

  if (url.startsWith('/v1/leads/') || url.startsWith('/v1/conversions/')) return 'crmLeadEvents';
  if (url.startsWith('/v1/attribution/click/')) return 'crmLeadEvents';

  // §86: 5 attempts/min. Organization creation is the unauthenticated entry
  // point into the platform, so it gets the signup budget rather than the
  // ordinary write budget.
  if (url === '/v1/organizations' && method === 'POST') return 'signup';

  if (url.startsWith('/v1/catalogue/')) return 'catalogueSearch';

  return method === 'GET' ? 'userRead' : 'campaignWrite';
}
