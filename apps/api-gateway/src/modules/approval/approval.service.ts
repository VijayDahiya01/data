/**
 * Partner approval workflow -- spec v5 §41, §42, §76, §83, §101.
 *
 * This module is where the product's central promise is enforced:
 *
 *   §11.2  No valid signature + no valid approval + no current policy
 *          = no ad and no external upload.
 *   §31    Campaign approval: the Partner makes the FINAL decision, and
 *          neither the Network sponsor nor Oolix can override it.
 *
 * Approving creates one Activation per approved channel (§13) and a signed
 * manifest per activation (§75). Nothing else in the system can create either.
 */
import { Injectable, Inject, Logger } from '@nestjs/common';
import {
  OolixError,
  PARTNER_REQUEST_TRANSITIONS,
  canTransition,
  isExternalChannel,
  type Channel,
  type PartnerRequestState,
} from '@oolix/contracts';
import type { UserPrincipal } from '@oolix/auth-rbac';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AuditService } from '../../common/audit/audit.service.js';
import { CONFIG, type OolixConfig } from '../../config/configuration.js';
import { ManifestService } from '../manifest/manifest.service.js';
import { PartnerProfileService } from '../partner-supply/partner-profile.service.js';
import { ChannelActivationService } from '../channel/channel-activation.service.js';
import type {
  ApproveInput,
  ExtendInput,
  RejectInput,
  RequestChangeInput,
  RevokeInput,
} from './approval.schema.js';
import { toWireBucket } from '../../common/reach.js';

@Injectable()
export class ApprovalService {
  private readonly logger = new Logger(ApprovalService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(CONFIG) private readonly config: OolixConfig,
    @Inject(ManifestService) private readonly manifests: ManifestService,
    @Inject(PartnerProfileService) private readonly partnerProfiles: PartnerProfileService,
    @Inject(ChannelActivationService)
    private readonly channelActivations: ChannelActivationService,
  ) {}

  // -------------------------------------------------------------------------
  // §40.9 / §67.3 submit
  // -------------------------------------------------------------------------

  /**
   * Submit a draft campaign for Partner review.
   *
   * §40.9: "On submit, freeze request version and create immutable request
   * snapshot." The snapshot was written when the request was drafted; submit
   * starts the §101 SLA clock and hands the request to the Partner.
   */
  async submitCampaign(principal: UserPrincipal, campaignId: string) {
    const campaign = await this.prisma.campaign.findFirst({
      where: { id: campaignId, buyerOrgId: principal.orgId },
      include: { partnerRequests: { include: { channelRequests: true } } },
    });
    if (!campaign) throw new OolixError('CAMP_001', 'Campaign not found.');
    if (campaign.status !== 'DRAFT') {
      throw new OolixError('CAMP_002', `Campaign is already ${campaign.status}.`);
    }

    const drafts = campaign.partnerRequests.filter((r) => r.status === 'DRAFT');
    if (drafts.length === 0) {
      throw new OolixError('CAMP_002', 'Campaign has no Partner requests to submit.');
    }

    const now = new Date();
    const results: Array<{ request_id: string; status: string; expires_at: string }> = [];

    for (const request of drafts) {
      // §101: each Partner's SLA is its own, taken from that Partner's profile.
      const profile = await this.prisma.partnerProfile.findUnique({
        where: { orgId: request.partnerOrgId },
        select: { approvalSlaDays: true },
      });
      const slaDays = profile?.approvalSlaDays ?? this.config.PARTNER_REQUEST_EXPIRY_DAYS;
      const expiresAt = new Date(now.getTime() + slaDays * 86_400_000);

      await this.prisma.partnerRequest.update({
        where: { id: request.id },
        data: { status: 'PARTNER_REVIEW', submittedAt: now, expiresAt },
      });

      await this.audit.record({
        action: 'PARTNER_REQUEST_SUBMITTED',
        entityType: 'partner_request',
        entityId: request.id,
        orgId: principal.orgId,
        metadata: {
          partner_org_id: request.partnerOrgId,
          request_version: request.requestVersion,
          expires_at: expiresAt.toISOString(),
        },
      });

      // §51: the Partner's approvers are notified; the Buyer cannot chase a
      // decision through any other channel.
      await this.prisma.notification.create({
        data: {
          orgId: request.partnerOrgId,
          eventType: 'PARTNER_REQUEST_SUBMITTED',
          payload: {
            request_id: request.id,
            campaign_name: campaign.name,
            expires_at: expiresAt.toISOString(),
          } as never,
        },
      });

      results.push({
        request_id: request.id,
        status: 'PARTNER_REVIEW',
        expires_at: expiresAt.toISOString(),
      });
    }

    await this.prisma.campaign.update({
      where: { id: campaignId },
      data: { status: 'SUBMITTED', submittedAt: now },
    });

    return { campaign_id: campaignId, status: 'SUBMITTED', requests: results };
  }

