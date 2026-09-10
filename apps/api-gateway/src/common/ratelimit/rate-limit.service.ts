/**
 * Rate limiting -- spec v5 §86, §94.
 *
 * §94 fixes the mechanics: Redis-backed, rolling 60-second window, key scoped
 * by principal + endpoint class, and a 429 that carries the standard headers
 * plus a SYS_001 envelope.
 *
 * The window is implemented as a sorted set of request timestamps rather than
 * a fixed-window counter, because a fixed window lets a caller send 2x the
 * limit across a boundary -- which matters for the signup endpoint (§86: 5
 * attempts/min) where the limit IS the anti-abuse control.
 */
import { Injectable, Inject } from '@nestjs/common';
import type Redis from 'ioredis';
import { RATE_LIMITS, type RateLimitClass } from '@oolix/contracts';
import { REDIS } from '../redis/redis.provider.js';

export interface RateLimitDecision {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Unix seconds when the window frees up. */
  resetAt: number;
  retryAfterSeconds: number;
}

const WINDOW_MS = 60_000;

@Injectable()
export class RateLimitService {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  /**
   * Per-organization limit override (§94: "production configuration may
   * override by organization without changing code").
   *
   * Held in Redis rather than in the schema so raising a Buyer's CRM quota
   * under an approved contract (§86) is an ops action taking effect at once,
   * not a migration and a deploy. An absent or unparseable value falls back to
   * the §86 default -- a typo in an ops command must not remove a limit.
   */
  async overrideFor(orgId: string | undefined, cls: RateLimitClass): Promise<number | undefined> {
    if (!orgId) return undefined;
    const raw = await this.redis.hget(`rate_limit_overrides:${orgId}`, cls);
    if (raw === null) return undefined;
    const value = Number(raw);
    return Number.isInteger(value) && value > 0 ? value : undefined;
  }

  /**
   * `principal` is the org+user pair for user calls, the agent_id for Agent
   * calls, the integration id for CRM calls, or the client IP for signup
   * (§94). Callers pass whatever identity the endpoint class is scoped by.
   */
  async consume(
    principal: string,
    cls: RateLimitClass,
    overrideLimit?: number,
  ): Promise<RateLimitDecision> {
    const limit = overrideLimit ?? RATE_LIMITS[cls];
    const key = `rate_limit:${principal}:${cls}`;
    const now = Date.now();
    const windowStart = now - WINDOW_MS;

    // One round trip: drop expired entries, add this request, count, re-arm
    // the TTL. Non-atomic variants leak keys when a process dies mid-sequence.
    const pipeline = this.redis.multi();
    pipeline.zremrangebyscore(key, 0, windowStart);
    pipeline.zadd(key, now, `${now}-${Math.random().toString(36).slice(2, 10)}`);
    pipeline.zcard(key);
    pipeline.pexpire(key, WINDOW_MS);
    const results = await pipeline.exec();

    const count = Number(results?.[2]?.[1] ?? 0);
    const allowed = count <= limit;

    if (!allowed) {
      // The offending request was already added; remove it so a rejected call
      // does not extend the caller's own penalty window.
      await this.redis.zremrangebyrank(key, -1, -1);
    }

    // Each member is `${timestamp}-${nonce}`, so the oldest entry's timestamp
    // is readable from the member itself. Reading it this way avoids the
    // WITHSCORES overload and keeps the call to a single, simply-typed round
    // trip.
    const [oldestMember] = await this.redis.zrange(key, '0', '0');
    const oldestTs = oldestMember ? Number(oldestMember.split('-')[0]) : now;
    const resetMs = (Number.isFinite(oldestTs) ? oldestTs : now) + WINDOW_MS;

    return {
      allowed,
      limit,
      remaining: Math.max(0, limit - count),
      resetAt: Math.ceil(resetMs / 1000),
      retryAfterSeconds: Math.max(1, Math.ceil((resetMs - now) / 1000)),
    };
  }
}
