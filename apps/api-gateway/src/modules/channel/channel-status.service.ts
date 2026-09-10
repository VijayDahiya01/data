/**
 * Recording what an Agent did with an external audience -- §47.11, §48.9.
 *
 * The Agent is the only party that can see the upload happen, so this is the
 * control plane's only view of whether an external activation is actually
 * delivering. Everything it accepts is a resource id, a status and two counts.
 *
 * # Why the activation status moves too
 *
 * An activation that is READY has permission to upload; one that is LIVE has
 * actually done so. Without that distinction the portal cannot tell a Buyer
 * whether their campaign is running on Meta, and "approved" would be the last
 * thing anyone could say about it.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { OolixError } from '@oolix/contracts';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AuditService } from '../../common/audit/audit.service.js';
import type { ReportChannelSyncInput } from './channel-status.schema.js';

/**
 * How an external sync status maps onto the activation's own state (§76).
 *
 * Only the states that genuinely change what the activation IS appear here.
 * PREPARING and UPLOADING are progress, not a change of state, and moving the
 * activation for them would produce a status that flickers.
 */
const ACTIVATION_STATE_FOR: Record<string, string | undefined> = {
  READY: 'LIVE',
  FAILED: 'FAILED',
  REMOVED: 'ENDED',
};

@Injectable()
export class ChannelStatusService {
  private readonly logger = new Logger(ChannelStatusService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async report(agentPartnerOrgId: string, input: ReportChannelSyncInput) {
    const activation = await this.prisma.activation.findUnique({
      where: { id: input.activation_id },
      include: { request: true },
    });

    if (!activation) {
      throw new OolixError('VAL_001', 'Activation not found.');
    }

    // An Agent may only speak for its own Partner. Without this an Agent
    // could report -- and end -- another Partner's activation, which is a
    // cross-tenant write on the strength of holding any valid agent token.
    if (activation.request.partnerOrgId !== agentPartnerOrgId) {
      throw new OolixError('PERM_002', 'This Agent does not serve that activation.');
    }

    if (activation.channel !== 'META' && activation.channel !== 'GOOGLE') {
      throw new OolixError(
        'VAL_001',
        `Activation ${input.activation_id} is on ${activation.channel}, which has no external sync.`,
      );
    }

    // An Agent must not be able to report an upload for an activation that
    // never cleared eligibility. §48.5: if blocked, no customer data is
    // prepared or uploaded -- so a status arriving for a blocked activation
    // means either a bug or an Agent acting on a manifest it should not hold.
    if (activation.status === 'PENDING_CHANNEL_CHECK') {
      this.logger.warn(
        `agent reported a ${input.status} sync for activation ${input.activation_id}, ` +
          'which has not cleared eligibility',
      );
      throw new OolixError(
        'CHAN_001',
        'This activation has not cleared channel eligibility; no sync should have been attempted.',
      );
    }

    const resource = await this.prisma.externalResource.upsert({
      where: {
        activationId_provider: {
          activationId: input.activation_id,
          provider: input.provider as never,
        },
      },
      create: {
        activationId: input.activation_id,
        provider: input.provider as never,
        audienceId: input.resource_id ?? null,
        externalCampaignId: input.external_campaign_id ?? null,
        resourceStatus: input.status as never,
        lastSyncedAt: new Date(),
        metadata: {
          accepted: input.accepted,
          skipped: input.skipped,
          error_detail: input.error_detail ?? null,
        } as never,
      },
      update: {
        audienceId: input.resource_id ?? undefined,
        externalCampaignId: input.external_campaign_id ?? undefined,
        resourceStatus: input.status as never,
        lastSyncedAt: new Date(),
        metadata: {
          accepted: input.accepted,
          skipped: input.skipped,
          error_detail: input.error_detail ?? null,
        } as never,
      },
    });

    const nextState = ACTIVATION_STATE_FOR[input.status];
    if (nextState && nextState !== activation.status) {
      await this.prisma.activation.update({
        where: { id: input.activation_id },
        data: {
          status: nextState as never,
          statusReason:
            input.status === 'FAILED'
              ? (input.error_detail ?? 'External audience sync failed.')
              : null,
        },
      });
    }

    await this.audit.record({
      action:
        input.status === 'FAILED' ? 'CHANNEL_AUDIENCE_SYNC_FAILED' : 'CHANNEL_AUDIENCE_SYNCED',
      entityType: 'activation',
      entityId: input.activation_id,
      orgId: agentPartnerOrgId,
      actorType: 'AGENT',
      metadata: {
        provider: input.provider,
        status: input.status,
        resource_id: input.resource_id ?? null,
        accepted: input.accepted,
        skipped: input.skipped,
      },
    });

    // A skip rate this high means the Partner's matching fields are mapped
    // wrongly. It is worth saying out loud, because the visible symptom is
    // only that the campaign under-delivers.
    const total = input.accepted + input.skipped;
    if (total > 0 && input.skipped / total > 0.5) {
      this.logger.warn(
        `activation ${input.activation_id}: ${input.skipped} of ${total} members had no usable ` +
          'identifier; the Partner matching-field mapping is probably wrong',
      );
    }

    return {
      activation_id: input.activation_id,
      provider: input.provider,
      status: resource.resourceStatus,
      accepted: input.accepted,
      skipped: input.skipped,
    };
  }
}