  // -------------------------------------------------------------------------
  // §41 partner review centre
  // -------------------------------------------------------------------------

  /**
   * Requests awaiting this Partner's decision.
   *
   * The default is PARTNER_REVIEW alone, and the name is the reason: a
   * CHANGE_REQUESTED request is one this Partner has already acted on and
   * handed back, so it is waiting on the BUYER. Including it made the default
   * view disagree with its own title, and at scale that is not cosmetic — with
   * 21 change-requested items against 4 real ones, and the list sorted by
   * soonest expiry, a newly submitted campaign sorted last behind all of them
   * and fell off the dashboard's top-six entirely. The Partner's own tab for
   * CHANGE_REQUESTED still shows them.
   */
  async listForPartner(principal: UserPrincipal, status?: PartnerRequestState) {
    const rows = await this.prisma.partnerRequest.findMany({
      where: {
        partnerOrgId: principal.orgId,
        ...(status ? { status } : { status: 'PARTNER_REVIEW' }),
      },
      include: {
        campaign: { include: { organization: true, brand: true } },
        segment: true,
        audienceGroup: true,
        reachEstimate: true,
        channelRequests: true,
        // v6 §18.2: the Activation page shows "local materialization
        // freshness/version". It lives on the activation, so an APPROVED
        // request has to carry its activations for the queue to show it.
        activations: true,
      },
      orderBy: { expiresAt: 'asc' },
    });
    return { items: rows.map((r) => this.toReviewCard(r)), next_cursor: null };
  }

