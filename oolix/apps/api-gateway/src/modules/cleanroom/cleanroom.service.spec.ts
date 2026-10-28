import type Redis from 'ioredis';
import type { OolixLogger } from '@oolix/observability';
import type { OolixConfig } from '../../config/configuration.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { AuditService } from '../../common/audit/audit.service.js';
import { CleanRoomService, type CleanRoomFetch } from './cleanroom.service.js';

/** Redis, as far as the clean room uses it. */
function fakeRedis() {
  const m = new Map<string, string>();
  return {
    store: m,
    redis: {
      setex: async (k: string, _ttl: number, v: string) => void m.set(k, v),
      get: async (k: string) => m.get(k) ?? null,
      mget: async (...ks: string[]) => ks.map((k) => m.get(k) ?? null),
      exists: async (k: string) => (m.has(k) ? 1 : 0),
      del: async (...ks: string[]) => ks.forEach((k) => m.delete(k)),
    } as unknown as Redis,
  };
}

const run = {
  id: 'run-1',
  kind: 'JOINT',
  requestedBy: 'org-a',
  withOrg: 'org-b',
  status: 'WAITING_INPUTS',
};

function setup(answer: object) {
  const { store, redis } = fakeRedis();
  const updates: Record<string, unknown>[] = [];
  const prisma = {
    cleanRoomRun: {
      findUnique: async () => run,
      findMany: async () => [{ ...run, status: 'DONE' }],
      update: async ({ data }: { data: Record<string, unknown> }) => {
        updates.push(data);
        return { ...run, ...data };
      },
    },
  } as unknown as PrismaService;
  const sent: { url: string; body: Record<string, unknown> }[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    sent.push({ url, body: JSON.parse(String(init?.body)) });
    const payload = Buffer.from(JSON.stringify(answer)).toString('base64');
    return new Response(JSON.stringify({ payload, signature: 'c2ln' }), { status: 200 });
  }) as unknown as CleanRoomFetch;
  const svc = new CleanRoomService(
    prisma,
    { record: async () => {} } as unknown as AuditService,
    redis,
    { CLEANROOM_URL: 'http://cleanroom.test' } as OolixConfig,
    { error: () => {}, warn: () => {}, info: () => {} } as unknown as OolixLogger,
    fetchImpl,
  );
  return { svc, store, updates, sent };
}

const b64 = (s: string) => Buffer.from(s).toString('base64');

describe('CleanRoomService', () => {
  it('assembles each Agent’s parts, runs once both are in, and forgets the inputs', async () => {
    const { svc, store, updates, sent } = setup({
      run_id: 'run-1',
      kind: 'joint',
      band: '1K_TO_10K',
      sealed: 'c2VhbGVk',
    });
    await svc.submitPart('org-a', 'run-1', 0, { parts: 2, data: b64('sealed-') });
    await svc.submitPart('org-a', 'run-1', 1, {
      parts: 2,
      data: b64('for-a'),
      recipient: b64('agent-a-key'),
    });
    expect(sent).toHaveLength(0); // org-b has not sent yet
    await svc.submitPart('org-b', 'run-1', 0, { parts: 1, data: b64('for-b') });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe('http://cleanroom.test/v1/joint');
    const body = sent[0]!.body as {
      base: { sealed: string };
      other: { sealed: string };
      recipient: string;
    };
    expect(Buffer.from(body.base.sealed, 'base64').toString()).toBe('sealed-for-a');
    expect(Buffer.from(body.other.sealed, 'base64').toString()).toBe('for-b');
    expect(body.recipient).toBe(b64('agent-a-key'));

    expect(updates.at(-1)).toMatchObject({ status: 'DONE', resultJson: { band: '1K_TO_10K' } });
    // Only the sealed result waits, for org-a's Agent.
    expect([...store.keys()]).toEqual(['cleanroom:result:run-1']);
    expect(await svc.results('org-a')).toEqual({
      results: [{ run_id: 'run-1', sealed: 'c2VhbGVk' }],
    });
    await svc.ack('org-a', 'run-1');
    expect(store.size).toBe(0);
  });

  it('refuses parts out of range and a Partner not in the run', async () => {
    const { svc } = setup({});
    await expect(
      svc.submitPart('org-a', 'run-1', 3, { parts: 2, data: b64('x') }),
    ).rejects.toMatchObject({
      code: 'VAL_001',
    });
    await expect(
      svc.submitPart('org-z', 'run-1', 0, { parts: 1, data: b64('x') }),
    ).rejects.toMatchObject({
      code: 'PART_001',
    });
  });

  it('records a run the clean room could not answer', async () => {
    const { svc, updates } = setup({ run_id: 'another-run' });
    await svc.submitPart('org-a', 'run-1', 0, { parts: 1, data: b64('a') });
    await svc.submitPart('org-b', 'run-1', 0, { parts: 1, data: b64('b') });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(updates.at(-1)).toMatchObject({ status: 'FAILED' });
  });
});
