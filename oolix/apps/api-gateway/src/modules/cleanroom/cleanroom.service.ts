/**
 * The cross-Partner clean room, from Oolix's side (docs/DESIGN-PARTNER-DATA.md
 * phase 7).
 *
 * Oolix arranges runs between two Partners who both take part, and carries
 * what passes between their Agents and the clean room -- an AWS Nitro Enclave
 * that counts the customers they share. Everything Oolix carries is sealed to
 * one or the other, and Oolix holds no key that opens it: each Agent checks
 * the clean room's attestation before sealing, and a joint audience comes back
 * sealed to the Agent that asked for it. The sealed inputs wait in Redis for
 * an hour at most; the database keeps who, what and a size band.
 *
 * Every run needs the other Partner's approval: an overlap count tells each
 * side something about the other's customers, however coarse.
 */
import { Inject, Injectable, Optional } from '@nestjs/common';
import type Redis from 'ioredis';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { OolixError } from '@oolix/contracts';
import type { OolixLogger } from '@oolix/observability';
import { CONFIG, type OolixConfig } from '../../config/configuration.js';
import { LOGGER } from '../../common/logging/logger.provider.js';
import { REDIS } from '../../common/redis/redis.token.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AuditService } from '../../common/audit/audit.service.js';

export const ParticipationSchema = z.object({ enabled: z.boolean() });
export const RequestRunSchema = z.object({
  kind: z.enum(['OVERLAP', 'JOINT']),
  with_org_id: z.string().uuid(),
});
export const DecisionSchema = z.object({ approve: z.boolean() });
/** An input of up to 256 parts of 512 KiB: some two million customers. */
const MAX_PARTS = 256;
/** One part of an Agent's sealed input, in base64; the API takes 1 MB bodies. */
export const InputPartSchema = z.object({
  parts: z.number().int().min(1).max(MAX_PARTS),
  data: z.string().min(1).max(700_000),
  recipient: z.string().max(64).optional(),
});
export type RequestRunInput = z.infer<typeof RequestRunSchema>;
export type InputPart = z.infer<typeof InputPartSchema>;

/** How the API reaches the clean room; tests pass a fake. */
export type CleanRoomFetch = typeof fetch;
export const CLEANROOM_FETCH = Symbol('OOLIX_CLEANROOM_FETCH');

const INPUT_TTL_SEC = 3600;
const RESULT_TTL_SEC = 86_400;

interface Run {
  id: string;
  kind: string;
  requestedBy: string;
  withOrg: string;
  status: string;
}