  /**
   * §41: everything the Partner must see BEFORE deciding.
   *
   * The list in §41 is a checklist of what a Partner needs in order to be
   * accountable for the decision, so this endpoint returns all of it in one
   * response rather than making an approver assemble it from several screens.
   */
  async getForPartner(principal: UserPrincipal, requestId: string) {
    const request = await this.prisma.partnerRequest.findFirst({
      where: { id: requestId, partnerOrgId: principal.orgId },
      include: {
        campaign: { include: { organization: true, brand: true, creativeVersions: true } },
        segment: true,
        // v6 §10: the Partner decides on the RULES, so the review has to carry
        // the exact version, its hash and the estimate their own Agent gave.
        audienceGroup: true,
        audienceVersionRef: true,
        reachEstimate: true,
        channelRequests: true,
        creativeDecisions: { include: { creativeVersion: true } },
        commercialTerms: true,
        approvals: { orderBy: { approvedAt: 'desc' } },
      },
    });
    if (!request) throw new OolixError('PART_001', 'Request not found.');

    const policy = await this.prisma.partnerPolicy.findFirst({
      where: { partnerOrgId: principal.orgId },
      orderBy: { version: 'desc' },
    });

    return {
      request_id: request.id,
      status: request.status,
      request_version: request.requestVersion,
      submitted_at: request.submittedAt?.toISOString() ?? null,
      expires_at: request.expiresAt?.toISOString() ?? null,
      extension_count: request.extensionCount,

      // §66.2 separation of duties, answered BEFORE the decision rather than
      // as an error after it. This says only whether the VIEWER created the
      // campaign — never who did — so it tells the Partner what they need
      // without naming a person inside the Buyer's organization.
      viewer_created_this_campaign: request.campaign.createdBy === principal.userId,

      // §41: Buyer / brand identity.
      buyer: {
        organization_id: request.campaign.organization.id,
        name: request.campaign.organization.name,
        domain: request.campaign.organization.domain,
        verification_status: request.campaign.organization.verificationStatus,
        brand: request.campaign.brand
          ? { name: request.campaign.brand.name, website: request.campaign.brand.website }
          : null,
      },

      // §41: product/category, purpose, dates, lead definition.
      campaign: {
        name: request.campaign.name,
        objective: request.campaign.objective,
        category: request.campaign.category,
        purpose_id: request.campaign.purposeId,
        start_at: request.campaign.startAt.toISOString(),
        end_at: request.campaign.endAt.toISOString(),
        geographies: request.campaign.geographies,
        landing_url: request.campaign.landingUrl,
        lead_definition: request.campaign.leadDefinition,
      },

      // v6 §19: which model this request was built from. A Partner with an
      // existing CDP audience can still be asked the old way, so both shapes
      // have to be renderable.
      targeting_source: request.targetingSource,

      // §41: the audience requested, and what it will cost the Partner to
      // evaluate it.
      //
      // v6 §10 replaces "here is a segment you already published" with "here
      // are the rules the Buyer wrote" — which is a bigger ask, and is exactly
      // why the Partner must see the whole rule set before deciding.
      audience: request.audienceGroup
        ? {
            audience_group_id: request.audienceGroupId,
            name: request.audienceGroup.name,
            description: request.audienceGroup.description,
            audience_version: request.audienceVersion,
            // §10: the approval binds to this hash. An edit that changes it
            // invalidates the approval rather than silently altering what runs.
            rule_hash: request.audienceRuleHash,
            rules: (request.audienceVersionRef?.rulesJson ?? []) as unknown as Array<{
              attribute: string;
              operator: string;
              value: unknown;
              required: boolean;
              weight: number;
            }>,
            // §8: the safe estimate this Partner's own Agent produced. A bucket
            // or nothing -- Oolix never held a count to show.
            reach_estimate: request.reachEstimate
              ? {
                  status: request.reachEstimate.status,
                  reach_bucket: toWireBucket(request.reachEstimate.reachBucket),
                  freshness_at: request.reachEstimate.freshnessAt?.toISOString() ?? null,
                  mapping_version: request.reachEstimate.mappingVersion,
                }
              : null,
          }
        : null,

      // v6 §19: legacy prebuilt-segment targeting, null on the v6 path.
      segment: request.segment
        ? {
            id: request.segment.id,
            display_name: request.segment.displayName,
            internal_key: request.segment.internalKey,
            reach_bucket: toWireBucket(request.segment.reachBucket),
          }
        : null,

      // §41: channel, placement, frequency cap, budget.
      channels: request.channelRequests.map((c) => ({
        channel: c.channel,
        placement_ids: c.placementIds,
        allocation_minor: Number(c.allocationMinor),
        frequency_cap: c.frequencyCap,
      })),

      // §41: creative preview and landing destination, bound to a version.
      creatives: request.creativeDecisions.map((d) => ({
        creative_version_id: d.creativeVersionId,
        version: d.creativeVersion.version,
        type: d.creativeVersion.type,
        headline: d.creativeVersion.headline,
        body: d.creativeVersion.body,
        cta: d.creativeVersion.cta,
        destination_url: d.creativeVersion.destinationUrl,
        legal_disclaimer: d.creativeVersion.legalDisclaimer,
        asset_url: d.creativeVersion.assetUri
          ? `${this.config.CDN_PUBLIC_BASE_URL}/${d.creativeVersion.assetUri}`
          : null,
        content_sha256: d.creativeVersion.contentSha256
          ? Buffer.from(d.creativeVersion.contentSha256).toString('hex')
          : null,
        decision: d.status,
      })),

      // §41: commercial basis.
      commercial: request.commercialTerms
        ? {
            pricing_model: request.commercialTerms.pricingModel,
            unit_price_minor: Number(request.commercialTerms.unitPriceMinor),
            currency: request.commercialTerms.currency,
            platform_fee_bps: request.commercialTerms.platformFeeBps,
          }
        : null,

      // §41: expansion/lookalike flag.
      audience_expansion_requested: request.audienceExpansionAllowed,

      // The policy this decision would bind to (§83).
      policy_version: policy ? `P-${policy.version}` : null,

      decision_history: request.approvals.map((a) => ({
        decision: a.decision,
        decision_version: a.decisionVersion,
        reason: a.reason,
        at: a.approvedAt.toISOString(),
      })),
    };
  }

