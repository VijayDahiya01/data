/**
 * Partner kill switches and activation lifecycle -- spec v5 §24, §41, §56,
 * §57, §76, §98.
 *
 * §6 lists what a Partner must retain to be willing to run this at all:
 *
 *   "Partner approval, placement allow-list, category policy, frequency limits
 *    and kill switches remain partner-controlled."
 *
 * A kill switch is therefore unilateral and immediate. It needs no Buyer
 * agreement, no Oolix approval and no notice period, and §78.2 alerts on every
 * production activation of one. §24: "Stop local serving immediately; queue
 * external cleanup/revocation."
 */
import { Injectable, Inject } from '@nestjs/common';
import { z } from 'zod';
import {
  ACTIVATION_TRANSITIONS,
  OolixError,
  canTransition,
  isExternalChannel,
  type ActivationState,
  type Channel,
} from '@oolix/contracts';
import type { UserPrincipal } from '@oolix/auth-rbac';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AuditService } from '../../common/audit/audit.service.js';

export const KillSwitchSchema = z.object({
  scope: z.enum(['AGENT', 'PLACEMENT', 'ACTIVATION', 'CHANNEL', 'PARTNER_ALL']),
  /**
   * For PLACEMENT this is the placement KEY, because that is what the Agent
   * matches on locally without a lookup (§75 offline enforcement). For
   * ACTIVATION and CHANNEL it is the id or channel name. Null for
   * PARTNER_ALL and AGENT.
   */
  target_id: z.string().max(200).nullable().default(null),
  reason: z.string().min(3).max(500),
});
export type KillSwitchInput = z.infer<typeof KillSwitchSchema>;

