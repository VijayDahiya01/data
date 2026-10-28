/**
 * Long-poll wake-ups through the real Redis: a request waiting for work is
 * answered as soon as work is announced -- on any API instance -- and
 * otherwise ends on time.
 */
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './app.factory.js';
import { Wakeups } from '../src/common/redis/wakeups.js';

describe('Wakeups', () => {
  let app: NestFastifyApplication;
  let wakeups: Wakeups;

  beforeAll(async () => {
    ({ app } = await createTestApp());
    wakeups = app.get(Wakeups);
    // The subscription is made at start-up; give it a moment to be live.
    await new Promise((r) => setTimeout(r, 300));
  });

  afterAll(async () => {
    await app?.close();
  });

  it('wakes a waiting request when work is announced', async () => {
    const started = Date.now();
    const waiting = wakeups.wait('estimates:org-a', 10_000);
    setTimeout(() => void wakeups.notify('estimates:org-a'), 200);
    await waiting.done;
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it('does not wake a request waiting on another Partner', async () => {
    const started = Date.now();
    const waiting = wakeups.wait('estimates:org-b', 600);
    await wakeups.notify('estimates:org-c');
    await waiting.done;
    expect(Date.now() - started).toBeGreaterThanOrEqual(550);
  });

  it('can stop waiting early', async () => {
    const started = Date.now();
    const waiting = wakeups.wait('estimates:org-d', 10_000);
    waiting.cancel();
    await waiting.done;
    expect(Date.now() - started).toBeLessThan(500);
  });
});