  // -------------------------------------------------------------------------
  // §41 decisions
  // -------------------------------------------------------------------------

  /**
   * Approve.
   *
   * On success this is the ONLY place in the system that creates an Activation
   * and asks for a signed manifest. Everything downstream -- serving, external
   * upload, payout -- traces back to a row written here.
   */
  async approve(principal: UserPrincipal, requestId: string, input: ApproveInput) {
    const request = await this.loadForDecision(principal, requestId, 'APPROVED');

    // §66.2: a Buyer and a Partner may be the same organization, but the
    // person who created the request may not approve it.
    const campaign = await this.prisma.campaign.findUnique({
      where: { id: request.campaignId },
      select: { createdBy: true, currency: true, endAt: true },
    });
    if (campaign?.createdBy === principal.userId) {
      throw new OolixError(
        'PERM_001',
        'The user who created this campaign request cannot approve it (spec §66.2).',
      );
    }

    // §37: a Partner that has stopped being ready cannot take on new serving.
    const readiness = await this.partnerProfiles.evaluateReadiness(principal.orgId);
    if (readiness.readiness !== 'READY_FOR_CAMPAIGNS') {
      throw new OolixError(
        'PART_002',
        `Partner is not ready to serve (status: ${readiness.readiness}).`,
      );
    }

    const requested = request.channelRequests.map((c) => c.channel as Channel);
    const invalid = input.approved_channels.filter((c) => !requested.includes(c));
    if (invalid.length > 0) {
      throw new OolixError(
        'VAL_001',
        `Cannot approve channels that were not requested: ${invalid.join(', ')}`,
      );
    }

    const policy = await this.prisma.partnerPolicy.findFirst({
      where: { partnerOrgId: principal.orgId },
      orderBy: { version: 'desc' },
    });
    if (!policy) {
      // §11.2: no current policy means no ad. Approving without one would
      // create a manifest whose policy_version cannot be resolved.
      throw new OolixError('PART_002', 'Partner has no published policy to bind this approval to.');
    }
    const policyVersion = `P-${policy.version}`;

    const approvedCreatives = request.creativeDecisions.filter((d) =>
      input.approved_creative_version_ids.includes(d.creativeVersionId),
    );
    if (approvedCreatives.length !== input.approved_creative_version_ids.length) {
      throw new OolixError(
        'VAL_001',
        'One or more creative versions are not part of this request.',
      );
    }

    const { activations } = await this.prisma.$transaction(async (tx) => {
      await tx.partnerRequest.update({
        where: { id: request.id },
        data: { status: 'APPROVED', audienceExpansionAllowed: input.audience_expansion_allowed },
      });

      await tx.approval.create({
        data: {
          requestId: request.id,
          actorUserId: principal.userId,
          decision: 'APPROVE',
          decisionVersion: input.decision_version,
          reason: input.approval_note ?? null,
          // §83: actor, timestamp, request_version, policy_version and
          // creative_version are all recorded on the decision itself.
          policyVersion,
          requestVersion: request.requestVersion,
          approvedChannels: input.approved_channels as never,
          approvedPlacementIds: input.approved_placement_ids,
          approvedBudgetMinor: input.approved_budget_minor
            ? BigInt(input.approved_budget_minor)
            : null,
        },
      });

      for (const d of request.creativeDecisions) {
        await tx.partnerCreativeDecision.update({
          where: { id: d.id },
          data: {
            status: input.approved_creative_version_ids.includes(d.creativeVersionId)
              ? 'APPROVED'
              : 'REJECTED',
            reviewedAt: new Date(),
          },
        });
      }

      if (input.partner_payout) {
        await tx.commercialTerms.upsert({
          where: { requestId: request.id },
          create: {
            requestId: request.id,
            pricingModel: input.partner_payout.model as never,
            unitPriceMinor: BigInt(input.partner_payout.unit_price_minor),
            currency: campaign?.currency ?? 'INR',
            maxBudgetMinor: request.channelRequests.reduce((s, c) => s + c.allocationMinor, 0n),
          },
          update: {
            pricingModel: input.partner_payout.model as never,
            unitPriceMinor: BigInt(input.partner_payout.unit_price_minor),
          },
        });
      }

      // §13 / §40.5: one activation per approved channel. Never one ambiguous
      // activation spanning several.
      const created = [];
      for (const channel of input.approved_channels) {
        const channelRequest = request.channelRequests.find((c) => c.channel === channel)!;

        const approvedPlacements =
          input.approved_placement_ids.length > 0
            ? channelRequest.placementIds.filter((p) => input.approved_placement_ids.includes(p))
            : channelRequest.placementIds;

        const budget = input.approved_budget_minor
          ? BigInt(input.approved_budget_minor)
          : channelRequest.allocationMinor;

        const activation = await tx.activation.create({
          data: {
            requestId: request.id,
            channel: channel as never,
            placementId: approvedPlacements[0] ?? null,
            // §76: an external channel is NOT ready on approval alone. It sits
            // in PENDING_CHANNEL_CHECK until the eligibility service clears it
            // (§47.5, §48.4). Owned media is ready immediately.
            status: isExternalChannel(channel) ? 'PENDING_CHANNEL_CHECK' : 'READY',
            statusReason: isExternalChannel(channel)
              ? 'Awaiting channel eligibility verification (spec §47.5, §48.4).'
              : null,
            budgetMinor: budget,
            currency: campaign?.currency ?? 'INR',
          },
        });
        created.push({ activation, channelRequest, approvedPlacements });
      }

      await tx.auditEvent.create({
        data: {
          actor: principal.userId,
          actorType: 'USER',
          orgId: principal.orgId,
          entityType: 'partner_request',
          entityId: request.id,
          action: 'PARTNER_REQUEST_APPROVED',
          metadata: {
            decision_version: input.decision_version,
            request_version: request.requestVersion,
            policy_version: policyVersion,
            approved_channels: input.approved_channels,
            approved_creative_version_ids: input.approved_creative_version_ids,
            activation_ids: created.map((c) => c.activation.id),
          } as never,
        },
      });

      return { activations: created };
    });

    // §75: sign a manifest for every owned-media activation. External channels
    // get theirs only once eligibility passes, so nothing can be uploaded on
    // the strength of approval alone (§15, §16).
    const manifestVersions: Array<{ activation_id: string; manifest_version: number | null }> = [];
    for (const { activation } of activations) {
      if (isExternalChannel(activation.channel as Channel)) {
        // §47.5 / §48.4 run here, immediately after the Partner's decision.
        // The check signs the manifest itself when it passes, so approval
        // never signs one for an external channel.
        //
        // A thrown error is caught rather than propagated: the approval is
        // already committed, and failing the Partner's request because an
        // eligibility evaluation had a bad moment would lose their decision.
        // The activation stays PENDING_CHANNEL_CHECK, which is exactly the
        // state the retry endpoint acts on.
        let manifestVersion: number | null = null;
        try {
          const outcome = await this.channelActivations.runCheck(activation.id);
          manifestVersion = outcome.manifestVersion;
        } catch (err) {
          this.logger.error(
            `eligibility check failed to run for activation ${activation.id}: ` +
              `${err instanceof Error ? err.message : String(err)}`,
          );
        }
        manifestVersions.push({ activation_id: activation.id, manifest_version: manifestVersion });
        continue;
      }
      const signed = await this.manifests.signForActivation(activation.id);
      manifestVersions.push({
        activation_id: activation.id,
        manifest_version: signed.manifestVersion,
      });
    }

    await this.prisma.notification.create({
      data: {
        orgId: request.campaign.buyerOrgId,
        eventType: 'PARTNER_REQUEST_APPROVED',
        payload: {
          request_id: request.id,
          activation_ids: activations.map((a) => a.activation.id),
        } as never,
      },
    });

    await this.refreshCampaignStatus(request.campaignId);

    return {
      request_id: request.id,
      status: 'APPROVED',
      activation_ids: activations.map((a) => a.activation.id),
      manifests: manifestVersions,
    };
  }

