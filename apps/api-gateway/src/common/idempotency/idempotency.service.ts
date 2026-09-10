/**
 * Idempotency -- spec v5 §22.3, §53, §99.
 *
 * §99 defines the contract precisely:
 *   same key + same logical request  -> return the stored result
 *   same key + different payload     -> 409 IDEMPOTENCY_CONFLICT
 *
 * This matters most where a retry would otherwise duplicate a business
 * outcome: campaign submission, Partner approval, report batches, external
 * audience sync and CRM lead events (§22.3). Duplicating any of those means
 * double-charging a Buyer or double-paying a Partner.
 */
import { Injectable, Inject } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { OolixError, IDEMPOTENCY_RETENTION_HOURS } from '@oolix/contracts';
import { PrismaService } from '../../prisma/prisma.service.js';
import { toBytes } from '../bytes.js';

export interface StoredResult {
  status: number;
  body: unknown;
}

@Injectable()
export class IdempotencyService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /**
   * Hash the request so a replay with different content is detectable.
   *
   * The endpoint is included: the same client-generated UUID legitimately
   * appearing on two different endpoints is not a conflict.
   */
  private hash(endpoint: string, payload: unknown): Uint8Array<ArrayBuffer> {
    return toBytes(
      createHash('sha256')
        .update(endpoint)
        .update(' ')
        .update(JSON.stringify(payload ?? null))
        .digest(),
    );
  }

  /**
   * Return a previously stored response for this key, or null to proceed.
   * Throws IDEMPOTENCY_CONFLICT when the key was used with a different body.
   */
  async check(
    key: string,
    endpoint: string,
    payload: unknown,
    orgId?: string,
  ): Promise<StoredResult | null> {
    const existing = await this.prisma.idempotencyRecord.findUnique({ where: { key } });
    if (!existing) return null;

    // An expired record is treated as absent; the sweeper removes it lazily.
    if (existing.expiresAt.getTime() <= Date.now()) {
      await this.prisma.idempotencyRecord.delete({ where: { key } }).catch(() => undefined);
      return null;
    }

    // Scope check: one organization must not be able to probe or hijack
    // another's idempotency keys by guessing them.
    if (orgId && existing.orgId && existing.orgId !== orgId) {
      throw new OolixError('PERM_002', 'Idempotency key belongs to another organization.');
    }

    const incoming = Buffer.from(this.hash(endpoint, payload));
    if (!incoming.equals(Buffer.from(existing.requestHash))) {
      throw new OolixError(
        'IDEMPOTENCY_CONFLICT',
        'This Idempotency-Key was already used with a different request payload.',
      );
    }

    return { status: existing.responseStatus, body: existing.responseBody };
  }

  /** Persist the outcome so a retry replays it rather than re-executing. */
  async store(
    key: string,
    endpoint: string,
    payload: unknown,
    result: StoredResult,
    opts: { orgId?: string; retentionHours?: number } = {},
  ): Promise<void> {
    const retention = opts.retentionHours ?? IDEMPOTENCY_RETENTION_HOURS;
    const expiresAt = new Date(Date.now() + retention * 3_600_000);

    await this.prisma.idempotencyRecord.upsert({
      where: { key },
      create: {
        key,
        ...(opts.orgId ? { orgId: opts.orgId } : {}),
        endpoint,
        requestHash: this.hash(endpoint, payload),
        responseStatus: result.status,
        responseBody: result.body as never,
        expiresAt,
      },
      // A concurrent duplicate that lost the race must not overwrite the
      // winner's stored response.
      update: {},
    });
  }

  /** Remove expired records. Invoked by the worker's scheduler. */
  async sweep(now: Date = new Date()): Promise<number> {
    const { count } = await this.prisma.idempotencyRecord.deleteMany({
      where: { expiresAt: { lte: now } },
    });
    return count;
  }
}