@Injectable()
export class CleanRoomService {
  private readonly fetch: CleanRoomFetch;
  private attestationCache: { doc: string; at: number } | null = null;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(CONFIG) private readonly config: OolixConfig,
    @Inject(LOGGER) private readonly logger: OolixLogger,
    @Optional() @Inject(CLEANROOM_FETCH) fetchImpl?: CleanRoomFetch,
  ) {
    this.fetch = fetchImpl ?? fetch;
  }

  get available(): boolean {
    return Boolean(this.config.CLEANROOM_URL);
  }

  private requireAvailable() {
    if (!this.available) {
      throw new OolixError(
        'SYS_002',
        'The clean room is not switched on for this Oolix deployment.',
      );
    }
  }

  // --- the Partner's side ---------------------------------------------------

  /** Whether this Partner takes part, and who else does. */
  async status(orgId: string) {
    const [mine, others] = await Promise.all([
      this.prisma.partnerProfile.findUnique({ where: { orgId } }),
      this.prisma.partnerProfile.findMany({
        where: {
          crossPartnerMatching: true,
          orgId: { not: orgId },
          organization: {
            verificationStatus: { in: ['BUSINESS_VERIFIED', 'ROLE_ONBOARDING', 'ACTIVE'] },
          },
        },
        include: { organization: { select: { id: true, name: true } } },
        orderBy: { orgId: 'asc' },
      }),
    ]);
    return {
      available: this.available,
      enabled: mine?.crossPartnerMatching ?? false,
      partners: others.map((p) => ({ org_id: p.organization.id, name: p.organization.name })),
    };
  }

  async setParticipation(orgId: string, enabled: boolean) {
    await this.prisma.partnerProfile.update({
      where: { orgId },
      data: { crossPartnerMatching: enabled, crossPartnerMatchingAt: enabled ? new Date() : null },
    });
    await this.audit.record({
      action: enabled ? 'CLEAN_ROOM_JOINED' : 'CLEAN_ROOM_LEFT',
      entityType: 'organization',
      entityId: orgId,
      orgId,
    });
    return this.status(orgId);
  }

  /** Asks another taking-part Partner for a run; it must approve. */
  async request(orgId: string, input: RequestRunInput) {
    this.requireAvailable();
    if (input.with_org_id === orgId) {
      throw new OolixError('VAL_001', 'Choose another Partner.');
    }
    const both = await this.prisma.partnerProfile.count({
      where: { orgId: { in: [orgId, input.with_org_id] }, crossPartnerMatching: true },
    });
    if (both !== 2) {
      throw new OolixError('PERM_002', 'Both Partners have to take part in the clean room.');
    }
    const run = await this.prisma.cleanRoomRun.create({
      data: {
        kind: input.kind,
        requestedBy: orgId,
        withOrg: input.with_org_id,
        status: 'WAITING_APPROVAL',
      },
    });
    await this.audit.record({
      action: 'CLEAN_ROOM_RUN_REQUESTED',
      entityType: 'clean_room_run',
      entityId: run.id,
      orgId,
      metadata: { kind: input.kind, with_org_id: input.with_org_id },
    });
    return this.view(run, orgId);
  }

  /** The asked Partner approves or declines. */
  async decide(orgId: string, runId: string, approve: boolean) {
    const run = await this.prisma.cleanRoomRun.findUnique({ where: { id: runId } });
    if (!run || run.withOrg !== orgId) {
      throw new OolixError('PART_001', 'No such run waiting for you.');
    }
    if (run.status !== 'WAITING_APPROVAL') {
      throw new OolixError('CAMP_002', 'This run has been decided already.');
    }
    const updated = await this.prisma.cleanRoomRun.update({
      where: { id: runId },
      data: { status: approve ? 'WAITING_INPUTS' : 'DECLINED', decidedAt: new Date() },
    });
    await this.audit.record({
      action: approve ? 'CLEAN_ROOM_RUN_APPROVED' : 'CLEAN_ROOM_RUN_DECLINED',
      entityType: 'clean_room_run',
      entityId: runId,
      orgId,
    });
    return this.view(updated, orgId);
  }

  async runs(orgId: string) {
    const rows = await this.prisma.cleanRoomRun.findMany({
      where: { OR: [{ requestedBy: orgId }, { withOrg: orgId }] },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    const names = await this.names(rows.flatMap((r) => [r.requestedBy, r.withOrg]));
    return { items: rows.map((r) => this.view(r, orgId, names)) };
  }

  private async names(ids: string[]) {
    const orgs = await this.prisma.organization.findMany({
      where: { id: { in: [...new Set(ids)] } },
      select: { id: true, name: true },
    });
    return new Map(orgs.map((o) => [o.id, o.name]));
  }

  private view(
    r: Run & { resultJson?: unknown; createdAt?: Date; finishedAt?: Date | null },
    orgId: string,
    names = new Map<string, string>(),
  ) {
    const other = r.requestedBy === orgId ? r.withOrg : r.requestedBy;
    const result = (r.resultJson ?? null) as { pairs?: { band: string }[]; band?: string } | null;
    return {
      id: r.id,
      kind: r.kind,
      status: r.status,
      role: r.requestedBy === orgId ? 'REQUESTED' : 'ASKED',
      with: { org_id: other, name: names.get(other) ?? null },
      band: result?.band ?? result?.pairs?.[0]?.band ?? null,
      created_at: r.createdAt?.toISOString() ?? null,
      finished_at: r.finishedAt?.toISOString() ?? null,
    };
  }

  // --- the Agent's side -----------------------------------------------------

  /** The clean room's attestation, fetched fresh every ten minutes. */
  private async attestation(): Promise<string> {
    if (this.attestationCache && Date.now() - this.attestationCache.at < 10 * 60_000) {
      return this.attestationCache.doc;
    }
    const nonce = randomBytes(32).toString('hex');
    const res = await this.fetch(`${this.config.CLEANROOM_URL}/attestation?nonce=${nonce}`);
    if (!res.ok) throw new OolixError('SYS_002', 'The clean room did not answer.');
    const doc = Buffer.from(await res.arrayBuffer()).toString('base64');
    this.attestationCache = { doc, at: Date.now() };
    return doc;
  }

  private key(run: string, org: string, part: number | 'done' | 'recipient') {
    return `cleanroom:${run}:${org}:${part}`;
  }

  /** Runs waiting for this Partner's customers, with whom to seal them to. */
  async tasks(partnerOrgId: string) {
    if (!this.available) return { tasks: [] };
    const runs = await this.prisma.cleanRoomRun.findMany({
      where: {
        status: 'WAITING_INPUTS',
        OR: [{ requestedBy: partnerOrgId }, { withOrg: partnerOrgId }],
      },
    });
    const open: Run[] = [];
    for (const r of runs) {
      if (!(await this.redis.exists(this.key(r.id, partnerOrgId, 'done')))) open.push(r);
    }
    if (open.length === 0) return { tasks: [] };
    const attestation = await this.attestation();
    return {
      tasks: open.map((r) => ({
        run_id: r.id,
        kind: r.kind,
        role: r.requestedBy === partnerOrgId ? 'base' : 'other',
        attestation,
      })),
    };
  }

  /** One part of this Partner's sealed input; the last completes it. */
  async submitPart(partnerOrgId: string, runId: string, index: number, part: InputPart) {
    const run = await this.prisma.cleanRoomRun.findUnique({ where: { id: runId } });
    if (!run || (run.requestedBy !== partnerOrgId && run.withOrg !== partnerOrgId)) {
      throw new OolixError('PART_001', 'No such run for this Partner.');
    }
    if (run.status !== 'WAITING_INPUTS') {
      throw new OolixError('CAMP_002', 'This run is not waiting for input.');
    }
    if (!Number.isInteger(index) || index < 0 || index >= part.parts) {
      throw new OolixError('VAL_001', 'The part number is out of range.');
    }
    await this.redis.setex(this.key(runId, partnerOrgId, index), INPUT_TTL_SEC, part.data);
    if (part.recipient && run.kind === 'JOINT' && run.requestedBy === partnerOrgId) {
      await this.redis.setex(
        this.key(runId, partnerOrgId, 'recipient'),
        INPUT_TTL_SEC,
        part.recipient,
      );
    }
    if (index !== part.parts - 1) return { received: index + 1, of: part.parts };

    const keys = Array.from({ length: part.parts }, (_, i) => this.key(runId, partnerOrgId, i));
    if ((await this.redis.mget(...keys)).some((v) => v === null)) {
      throw new OolixError('VAL_001', 'Some parts are missing; send them all again.');
    }
    await this.redis.setex(
      this.key(runId, partnerOrgId, 'done'),
      INPUT_TTL_SEC,
      String(part.parts),
    );
    const other = run.requestedBy === partnerOrgId ? run.withOrg : run.requestedBy;
    if (await this.redis.exists(this.key(runId, other, 'done'))) {
      // Both are in: count, without holding the Agent's request open.
      void this.execute(run);
    }
    return { received: part.parts, of: part.parts };
  }

  private async input(run: Run, org: string): Promise<string> {
    const parts = Number(await this.redis.get(this.key(run.id, org, 'done')));
    const values = await this.redis.mget(
      ...Array.from({ length: parts }, (_, i) => this.key(run.id, org, i)),
    );
    return Buffer.concat(values.map((v) => Buffer.from(v ?? '', 'base64'))).toString('base64');
  }

  /** Sends both inputs to the clean room and keeps its answer. */
  async execute(run: Run): Promise<void> {
    try {
      const base = { partner: run.requestedBy, sealed: await this.input(run, run.requestedBy) };
      const other = { partner: run.withOrg, sealed: await this.input(run, run.withOrg) };
      const joint = run.kind === 'JOINT';
      const body = joint
        ? {
            run_id: run.id,
            base,
            other,
            recipient: await this.redis.get(this.key(run.id, run.requestedBy, 'recipient')),
          }
        : { run_id: run.id, inputs: [base, other] };
      const res = await this.fetch(
        `${this.config.CLEANROOM_URL}/v1/${joint ? 'joint' : 'overlap'}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
      );
      if (!res.ok)
        throw new Error(
          `the clean room answered ${res.status}: ${(await res.text()).slice(0, 200)}`,
        );
      const signed = (await res.json()) as { payload: string; signature: string };
      const answer = JSON.parse(Buffer.from(signed.payload, 'base64').toString('utf8')) as {
        run_id: string;
        pairs?: { a: string; b: string; band: string }[];
        band?: string;
        sealed?: string;
      };
      if (answer.run_id !== run.id) throw new Error('the clean room answered for another run');
      if (answer.sealed) {
        await this.redis.setex(`cleanroom:result:${run.id}`, RESULT_TTL_SEC, answer.sealed);
      }
      await this.prisma.cleanRoomRun.update({
        where: { id: run.id },
        data: {
          status: 'DONE',
          finishedAt: new Date(),
          resultJson: {
            ...(answer.pairs
              ? { pairs: answer.pairs.map((p) => ({ a: p.a, b: p.b, band: p.band })) }
              : {}),
            ...(answer.band ? { band: answer.band } : {}),
            // The clean room's own words, for anyone who wants to check
            // them against the key its attestation names.
            signed: { payload: signed.payload, signature: signed.signature },
          },
        },
      });
      await this.audit.record({
        action: 'CLEAN_ROOM_RUN_DONE',
        entityType: 'clean_room_run',
        entityId: run.id,
        orgId: run.requestedBy,
        actorType: 'SYSTEM',
      });
    } catch (err) {
      this.logger.error('clean_room_run_failed', { run_id: run.id, error: (err as Error).message });
      await this.prisma.cleanRoomRun.update({
        where: { id: run.id },
        data: {
          status: 'FAILED',
          finishedAt: new Date(),
          error: (err as Error).message.slice(0, 500),
        },
      });
    } finally {
      await this.dropInputs(run);
    }
  }

  /** Forgets the sealed inputs: every part, by name. */
  private async dropInputs(run: Run) {
    const keys: string[] = [this.key(run.id, run.requestedBy, 'recipient')];
    for (const org of [run.requestedBy, run.withOrg]) {
      const parts = Number(await this.redis.get(this.key(run.id, org, 'done'))) || 0;
      keys.push(this.key(run.id, org, 'done'));
      for (let i = 0; i < parts; i++) keys.push(this.key(run.id, org, i));
    }
    await this.redis.del(...keys);
  }

  /** Joint audiences sealed to this Partner's Agent. */
  async results(partnerOrgId: string) {
    const runs = await this.prisma.cleanRoomRun.findMany({
      where: { kind: 'JOINT', status: 'DONE', requestedBy: partnerOrgId },
      orderBy: { finishedAt: 'desc' },
      take: 20,
    });
    const results: { run_id: string; sealed: string }[] = [];
    for (const r of runs) {
      const sealed = await this.redis.get(`cleanroom:result:${r.id}`);
      if (sealed) results.push({ run_id: r.id, sealed });
    }
    return { results };
  }

  /** The Agent has its joint audience: Oolix drops the sealed copy. */
  async ack(partnerOrgId: string, runId: string) {
    const run = await this.prisma.cleanRoomRun.findUnique({ where: { id: runId } });
    if (!run || run.requestedBy !== partnerOrgId) {
      throw new OolixError('PART_001', 'No such run for this Partner.');
    }
    await this.redis.del(`cleanroom:result:${runId}`);
    return { ok: true };
  }
}
