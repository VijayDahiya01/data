/**
 * What happens to an external activation after a Partner approves it --
 * spec v5 §47.5-§47.7, §48.4-§48.6.
 *
 * Approval alone does not authorise an upload. §47.5 puts the Channel
 * Eligibility Service between the Partner's decision and any customer data
 * being prepared, and §47.6 is explicit about the failure mode: not eligible
 * means BLOCKED, with owned media offered instead. This service is the thing
 * that runs that check and applies its answer.
 *
 * Before this existed, an external activation was created in
 * PENDING_CHANNEL_CHECK and nothing in the system ever moved it out. The state
 * was reachable, documented, and terminal in practice.
 *
 * THE ORDER MATTERS. The manifest is signed only after the verdict is in and
 * only when it passed, because a signed manifest is the Agent's authority to
 * read a segment and upload it (§75). Signing first and checking after would
 * mean the authority existed, however briefly, without the grounds for it.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { OolixError } from '@oolix/contracts';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AuditService } from '../../common/audit/audit.service.js';
import { ManifestService } from '../manifest/manifest.service.js';
import { ChannelEligibilityService } from './eligibility.service.js';
import type { EligibilityVerdict } from './eligibility.types.js';

/** Activation statuses from which an eligibility check may run. */
const CHECKABLE = new Set(['PENDING_CHANNEL_CHECK', 'FAILED']);

export interface EligibilityOutcome {
  activationId: string;
  eligible: boolean;
  status: string;
  verdict: EligibilityVerdict;
  manifestVersion: number | null;
}

@Injectable()
export class ChannelActivationService {
  private readonly logger = new Logger(ChannelActivationService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(ManifestService) private readonly manifests: ManifestService,
    @Inject(ChannelEligibilityService) private readonly eligibility: ChannelEligibilityService,
  ) {}

  /**
   * Evaluate one activation and apply the verdict.
   *
   * Safe to call more than once. §47 allows a Partner to fix a connection and
   * retry, so FAILED is checkable again; READY and everything past it are not,
   * because re-running a check against a live activation would either be a
   * no-op or would revoke it as a side effect of an unrelated call. Revocation
   * has its own path (`revokeEligibility`) precisely so it is never accidental.
   */
  async runCheck(activationId: string): Promise<EligibilityOutcome> {
    const activation = await this.prisma.activation.findUnique({
      where: { id: activationId },
      include: {
        request: {
          include: {
            campaign: { include: { brand: true } },
          },
        },
      },
    });

    if (!activation) {
      throw new OolixError('VAL_001', 'Activation not found.');
    }

    const provider = activation.channel === 'META' ? 'META' : 'GOOGLE';
    if (activation.channel !== 'META' && activation.channel !== 'GOOGLE') {
      // Owned media never passes through here. Saying so plainly beats
      // silently returning "eligible" for a channel with no eligibility model.
      throw new OolixError(
        'VAL_001',
        `Channel ${activation.channel} is not an external channel and has no eligibility gate.`,
      );
    }

    if (!CHECKABLE.has(activation.status)) {
      throw new OolixError(
        'VAL_001',
        `Activation is ${activation.status}; an eligibility check applies only to ` +
          `PENDING_CHANNEL_CHECK or FAILED (spec §76 transitions).`,
      );
    }

    const request = activation.request;
    const campaign = request.campaign;

    const verdict = await this.eligibility.evaluate({
      partnerOrgId: request.partnerOrgId,
      buyerOrgId: campaign.buyerOrgId,
      provider,
      segmentId: request.segmentId,
      advertiserName: campaign.brand?.name ?? null,
    });

    return verdict.eligible
      ? this.applyPass(activation.id, request.partnerOrgId, provider, verdict)
      : this.applyBlock(activation.id, request.partnerOrgId, provider, verdict);
  }