  /** §41 REQUEST_CHANGE: the Buyer edits and resubmits as a NEW version. */
  async requestChange(principal: UserPrincipal, requestId: string, input: RequestChangeInput) {
    const request = await this.loadForDecision(principal, requestId, 'CHANGE_REQUESTED');

    await this.prisma.$transaction(async (tx) => {
      await tx.partnerRequest.update({
        where: { id: request.id },
        data: { status: 'CHANGE_REQUESTED' },
      });
      await tx.approval.create({
        data: {
          requestId: request.id,
          actorUserId: principal.userId,
          decision: 'REQUEST_CHANGE',
          decisionVersion: input.decision_version,
          reason: input.reason,
          policyVersion: 'n/a',
          requestVersion: request.requestVersion,
        },
      });
    });

    await this.audit.record({
      action: 'PARTNER_REQUEST_CHANGE_REQUESTED',
      entityType: 'partner_request',
      entityId: request.id,
      orgId: principal.orgId,
      metadata: { fields: input.fields, reason: input.reason },
    });

    await this.prisma.notification.create({
      data: {
        orgId: request.campaign.buyerOrgId,
        eventType: 'PARTNER_REQUEST_CHANGE_REQUESTED',
        payload: { request_id: request.id, fields: input.fields, reason: input.reason } as never,
      },
    });

    return { request_id: request.id, status: 'CHANGE_REQUESTED', fields: input.fields };
  }

