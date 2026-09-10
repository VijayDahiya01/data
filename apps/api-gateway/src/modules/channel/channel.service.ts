/**
 * Channel connection management -- spec v5 §17, §47.1-§47.2, §48.1.
 *
 * Oolix records that a relationship exists and what it is allowed to do. It
 * does not hold the credential that exercises it: §17 puts ingestion
 * credentials in the Partner Agent, and this service is the central half of
 * that split.
 *
 * The practical consequence is that "connected" here means "the operator told
 * us these account ids and the provider confirmed these capabilities" -- not
 * "we just used a token successfully". Anything that wants live confirmation
 * has to come from the Agent or from a health check that runs where the
 * credential lives.
 */
import { Inject, Injectable } from '@nestjs/common';
import { OolixError } from '@oolix/contracts';
import type { UserPrincipal } from '@oolix/auth-rbac';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AuditService } from '../../common/audit/audit.service.js';
import type { ProviderParam, UpsertConnectionInput } from './channel.schema.js';

@Injectable()
export class ChannelService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async list(principal: UserPrincipal) {
    const rows = await this.prisma.channelConnection.findMany({
      where: { partnerOrgId: principal.orgId },
      orderBy: { provider: 'asc' },
    });
    return { connections: rows.map((r) => this.toWire(r)) };
  }

  async get(principal: UserPrincipal, provider: ProviderParam) {
    const row = await this.prisma.channelConnection.findUnique({
      where: { partnerOrgId_provider: { partnerOrgId: principal.orgId, provider } },
    });
    if (!row) {
      throw new OolixError('VAL_001', `No ${provider} connection exists for this organization.`);
    }
    return this.toWire(row);
  }

  /**
   * Record or update a connection.
   *
   * Status is derived, never accepted from the caller. An integration that
   * could post `status: CONNECTED` could declare itself eligible without a
   * provider ever having agreed, which is exactly the assumption §15 warns
   * against. A connection with an expiry in the past is EXPIRED regardless of
   * what anyone wanted it to be.
   */
  async upsert(principal: UserPrincipal, provider: ProviderParam, input: UpsertConnectionInput) {
    const expiresAt = input.expires_at ? new Date(input.expires_at) : null;
    const expired = expiresAt !== null && expiresAt.getTime() <= Date.now();
    const status = expired ? 'EXPIRED' : 'CONNECTED';

    const row = await this.prisma.channelConnection.upsert({
      where: { partnerOrgId_provider: { partnerOrgId: principal.orgId, provider } },
      create: {
        partnerOrgId: principal.orgId,
        provider,
        accountIds: input.account_ids as never,
        scopes: input.scopes as never,
        capabilityFlags: input.capability_flags as never,
        expiresAt,
        status,
        statusReason: input.status_reason ?? null,
        lastCheckedAt: new Date(),
      },
      update: {
        accountIds: input.account_ids as never,
        scopes: input.scopes as never,
        capabilityFlags: input.capability_flags as never,
        expiresAt,
        status,
        statusReason: input.status_reason ?? null,
        lastCheckedAt: new Date(),
      },
    });

    await this.audit.record({
      action: 'CHANNEL_CONNECTION_UPDATED',
      entityType: 'channel_connection',
      entityId: row.id,
      orgId: principal.orgId,
      // The account ids are recorded so a later dispute can establish which
      // accounts were in play. The capability flags are recorded because
      // "who said this was allowed, and when" is the question asked after an
      // upload that should not have happened.
      metadata: {
        provider,
        account_ids: input.account_ids,
        scopes: input.scopes,
        capability_flags: input.capability_flags,
        status,
      },
    });

    return this.toWire(row);
  }

  /**
   * §47.14: disconnecting is not merely forgetting.
   *
   * Live activations built on this connection are left for the revocation path
   * to end deliberately; this marks the connection REVOKED so that no NEW
   * eligibility check can pass against it, which is the part that must take
   * effect immediately.
   */
  async disconnect(principal: UserPrincipal, provider: ProviderParam) {
    const row = await this.prisma.channelConnection.findUnique({
      where: { partnerOrgId_provider: { partnerOrgId: principal.orgId, provider } },
    });
    if (!row) {
      throw new OolixError('VAL_001', `No ${provider} connection exists for this organization.`);
    }

    const updated = await this.prisma.channelConnection.update({
      where: { id: row.id },
      data: {
        status: 'REVOKED',
        statusReason: 'Disconnected by the organization.',
        // Capabilities do not survive a disconnect. Leaving them behind would
        // let a reconnection inherit permissions the provider never re-granted.
        capabilityFlags: {} as never,
        scopes: [] as never,
      },
    });

    await this.audit.record({
      action: 'CHANNEL_CONNECTION_REVOKED',
      entityType: 'channel_connection',
      entityId: row.id,
      orgId: principal.orgId,
      metadata: { provider },
    });

    return this.toWire(updated);
  }

  /** The wire shape. There is no credential to omit, by construction. */
  private toWire(row: {
    provider: string;
    status: string;
    accountIds: unknown;
    scopes: unknown;
    capabilityFlags: unknown;
    expiresAt: Date | null;
    lastCheckedAt: Date | null;
    statusReason: string | null;
    updatedAt: Date;
  }) {
    return {
      provider: row.provider,
      status: row.status,
      account_ids: row.accountIds,
      scopes: row.scopes,
      capability_flags: row.capabilityFlags,
      expires_at: row.expiresAt?.toISOString() ?? null,
      last_checked_at: row.lastCheckedAt?.toISOString() ?? null,
      status_reason: row.statusReason,
      updated_at: row.updatedAt.toISOString(),
    };
  }
}
