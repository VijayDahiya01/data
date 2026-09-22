/**
 * Append-only audit trail -- spec v5 §25, §51, §56, §83.
 *
 * §56: "Immutable business/security action timeline."
 * §83: every approval, change, rejection and revocation records actor,
 *      timestamp, request_version, policy_version, creative_version, reason.
 *
 * Rows are only ever INSERTed. There is no update or delete method here, and
 * that is intentional: a mutable audit log is not an audit log.
 */
import { Injectable, Inject } from '@nestjs/common';
import { redact } from '@oolix/observability';
import { PrismaService } from '../../prisma/prisma.service.js';
import { currentContext } from '../correlation/correlation.js';

/**
 * Just enough of a Prisma transaction client to write one audit row.
 *
 * `create` is declared as a METHOD rather than a property holding a function,
 * and that is load-bearing. TypeScript checks method parameters bivariantly
 * but property function types contravariantly under `strictFunctionTypes`, so
 * the property form -- `create: (args: unknown) => Promise<unknown>` -- can
 * never accept Prisma's generic `create`, however loose the argument type
 * looks. This interface is structural on purpose: importing Prisma's own
 * `TransactionClient` here would tie the audit trail to the generated client.
 */
export interface AuditTransactionClient {
  auditEvent: {
    create(args: { data: Record<string, unknown> }): Promise<unknown>;
  };
}

export interface AuditInput {
  action: string;
  entityType: string;
  entityId: string;
  orgId?: string | null;
  /** Defaults to the authenticated principal from the request context. */
  actor?: string;
  actorType?: 'USER' | 'AGENT' | 'SYSTEM';
  metadata?: Record<string, unknown>;
}

@Injectable()
export class AuditService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async record(input: AuditInput): Promise<void> {
    const ctx = currentContext();
    const actor = input.actor ?? ctx?.userId ?? ctx?.agentId ?? 'system';
    const actorType = input.actorType ?? (ctx?.userId ? 'USER' : ctx?.agentId ? 'AGENT' : 'SYSTEM');

    await this.prisma.auditEvent.create({
      data: {
        actor,
        actorType,
        orgId: input.orgId ?? ctx?.orgId ?? null,
        entityType: input.entityType,
        entityId: input.entityId,
        action: input.action,
        // §56 / §78.1: the audit trail records WHAT happened, never the
        // person's raw identity or any customer data.
        metadata: redact(input.metadata ?? {}) as never,
        correlationId: ctx?.correlationId ?? null,
      },
    });
  }

  /**
   * Record inside an existing transaction, so the audit row and the state
   * change it describes commit or roll back together. An approval that
   * succeeded without an audit entry would be unprovable.
   */
  async recordTx(tx: AuditTransactionClient, input: AuditInput): Promise<void> {
    const ctx = currentContext();
    await tx.auditEvent.create({
      data: {
        actor: input.actor ?? ctx?.userId ?? ctx?.agentId ?? 'system',
        actorType: input.actorType ?? (ctx?.userId ? 'USER' : ctx?.agentId ? 'AGENT' : 'SYSTEM'),
        orgId: input.orgId ?? ctx?.orgId ?? null,
        entityType: input.entityType,
        entityId: input.entityId,
        action: input.action,
        metadata: redact(input.metadata ?? {}),
        correlationId: ctx?.correlationId ?? null,
      },
    });
  }
}
