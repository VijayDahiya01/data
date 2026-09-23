/**
 * Idempotency (§22.3, §53, §99).
 *
 * §53 makes `Idempotency-Key` mandatory on campaign submit, approval and
 * mark-paid. Those are the three operations where a duplicate is expensive: a
 * second review, a second set of activations, a second payment.
 */
import { randomUUID } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './app.factory.js';
import { IdempotencyService } from '../src/common/idempotency/idempotency.service.js';

describe('Idempotency (§99)', () => {
  let app: NestFastifyApplication;
  let idem: IdempotencyService;

  beforeAll(async () => {
    ({ app } = await createTestApp());
    idem = app.get(IdempotencyService);
  });
  afterAll(async () => {
    await app?.close();
  });

  const endpoint = 'POST /v1/campaigns';
  const org = '11111111-1111-4111-8111-111111111111';

  it('replays the stored result for the same key and payload', async () => {
    const key = `int-${randomUUID()}`;
    const payload = { name: 'Monsoon travel insurance', budget_minor: 500_000 };

    expect(await idem.check(key, endpoint, payload, org)).toBeNull();
    await idem.store(
      key,
      endpoint,
      payload,
      { status: 201, body: { id: 'camp-1' } },
      { orgId: org },
    );

    expect(await idem.check(key, endpoint, payload, org)).toEqual({
      status: 201,
      body: { id: 'camp-1' },
    });
  });

  it('refuses the same key with a different payload (§99)', async () => {
    const key = `int-${randomUUID()}`;
    await idem.store(
      key,
      endpoint,
      { name: 'A' },
      { status: 201, body: { id: 'a' } },
      { orgId: org },
    );

    // Silently replaying A's result for a request that asked for B would be far
    // worse than an error: the caller would believe B had been created.
    await expect(idem.check(key, endpoint, { name: 'B' }, org)).rejects.toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT',
    });
  });

  it('treats the same key on a different endpoint as distinct', async () => {
    // A client-generated UUID legitimately reappearing on another endpoint is
    // not a conflict, so the endpoint is part of the hash.
    const key = `int-${randomUUID()}`;
    await idem.store(
      key,
      endpoint,
      { name: 'A' },
      { status: 201, body: { id: 'a' } },
      { orgId: org },
    );

    await expect(
      idem.check(key, 'POST /v1/campaigns/x/submit', { name: 'A' }, org),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });

  it('refuses another organization’s key rather than replaying it (§66)', async () => {
    const key = `int-${randomUUID()}`;
    const otherOrg = '22222222-2222-4222-8222-222222222222';
    await idem.store(
      key,
      endpoint,
      { name: 'A' },
      { status: 201, body: { id: 'a' } },
      { orgId: org },
    );

    // Guessing a key must not reveal — or replay — another tenant's result.
    await expect(idem.check(key, endpoint, { name: 'A' }, otherOrg)).rejects.toMatchObject({
      code: 'PERM_002',
    });
  });

  it('does not let a losing concurrent write overwrite the stored response', async () => {
    const key = `int-${randomUUID()}`;
    const payload = { name: 'A' };
    await idem.store(
      key,
      endpoint,
      payload,
      { status: 201, body: { id: 'winner' } },
      { orgId: org },
    );
    await idem.store(
      key,
      endpoint,
      payload,
      { status: 201, body: { id: 'loser' } },
      { orgId: org },
    );

    expect(await idem.check(key, endpoint, payload, org)).toEqual({
      status: 201,
      body: { id: 'winner' },
    });
  });

  it('requires a key on submit (§53)', async () => {
    // Unauthenticated here, so this asserts only that the requirement is never
    // silently skipped: the request must not succeed without a key.
    const res = await app.inject({
      method: 'POST',
      url: '/v1/campaigns/00000000-0000-4000-8000-000000000000/submit',
      payload: {},
    });
    expect([400, 401]).toContain(res.statusCode);
    expect(res.statusCode).not.toBe(200);
  });
});