  /** §41 REJECT. §76: a rejected request never becomes approved. */
  async reject(principal: UserPrincipal, requestId: string, input: RejectInput) {
    const request = await this.loadForDecision(principal, requestId, 'REJECTED');

    await this.prisma.$transaction(async (tx) => {
      await tx.partnerRequest.update({ where: { id: request.id }, data: { status: 'REJECTED' } });
      await tx.approval.create({
        data: {
          requestId: request.id,
          actorUserId: principal.userId,
          decision: 'REJECT',
          decisionVersion: input.decision_version,
          reason: input.reason,
          policyVersion: 'n/a',
          requestVersion: request.requestVersion,
        },
      });
    });

    await this.audit.record({
      action: 'PARTNER_REQUEST_REJECTED',
      entityType: 'partner_request',
      entityId: request.id,
      orgId: principal.orgId,
      metadata: { reason: input.reason },
    });

    // §40.4: one Partner's rejection must not stop another's activation, so
    // this only re-derives the parent view.
    await this.refreshCampaignStatus(request.campaignId);

    return { request_id: request.id, status: 'REJECTED' };
  }

  /**
   * §41 REVOKE: stop an approved or live activation.
   *
   * §57: local serving stops immediately and external cleanup is queued. The
   * manifest is revoked so an Agent still holding a cached copy stops using it
   * on its next control sync (§75).
   */
  async revoke(principal: UserPrincipal, requestId: string, input: RevokeInput) {
    const request = await this.prisma.partnerRequest.findFirst({
      where: { id: requestId, partnerOrgId: principal.orgId },
      include: { activations: true, campaign: true },
    });
    if (!request) throw new OolixError('PART_001', 'Request not found.');
    if (
      !canTransition(PARTNER_REQUEST_TRANSITIONS, request.status as PartnerRequestState, 'REVOKED')
    ) {
      throw new OolixError('CAMP_002', `Cannot revoke a request in state ${request.status}.`);
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.partnerRequest.update({ where: { id: request.id }, data: { status: 'REVOKED' } });

      for (const activation of request.activations) {
        if (activation.status === 'ENDED') continue;
        await tx.activation.update({
          where: { id: activation.id },
          data: {
            // §76: revoke moves an activation to ENDING; the Agent stops on
            // its next sync and external cleanup runs asynchronously.
            status: 'ENDING',
            statusReason: `Revoked by Partner: ${input.reason}`,
          },
        });
        await tx.manifest.updateMany({
          where: { activationId: activation.id, revokedAt: null },
          data: { revokedAt: new Date() },
        });
      }

      await tx.approval.create({
        data: {
          requestId: request.id,
          actorUserId: principal.userId,
          decision: 'REVOKE',
          decisionVersion: 999,
          reason: input.reason,
          policyVersion: 'n/a',
          requestVersion: request.requestVersion,
        },
      });
    });