  private async applyPass(
    activationId: string,
    partnerOrgId: string,
    provider: string,
    verdict: EligibilityVerdict,
  ): Promise<EligibilityOutcome> {
    await this.prisma.activation.update({
      where: { id: activationId },
      data: { status: 'READY', statusReason: verdict.summary },
    });

    // Only now. The manifest is the Agent's authority to read the segment and
    // upload it (§47.7), so it must not exist before the grounds for it do.
    const signed = await this.manifests.signForActivation(activationId);

    // The row the Agent reports its upload progress against. Created here
    // rather than by the Agent so that a resource which never syncs is still
    // visible centrally as NOT_STARTED -- an Agent that fails silently would
    // otherwise leave no trace at all.
    await this.prisma.externalResource.upsert({
      where: { activationId_provider: { activationId, provider: provider as never } },
      create: { activationId, provider: provider as never, resourceStatus: 'NOT_STARTED' },
      update: {},
    });

    await this.audit.record({
      action: 'CHANNEL_ELIGIBILITY_PASSED',
      entityType: 'activation',
      entityId: activationId,
      orgId: partnerOrgId,
      metadata: {
        provider,
        manifest_version: signed.manifestVersion,
        checks_passed: verdict.checks.map((c) => c.id),
      },
    });

    this.logger.log(
      `activation ${activationId} cleared ${provider} eligibility; manifest v${signed.manifestVersion}`,
    );

    return {
      activationId,
      eligible: true,
      status: 'READY',
      verdict,
      manifestVersion: signed.manifestVersion,
    };
  }

  private async applyBlock(
    activationId: string,
    partnerOrgId: string,
    provider: string,
    verdict: EligibilityVerdict,
  ): Promise<EligibilityOutcome> {
    await this.prisma.activation.update({
      where: { id: activationId },
      // FAILED rather than ENDED: §47 expects the Partner to be able to fix a
      // connection and retry, and PENDING_CHANNEL_CHECK -> FAILED -> READY is
      // a path the state machine already allows.
      data: { status: 'FAILED', statusReason: verdict.summary },
    });

    // No manifest, and no ExternalResource row. §48.5: "If blocked, no
    // customer data is prepared or uploaded." Creating the resource row here
    // would suggest an upload was contemplated.
    await this.audit.record({
      action: 'CHANNEL_ELIGIBILITY_FAILED',
      entityType: 'activation',
      entityId: activationId,
      orgId: partnerOrgId,
      metadata: {
        provider,
        // The reasons, so the Partner can act without asking anyone.
        blocking: verdict.blocking.map((c) => ({ id: c.id, detail: c.detail })),
      },
    });

    this.logger.warn(`activation ${activationId} blocked on ${provider}: ${verdict.summary}`);

    return { activationId, eligible: false, status: 'FAILED', verdict, manifestVersion: null };
  }

  /**
   * §47.14 / §48.12: eligibility withdrawn after the fact.
   *
   * A connection can expire, a platform can revoke a permission, a Partner can
   * change its policy. When that happens to a LIVE activation the campaign has
   * to stop and the uploaded audience has to be removed -- so this moves the
   * activation to ENDING and marks the external resource for removal, which is
   * what the Agent acts on next time it syncs.
   *
   * Separate from `runCheck` on purpose: revoking is destructive, and it
   * should never be something an ordinary re-check can do by accident.
   */
  async revokeEligibility(activationId: string, reason: string): Promise<void> {
    const activation = await this.prisma.activation.findUnique({
      where: { id: activationId },
      include: { request: true },
    });
    if (!activation) throw new OolixError('VAL_001', 'Activation not found.');

    const terminal = activation.status === 'ENDED' || activation.status === 'ENDING';
    if (terminal) return;

    await this.prisma.$transaction(async (tx) => {
      await tx.activation.update({
        where: { id: activationId },
        data: { status: 'ENDING', statusReason: `Eligibility revoked: ${reason}` },
      });

      // REMOVING, not REMOVED. Only the Agent can confirm the audience is gone
      // from the provider, because only the Agent can talk to it; claiming
      // REMOVED here would be Oolix asserting something it cannot observe.
      await tx.externalResource.updateMany({
        where: { activationId, resourceStatus: { notIn: ['REMOVED', 'REMOVING'] } },
        data: { resourceStatus: 'REMOVING' },
      });
    });

    await this.audit.record({
      action: 'CHANNEL_ELIGIBILITY_REVOKED',
      entityType: 'activation',
      entityId: activationId,
      orgId: activation.request.partnerOrgId,
      metadata: { reason, channel: activation.channel },
    });

    this.logger.warn(`activation ${activationId} eligibility revoked: ${reason}`);
  }
}
