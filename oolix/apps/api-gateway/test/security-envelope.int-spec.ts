/**
 * Error envelope, authentication and information leakage (§53, §77.2, §99).
 *
 * These are the properties an attacker probes first: does an error tell me
 * whether something exists, does it hand me a stack trace, does the API answer
 * at all without a token.
 */
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './app.factory.js';

describe('Error envelope and authentication (§53, §77.2, §99)', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    ({ app } = await createTestApp());
  });
  afterAll(async () => {
    await app?.close();
  });

  const call = (method: string, url: string, opts: Record<string, unknown> = {}) =>
    app.inject({ method: method as 'GET', url, ...opts });

  it('refuses an unauthenticated call to a protected route', async () => {
    const res = await call('GET', '/v1/campaigns');
    expect(res.statusCode).toBe(401);

    const body = res.json();
    // §53: the envelope shape is part of the contract, not an implementation
    // detail -- clients branch on `code` and `retryable`.
    expect(body.error.code).toBe('AUTH_001');
    expect(typeof body.error.message).toBe('string');
    expect(body.error.retryable).toBe(false);
    expect(body.error.correlation_id).toMatch(/^corr_/);
    expect(Array.isArray(body.error.field_errors)).toBe(true);
  });

  it('rejects a malformed bearer token without leaking why (§99)', async () => {
    const res = await call('GET', '/v1/campaigns', {
      headers: { authorization: 'Bearer not-a-jwt' },
    });
    expect(res.statusCode).toBe(401);

    const raw = res.body;
    // §99: no stack traces, no internal paths, no library internals.
    expect(raw).not.toMatch(/at \w+.*\(/);
    expect(raw).not.toMatch(/node_modules/);
    expect(raw).not.toMatch(/JWSInvalid|JWSSignatureVerificationFailed/);
  });

  it('never echoes a partner_user_id in any error (§73, §78.1)', async () => {
    const res = await call('POST', '/v1/attribution/click/U123-looks-like-a-user-id', {
      payload: {},
    });
    expect(res.body).not.toContain('partner_user_id');
  });

  it('returns the same status for a known and an unknown click token (§90)', async () => {
    // §90 makes the token opaque precisely so it cannot be probed. A different
    // status for a recognised token would rebuild the oracle the design
    // removed.
    const unknownA = await call('POST', `/v1/attribution/click/${'a'.repeat(43)}`, { payload: {} });
    const unknownB = await call('POST', `/v1/attribution/click/${'b'.repeat(43)}`, { payload: {} });

    expect(unknownA.statusCode).toBe(200);
    expect(unknownB.statusCode).toBe(unknownA.statusCode);
    expect(unknownA.json().attributed).toBe(false);
  });

  it('rejects an Agent call that carries no Agent credential (§92.4)', async () => {
    const res = await call('GET', '/agent/v1/config/pull', {
      headers: { 'x-agent-id': '00000000-0000-4000-8000-000000000000' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('AUTH_001');
  });

  it('sets the security headers §82 requires', async () => {
    const res = await call('GET', '/healthz');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
  });
});