    await this.audit.record({
      action: 'PARTNER_REQUEST_REVOKED',
      entityType: 'partner_request',
      entityId: request.id,
      orgId: principal.orgId,
      metadata: { reason: input.reason, activation_ids: request.activations.map((a) => a.id) },
    });

    await this.refreshCampaignStatus(request.campaignId);

    return {
      request_id: request.id,
      status: 'REVOKED',
      activations_ending: request.activations.filter((a) => a.status !== 'ENDED').map((a) => a.id),
    };
  }

  /** §101: extend the review window ONCE, with a mandatory audited reason. */
  async extend(principal: UserPrincipal, requestId: string, input: ExtendInput) {
    const request = await this.prisma.partnerRequest.findFirst({
      where: { id: requestId, partnerOrgId: principal.orgId },
    });
    if (!request) throw new OolixError('PART_001', 'Request not found.');
    if (request.status !== 'PARTNER_REVIEW') {
      throw new OolixError('CAMP_002', 'Only a request under review can be extended.');
    }
    if (request.extensionCount >= 1) {
      throw new OolixError(
        'CAMP_002',
        'The review window has already been extended once (spec §101).',
      );
    }

    const base = request.expiresAt ?? new Date();
    const expiresAt = new Date(base.getTime() + input.additional_days * 86_400_000);

    await this.prisma.partnerRequest.update({
      where: { id: request.id },
      data: { expiresAt, extensionCount: { increment: 1 } },
    });

    await this.audit.record({
      action: 'PARTNER_REQUEST_EXTENDED',
      entityType: 'partner_request',
      entityId: request.id,
      orgId: principal.orgId,
      metadata: {
        additional_days: input.additional_days,
        reason: input.reason,
        expires_at: expiresAt.toISOString(),
      },
    });

    return {
      request_id: request.id,
      expires_at: expiresAt.toISOString(),
      extension_count: request.extensionCount + 1,
    };
  }

  // -------------------------------------------------------------------------
  private async loadForDecision(
    principal: UserPrincipal,
    requestId: string,
    target: PartnerRequestState,
  ) {
    const request = await this.prisma.partnerRequest.findFirst({
      where: { id: requestId, partnerOrgId: principal.orgId },
      include: {
        campaign: true,
        channelRequests: true,
        creativeDecisions: true,
      },
    });
    if (!request) throw new OolixError('PART_001', 'Request not found.');

    if (
      !canTransition(PARTNER_REQUEST_TRANSITIONS, request.status as PartnerRequestState, target)
    ) {
      throw new OolixError(
        'CAMP_002',
        `Cannot move a request from ${request.status} to ${target} (spec §76).`,
      );
    }

    // §101: an expired request is not decidable. Expiry is neither approval
    // nor rejection, so the Buyer must resubmit rather than the Partner
    // deciding late.
    if (request.expiresAt && request.expiresAt.getTime() <= Date.now()) {
      throw new OolixError(
        'CAMP_002',
        'This request has passed its review window and must be resubmitted by the Buyer (spec §101).',
      );
    }

    return request;
  }

  /**
   * Re-derive the parent campaign status (§42).
   *
   * The parent is a projection. Writing it here keeps the stored value in step
   * with the activations, but §42 means nothing should ever READ it in place
   * of looking at the activations themselves.
   */
  private async refreshCampaignStatus(campaignId: string): Promise<void> {
    const campaign = await this.prisma.campaign.findUnique({
      where: { id: campaignId },
      include: { partnerRequests: { include: { activations: true } } },
    });
    if (!campaign) return;

    const activations = campaign.partnerRequests.flatMap((r) => r.activations);
    const approved = campaign.partnerRequests.filter((r) => r.status === 'APPROVED').length;
    const resolved = campaign.partnerRequests.filter((r) =>
      ['APPROVED', 'REJECTED', 'REVOKED', 'EXPIRED'].includes(r.status),
    ).length;
    const total = campaign.partnerRequests.length;

    let status = campaign.status;
    if (activations.some((a) => a.status === 'LIVE')) {
      status = activations.every((a) => a.status === 'LIVE') ? 'LIVE' : 'PARTIALLY_LIVE';
    } else if (approved > 0) {
      status = resolved === total ? 'READY' : 'PARTIALLY_APPROVED';
    } else if (resolved === total && total > 0) {
      status = 'ENDED';
    }

    if (status !== campaign.status) {
      await this.prisma.campaign.update({
        where: { id: campaignId },
        data: { status: status as never },
      });
    }
  }

  private toReviewCard(r: {
    id: string;
    status: string;
    requestVersion: number;
    submittedAt: Date | null;
    expiresAt: Date | null;
    campaign: {
      name: string;
      category: string;
      organization: { name: string };
      brand: { name: string } | null;
    };
    targetingSource: string;
    // v6 §19: exactly one of these is set. Prebuilt-segment requests remain
    // valid supply for Partners with an existing CDP audience.
    segment: { displayName: string; reachBucket: string } | null;
    audienceGroup: { name: string } | null;
    audienceVersion: number | null;
    reachEstimate: { reachBucket: string | null } | null;
    channelRequests: Array<{ channel: string; allocationMinor: bigint }>;
    activations?: Array<{
      id: string;
      channel: string;
      status: string;
      materializationStatus: string | null;
      materializationVersion: number | null;
      materializedAt: Date | null;
    }>;
  }) {
    return {
      request_id: r.id,
      status: r.status,
      request_version: r.requestVersion,
      submitted_at: r.submittedAt?.toISOString() ?? null,
      expires_at: r.expiresAt?.toISOString() ?? null,
      /** Days remaining, so the §101 reminders have something to show. */
      days_remaining: r.expiresAt
        ? Math.max(0, Math.ceil((r.expiresAt.getTime() - Date.now()) / 86_400_000))
        : null,
      buyer_name: r.campaign.organization.name,
      brand_name: r.campaign.brand?.name ?? null,
      campaign_name: r.campaign.name,
      category: r.campaign.category,
      targeting_source: r.targetingSource,
      // v6 §18.2: the queue names the audience, whichever model produced it,
      // so a Partner can triage without opening each request.
      audience: r.audienceGroup
        ? {
            name: r.audienceGroup.name,
            audience_version: r.audienceVersion,
            reach_bucket: toWireBucket(r.reachEstimate?.reachBucket ?? null),
          }
        : null,
      segment: r.segment
        ? {
            display_name: r.segment.displayName,
            reach_bucket: toWireBucket(r.segment.reachBucket),
          }
        : null,
      channels: r.channelRequests.map((c) => ({
        channel: c.channel,
        allocation_minor: Number(c.allocationMinor),
      })),
      // v6 §11 / §18.2: what this Partner's own Agent has compiled locally.
      //
      // Status, version and freshness — the three things §11 permits Oolix to
      // hold. Nothing here says how many people matched, because Oolix was
      // never told.
      activations: (r.activations ?? []).map((a) => ({
        activation_id: a.id,
        channel: a.channel,
        status: a.status,
        materialization: a.materializationStatus
          ? {
              status: a.materializationStatus,
              version: a.materializationVersion,
              built_at: a.materializedAt?.toISOString() ?? null,
            }
          : null,
      })),
    };
  }
}
