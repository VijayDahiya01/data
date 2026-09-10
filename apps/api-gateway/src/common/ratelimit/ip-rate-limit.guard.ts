/**
 * A coarse per-IP bound, applied before authentication (§94).
 *
 * The per-principal limiter cannot help here: it runs after AuthGuard, so a
 * request that never authenticates never reaches it. A probe confirmed the
 * consequence -- 150 unauthenticated requests in a burst drew no 429 and no
 * rate-limit headers at all. Credential stuffing and plain 401 floods were
 * unlimited.
 *
 * This does not replace the per-principal limits, which remain the real
 * policy. It is an outer bound, set well above what a legitimate office behind
 * one NAT address would use, so that an unauthenticated flood cannot occupy the
 * connection pool indefinitely.
 *
 * It honours @NoRateLimit, so liveness probes stay exempt: an orchestrator
 * polling /healthz from every node must never be throttled out of rotation.
 */
import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { OolixError } from '@oolix/contracts';
import { RateLimitService } from './rate-limit.service.js';
import { NO_RATE_LIMIT_KEY } from './rate-limit.guard.js';

@Injectable()
export class IpRateLimitGuard implements CanActivate {
  constructor(
    @Inject(RateLimitService) private readonly limiter: RateLimitService,
    @Inject('Reflector') private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;

    const exempt = this.reflector.getAllAndOverride<boolean>(NO_RATE_LIMIT_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (exempt) return true;

    const req = context.switchToHttp().getRequest<FastifyRequest>();
    const res = context.switchToHttp().getResponse<FastifyReply>();

    // req.ip already accounts for the trusted proxy: the server is configured
    // with trustProxy, so behind the TLS terminator this is the real client
    // rather than the proxy's own address. Without that, every request in the
    // deployment would share one bucket.
    const decision = await this.limiter.consume(`ip:${req.ip}`, 'anonymousIp');

    if (!decision.allowed) {
      void res.header('Retry-After', String(decision.retryAfterSeconds));
      throw new OolixError('SYS_001', 'Rate limit exceeded.', {
        retryAfterSeconds: decision.retryAfterSeconds,
      });
    }
    return true;
  }
}