@Injectable()
export class KillSwitchService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  /**
   * Activate a kill switch.
   *
   * The switch is stored centrally and shipped to the Agent on its next
   * control sync (§52.4), where it is enforced LOCALLY. That local enforcement
   * matters: §24 requires serving to stop even while Oolix is unreachable, so
   * the Agent cannot depend on asking permission.
   */
  async activate(principal: UserPrincipal, input: KillSwitchInput) {
    if (input.scope === 'PLACEMENT' && !input.target_id) {
      throw new OolixError('VAL_001', 'PLACEMENT scope requires a target placement key.');
    }
    if (input.scope === 'ACTIVATION' && !input.target_id) {
      throw new OolixError('VAL_001', 'ACTIVATION scope requires a target activation id.');
    }

    // Verify ownership before killing: a Partner may only stop its own supply.
    if (input.scope === 'ACTIVATION' && input.target_id) {
      const activation = await this.prisma.activation.findFirst({
        where: { id: input.target_id, request: { partnerOrgId: principal.orgId } },
      });
      if (!activation) throw new OolixError('PART_001', 'Activation not found.');
    }

    const existing = await this.prisma.killSwitch.findFirst({
      where: {
        partnerOrgId: principal.orgId,
        scope: input.scope as never,
        targetId: input.target_id,
        active: true,
      },
    });
    if (existing) {
      return { kill_switch_id: existing.id, scope: input.scope, already_active: true };
    }

    const created = await this.prisma.killSwitch.create({
      data: {
        partnerOrgId: principal.orgId,
        scope: input.scope as never,
        targetId: input.target_id,
        reason: input.reason,
        activatedBy: principal.userId,
        active: true,
      },
    });

    // §24: local serving stops on the next sync; anything already running
    // externally is moved toward cleanup now.
    if (input.scope === 'ACTIVATION' && input.target_id) {
      await this.endActivationInternal(input.target_id, `Kill switch: ${input.reason}`);
    } else if (input.scope === 'PARTNER_ALL' || input.scope === 'AGENT') {
      await this.pauseAllForPartner(principal.orgId, `Kill switch: ${input.reason}`);
    }

    // §78.2: "Kill switch: every production activation; immediate audit
    // notification."
    await this.audit.record({
      action: 'KILL_SWITCH_ACTIVATED',
      entityType: 'kill_switch',
      entityId: created.id,
      orgId: principal.orgId,
      metadata: { scope: input.scope, target_id: input.target_id, reason: input.reason },
    });

    await this.prisma.notification.create({
      data: {
        orgId: principal.orgId,
        eventType: 'KILL_SWITCH_ACTIVATED',
        payload: { scope: input.scope, target_id: input.target_id, reason: input.reason } as never,
      },
    });

    return {
      kill_switch_id: created.id,
      scope: input.scope,
      target_id: input.target_id,
      active: true,
      effective: 'Local serving stops on the next Agent control sync (spec §24, §75).',
    };
  }

  /** Release a kill switch. Serving resumes only on the next control sync. */
  async release(principal: UserPrincipal, killSwitchId: string) {
    const ks = await this.prisma.killSwitch.findFirst({
      where: { id: killSwitchId, partnerOrgId: principal.orgId },
    });
    if (!ks) throw new OolixError('PART_001', 'Kill switch not found.');

    await this.prisma.killSwitch.update({
      where: { id: killSwitchId },
      data: { active: false, releasedAt: new Date() },
    });

    await this.audit.record({
      action: 'KILL_SWITCH_RELEASED',
      entityType: 'kill_switch',
      entityId: killSwitchId,
      orgId: principal.orgId,
      metadata: { scope: ks.scope, target_id: ks.targetId },
    });

    return {
      kill_switch_id: killSwitchId,
      active: false,
      // Releasing does NOT resurrect an ended activation: §76 has no path from
      // ENDED back to LIVE, so the Buyer must submit a new request.
      note: 'Activations already moved to ENDING/ENDED are not resumed (spec §76).',
    };
  }

  async list(principal: UserPrincipal) {
    const rows = await this.prisma.killSwitch.findMany({
      where: { partnerOrgId: principal.orgId },
      orderBy: { activatedAt: 'desc' },
      take: 100,
    });
    return {
      items: rows.map((k) => ({
        kill_switch_id: k.id,
        scope: k.scope,
        target_id: k.targetId,
        active: k.active,
        reason: k.reason,
        activated_at: k.activatedAt.toISOString(),
        released_at: k.releasedAt?.toISOString() ?? null,
      })),
      next_cursor: null,
    };
  }

  // -------------------------------------------------------------------------
  // §52.3 activation lifecycle
  // -------------------------------------------------------------------------

  /**
   * Pause an activation.
   *
   * Available to BOTH sides: a Buyer pausing its own spend and a Partner
   * pausing its own inventory are both legitimate. Scope is resolved from the
   * caller's organization, so neither can touch the other's activations.
   */
  async pause(principal: UserPrincipal, activationId: string, reason: string) {
    const activation = await this.requireVisible(principal, activationId);
    this.assertTransition(activation.status as ActivationState, 'PAUSED');

    await this.prisma.activation.update({
      where: { id: activationId },
      data: { status: 'PAUSED', statusReason: reason },
    });

    await this.audit.record({
      action: 'ACTIVATION_PAUSED',
      entityType: 'activation',
      entityId: activationId,
      orgId: principal.orgId,
      metadata: { reason },
    });

    return { activation_id: activationId, status: 'PAUSED' };
  }

  /** §76: PAUSED may return to LIVE. */
  async resume(principal: UserPrincipal, activationId: string) {
    const activation = await this.requireVisible(principal, activationId);
    this.assertTransition(activation.status as ActivationState, 'LIVE');

    // A kill switch outranks a resume: releasing the switch is the only way
    // back, and it must be a deliberate separate act.
    const blocking = await this.prisma.killSwitch.findFirst({
      where: {
        partnerOrgId: activation.request.partnerOrgId,
        active: true,
        OR: [
          { scope: 'PARTNER_ALL' },
          { scope: 'AGENT' },
          { scope: 'ACTIVATION', targetId: activationId },
        ],
      },
    });
    if (blocking) {
      throw new OolixError(
        'CAMP_002',
        `An active ${blocking.scope} kill switch prevents resuming this activation (spec §24).`,
      );
    }

    await this.prisma.activation.update({
      where: { id: activationId },
      data: { status: 'LIVE', statusReason: null },
    });

    await this.audit.record({
      action: 'ACTIVATION_RESUMED',
      entityType: 'activation',
      entityId: activationId,
      orgId: principal.orgId,
    });

    return { activation_id: activationId, status: 'LIVE' };
  }

  /** §52.3 end. §76: ENDING is terminal-bound; there is no way back. */
  async end(principal: UserPrincipal, activationId: string, reason: string) {
    const activation = await this.requireVisible(principal, activationId);
    if (activation.status === 'ENDED') {
      return { activation_id: activationId, status: 'ENDED', already_ended: true };
    }

    await this.endActivationInternal(activationId, reason);

    await this.audit.record({
      action: 'ACTIVATION_END_REQUESTED',
      entityType: 'activation',
      entityId: activationId,
      orgId: principal.orgId,
      metadata: { reason },
    });

    return {
      activation_id: activationId,
      status: 'ENDING',
      external_cleanup_queued: isExternalChannel(activation.channel as Channel),
    };
  }

  private async endActivationInternal(activationId: string, reason: string) {
    await this.prisma.$transaction(async (tx) => {
      await tx.activation.update({
        where: { id: activationId },
        data: { status: 'ENDING', statusReason: reason, endedAt: new Date() },
      });
      // §75: revoking the manifest is what actually stops the Agent serving.
      // Without it the Agent would keep a valid cached manifest until expiry.
      await tx.manifest.updateMany({
        where: { activationId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    });
  }

  private async pauseAllForPartner(partnerOrgId: string, reason: string) {
    const activations = await this.prisma.activation.findMany({
      where: { request: { partnerOrgId }, status: { in: ['READY', 'SYNCING', 'LIVE'] } },
      select: { id: true },
    });

    await this.prisma.$transaction(async (tx) => {
      await tx.activation.updateMany({
        where: { id: { in: activations.map((a) => a.id) } },
        data: { status: 'PAUSED', statusReason: reason },
      });
      await tx.manifest.updateMany({
        where: { activationId: { in: activations.map((a) => a.id) }, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    });

    return activations.length;
  }

  private assertTransition(from: ActivationState, to: ActivationState) {
    if (!canTransition(ACTIVATION_TRANSITIONS, from, to)) {
      throw new OolixError(
        'CAMP_002',
        `Cannot move an activation from ${from} to ${to} (spec §76).`,
      );
    }
  }

  /**
   * An activation is visible to the Partner that serves it and to the Buyer
   * that pays for it -- and to nobody else.
   */
  private async requireVisible(principal: UserPrincipal, activationId: string) {
    const activation = await this.prisma.activation.findFirst({
      where: {
        id: activationId,
        OR: [
          { request: { partnerOrgId: principal.orgId } },
          { request: { campaign: { buyerOrgId: principal.orgId } } },
        ],
      },
      include: { request: true },
    });
    if (!activation) throw new OolixError('CAMP_001', 'Activation not found.');
    return activation;
  }
}
