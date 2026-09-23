/**
 * Rate limiting (§86 budgets, §94 mechanics, §82 launch control).
 *
 * §82 lists rate limiting as a launch requirement, and a limiter that is
 * configured but not actually reached by traffic satisfies nobody. These tests
 * drive real HTTP through the global guard and read the headers a client would
 * see.
 */
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import Redis from 'ioredis';
import { RATE_LIMITS } from '@oolix/contracts';
import { createTestApp } from './app.factory.js';
import { RateLimitService } from '../src/common/ratelimit/rate-limit.service.js';

describe('Rate limiting (§86, §94)', () => {
  let app: NestFastifyApplication;
  let redis: Redis;

  beforeAll(async () => {
    ({ app } = await createTestApp());
    redis = new Redis(process.env.REDIS_URL!);
  });

  afterAll(async () => {
    await app?.close();
    await redis?.quit();
  });

  // Each test speaks from its own caller address. Clearing shared Redis keys
  // would be enough only if nothing else ever touched them; giving every test
  // its own window makes the isolation structural instead.
  let caller: string;
  let callerId = 0;

  beforeEach(async () => {
    callerId += 1;
    caller = `198.51.100.${callerId}`;
    const keys = await redis.keys('rate_limit:*');
    if (keys.length) await redis.del(...keys);
  });

  const clickFrom = (ip: string, token: string) =>
    app.inject({
      method: 'POST',
      url: `/v1/attribution/click/${token}`,
      payload: {},
      headers: { 'x-forwarded-for': ip },
    });

  const click = (token: string) => clickFrom(caller, token);

  it('advertises the budget on a successful response, not only on the 429', async () => {
    // A client that can only discover its budget after being throttled has no
    // way to pace itself (§94).
    const res = await click('t-first');
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-ratelimit-limit']).toBe(String(RATE_LIMITS.crmLeadEvents));
    expect(Number(res.headers['x-ratelimit-remaining'])).toBe(RATE_LIMITS.crmLeadEvents - 1);
    expect(Number(res.headers['x-ratelimit-reset'])).toBeGreaterThan(0);
  });

  it('returns SYS_001 with retry hints once the window is exhausted', async () => {
    const limit = RATE_LIMITS.crmLeadEvents;
    for (let i = 0; i < limit; i += 1) {
      const res = await click(`t-${i}`);
      expect(res.statusCode).toBe(200);
    }

    const throttled = await click('t-over');
    expect(throttled.statusCode).toBe(429);

    const body = throttled.json();
    expect(body.error.code).toBe('SYS_001');
    expect(body.error.retryable).toBe(true);
    expect(body.error.retry_after_seconds).toBeGreaterThan(0);
    expect(Number(throttled.headers['retry-after'])).toBeGreaterThan(0);
    expect(throttled.headers['x-ratelimit-remaining']).toBe('0');
  });

  it('does not extend a caller’s penalty for a request it already refused', async () => {
    const limit = RATE_LIMITS.crmLeadEvents;
    for (let i = 0; i < limit; i += 1) await click(`t-${i}`);

    const first = await click('rejected-1');
    const second = await click('rejected-2');

    // Both are refused, but the refused calls must not themselves fill the
    // window -- otherwise a client retrying politely can never recover.
    expect(first.statusCode).toBe(429);
    expect(second.statusCode).toBe(429);
    expect(Number(second.headers['retry-after'])).toBeLessThanOrEqual(
      Number(first.headers['retry-after']),
    );
  });

  it('exempts the health probes (§69.2)', async () => {
    // Orchestrators poll these from every node; throttling them would take a
    // healthy deployment out of rotation.
    for (let i = 0; i < 20; i += 1) {
      const res = await app.inject({ method: 'GET', url: '/healthz' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['x-ratelimit-limit']).toBeUndefined();
    }
  });

  it('keys the window per caller, not globally', async () => {
    const limit = RATE_LIMITS.crmLeadEvents;
    for (let i = 0; i < limit; i += 1) await clickFrom('203.0.113.10', `t-${i}`);

    const sameCaller = await clickFrom('203.0.113.10', 't-same');
    const otherCaller = await clickFrom('203.0.113.99', 't-other');

    // One noisy integration must not be able to throttle everybody else.
    expect(sameCaller.statusCode).toBe(429);
    expect(otherCaller.statusCode).toBe(200);
  });

  it('honours a per-organization override without a code change (§94)', async () => {
    // §94: "production configuration may override by organization without
    // changing code." Proven here on the signup class, which is IP-scoped, by
    // reading back what the service resolves.
    const service = app.get(RateLimitService);

    const orgId = '11111111-1111-4111-8111-111111111111';
    await redis.hset(`rate_limit_overrides:${orgId}`, 'signup', '50');
    await expect(service.overrideFor(orgId, 'signup')).resolves.toBe(50);

    // A typo must fall back to the §86 default rather than removing the limit.
    await redis.hset(`rate_limit_overrides:${orgId}`, 'signup', 'unlimited');
    await expect(service.overrideFor(orgId, 'signup')).resolves.toBeUndefined();

    await redis.del(`rate_limit_overrides:${orgId}`);
  });
});
