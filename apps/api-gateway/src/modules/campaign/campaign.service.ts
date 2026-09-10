/**
 * Campaign builder -- spec v5 §40, §13, §67.
 *
 * The structural rule this service exists to enforce is §13 / §40.4:
 *
 *   One parent campaign, N Partner requests, and one ACTIVATION per
 *   Partner x channel. Partners never see each other, and one Partner's
 *   rejection does not stop another's activation.
 *
 * The parent campaign is an aggregate view (§42); it never carries a status
 * that would hide what an individual Partner or channel is actually doing.
 */
import { Injectable, Inject } from '@nestjs/common';
import {
  OolixError,
  deriveCampaignState,
  isExternalChannel,
  type ActivationState,
  type Channel,
} from '@oolix/contracts';
import type { UserPrincipal } from '@oolix/auth-rbac';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AuditService } from '../../common/audit/audit.service.js';
import { PartnerProfileService } from '../partner-supply/partner-profile.service.js';
import { CONFIG, type OolixConfig } from '../../config/configuration.js';
import type {
  CreateCampaignInput,
  CreatePartnerRequestInput,
  LinkAudienceInput,
  UpdateCampaignInput,
} from './campaign.schema.js';
import { toWireBucket } from '../../common/reach.js';

@Injectable()
export class CampaignService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(CONFIG) private readonly config: OolixConfig,
    @Inject(PartnerProfileService) private readonly partnerProfiles: PartnerProfileService,
  ) {}

  // -------------------------------------------------------------------------
  // §40.1-40.2 create
  // -------------------------------------------------------------------------

  async create(principal: UserPrincipal, input: CreateCampaignInput) {
    const brand = await this.prisma.brand.findFirst({
      where: { id: input.brand_id, buyerOrgId: principal.orgId },
    });
    if (!brand) {
      // §40.2: the brand must belong to the verified Buyer organization.
      throw new OolixError('VAL_001', 'Brand not found for this organization.', {
        fieldErrors: [{ field: 'brand_id', message: 'unknown brand' }],
      });
    }

    if (input.landing_url) this.assertLandingUrl(input.landing_url, brand.landingDomain);

    const campaign = await this.prisma.campaign.create({
      data: {
        buyerOrgId: principal.orgId,
        brandId: brand.id,
        name: input.name,
        objective: input.objective as never,
        category: input.category,
        purposeId: input.purpose_id,
        budgetMinor: BigInt(input.budget.amount_minor),
        currency: input.budget.currency,
        status: 'DRAFT',
        startAt: new Date(input.start_at),
        endAt: new Date(input.end_at),
        geographies: input.geographies,
        landingUrl: input.landing_url ?? null,
        leadDefinition: (input.lead_definition ?? {}) as never,
        createdBy: principal.userId,
      },
    });

    await this.audit.record({
      action: 'CAMPAIGN_CREATED',
      entityType: 'campaign',
      entityId: campaign.id,
      orgId: principal.orgId,
      metadata: { objective: input.objective, budget_minor: input.budget.amount_minor },
    });

    return this.toWire(campaign);
  }

  /**
   * §40.2 / §82: the landing URL must sit on the brand's allow-listed domain
   * and must not carry PII in its query string.
   */
  private assertLandingUrl(landingUrl: string, allowedDomain: string): void {
    let url: URL;
    try {
      url = new URL(landingUrl);
    } catch {
      throw new OolixError('VAL_001', 'landing_url is not a valid URL.', {
        fieldErrors: [{ field: 'landing_url', message: 'invalid URL' }],
      });
    }

    if (url.protocol !== 'https:') {
      throw new OolixError('VAL_001', 'landing_url must use HTTPS (spec §40.7).', {
        fieldErrors: [{ field: 'landing_url', message: 'must be https' }],
      });
    }

    const host = url.hostname.toLowerCase();
    const domain = allowedDomain.toLowerCase();
    if (host !== domain && !host.endsWith(`.${domain}`)) {
      throw new OolixError('VAL_001', `landing_url must be on the verified domain ${domain}.`, {
        fieldErrors: [{ field: 'landing_url', message: `expected ${domain}` }],
      });
    }

    // §40.7: "no PII query parameters". A landing URL is copied into creative
    // and into redirects, so anything here is broadly visible.
    const forbidden = ['email', 'phone', 'mobile', 'name', 'user_id', 'customer_id', 'msisdn'];
    for (const key of url.searchParams.keys()) {
      if (forbidden.includes(key.toLowerCase())) {
        throw new OolixError(
          'VAL_001',
          'landing_url must not carry PII query parameters (§40.7).',
          {
            fieldErrors: [{ field: 'landing_url', message: `remove "${key}"` }],
          },
        );
      }
    }
  }

  async update(principal: UserPrincipal, campaignId: string, input: UpdateCampaignInput) {
    const campaign = await this.requireOwnedDraft(principal, campaignId);

    if (input.landing_url) {
      const brand = campaign.brandId
        ? await this.prisma.brand.findUnique({ where: { id: campaign.brandId } })
        : null;
      if (brand) this.assertLandingUrl(input.landing_url, brand.landingDomain);
    }

    const startAt = input.start_at ? new Date(input.start_at) : campaign.startAt;
    const endAt = input.end_at ? new Date(input.end_at) : campaign.endAt;
    if (endAt <= startAt) {
      throw new OolixError('VAL_001', 'end_at must be after start_at.', {
        fieldErrors: [{ field: 'end_at', message: 'must be after start_at' }],
      });
    }

    if (input.budget) {
      if (input.budget.currency !== campaign.currency) {
        // §40.2: currency is fixed per campaign; changing it would invalidate
        // every allocation already agreed with a Partner.
        throw new OolixError('VAL_001', 'Campaign currency cannot be changed.', {
          fieldErrors: [{ field: 'budget.currency', message: `fixed at ${campaign.currency}` }],
        });
      }
      await this.assertBudgetCoversAllocations(campaignId, BigInt(input.budget.amount_minor));
    }

    const updated = await this.prisma.campaign.update({
      where: { id: campaignId },
      data: {
        ...(input.name ? { name: input.name } : {}),
        ...(input.category ? { category: input.category } : {}),
        ...(input.budget ? { budgetMinor: BigInt(input.budget.amount_minor) } : {}),
        ...(input.start_at ? { startAt } : {}),
        ...(input.end_at ? { endAt } : {}),
        ...(input.geographies ? { geographies: input.geographies } : {}),
        ...(input.landing_url ? { landingUrl: input.landing_url } : {}),
        ...(input.lead_definition ? { leadDefinition: input.lead_definition as never } : {}),
        version: { increment: 1 },
      },
    });

    await this.audit.record({
      action: 'CAMPAIGN_UPDATED',
      entityType: 'campaign',
      entityId: campaignId,
      orgId: principal.orgId,
      metadata: { fields: Object.keys(input) },
    });

    return this.toWire(updated);
  }

  // -------------------------------------------------------------------------
  // §40.4-40.6 partner requests
  // -------------------------------------------------------------------------

  /**
   * Add a Partner request to a draft campaign.
   *
   * §40.4: "One parent campaign may contain 1-N Partner requests" and
   * "Every Partner receives only its own request."
   */
  // -------------------------------------------------------------------------
  // v6 §9 step 3: the campaign's audience
  // -------------------------------------------------------------------------

  /**
   * Link an Audience Group version to a campaign, freezing it.
   *
   * §9: "Campaign request freezes Audience Group version, rule hash and
   * selected reach-estimate version", and "one campaign links one Audience
   * Group in MVP". Both are enforced here rather than trusted to the UI.
   *
   * The rule hash is copied onto the link rather than read through the relation
   * at approval time. That is the whole mechanism of §10: what the Partner
   * approves is a hash, and a hash that lives on the link cannot drift when the
   * Buyer edits the audience afterwards.
   */
  async linkAudience(principal: UserPrincipal, campaignId: string, input: LinkAudienceInput) {
    const campaign = await this.requireOwnedDraft(principal, campaignId);

    const group = await this.prisma.audienceGroup.findFirst({
      where: { id: input.audience_group_id, buyerOrgId: principal.orgId },
      include: { versions: { orderBy: { version: 'desc' } } },
    });
    if (!group) {
      // Scoped to the Buyer's own org: an audience is a Buyer asset, and
      // linking someone else's would leak its rules through the review screen.
      throw new OolixError('CAMP_001', 'Audience group not found.');
    }

    const version =
      group.versions.find((v) => v.version === (input.audience_version ?? group.currentVersion)) ??
      null;
    if (!version) {
      throw new OolixError('VAL_001', 'That audience version does not exist.', {
        fieldErrors: [{ field: 'audience_version', message: 'unknown version' }],
      });
    }

    // §6: a DRAFT version is still being edited. Freezing one would bind a
    // Partner's approval to rules the Buyer had not finished writing.
    if (version.status !== 'READY') {
      throw new OolixError(
        'CAMP_002',
        `Audience version ${version.version} is ${version.status}; publish it before linking it to a campaign.`,
      );
    }

    // §9: one campaign, one Audience Group. Re-linking is allowed while the
    // campaign is still DRAFT, but not once a Partner is looking at it -- that
    // would move the target under a live review.
    const inFlight = await this.prisma.partnerRequest.count({
      where: {
        campaignId,
        status: { in: ['PARTNER_REVIEW', 'CHANGE_REQUESTED', 'APPROVED'] },
      },
    });
    if (inFlight > 0) {
      throw new OolixError(
        'CAMP_002',
        'This campaign already has Partner requests in review; the audience can no longer be changed.',
      );
    }

    const existing = await this.prisma.campaignAudienceLink.findFirst({ where: { campaignId } });

    const link = await this.prisma.$transaction(async (tx) => {
      if (existing && existing.audienceGroupId !== group.id) {
        await tx.campaignAudienceLink.delete({
          where: {
            campaignId_audienceGroupId: {
              campaignId,
              audienceGroupId: existing.audienceGroupId,
            },
          },
        });
      }

      return tx.campaignAudienceLink.upsert({
        where: { campaignId_audienceGroupId: { campaignId, audienceGroupId: group.id } },
        create: {
          campaignId,
          audienceGroupId: group.id,
          audienceVersion: version.version,
          ruleHash: version.ruleHash,
        },
        update: {
          audienceVersion: version.version,
          ruleHash: version.ruleHash,
          linkedAt: new Date(),
        },
      });
    });

    await this.audit.record({
      action: 'CAMPAIGN_AUDIENCE_LINKED',
      entityType: 'campaign',
      entityId: campaignId,
      orgId: principal.orgId,
      actor: principal.userId,
      metadata: {
        audience_group_id: group.id,
        audience_version: version.version,
        // The hash is what a Partner's approval will bind to, so it belongs in
        // the audit trail alongside the version (§10, §83).
        rule_hash: version.ruleHash,
        replaced: existing?.audienceGroupId ?? null,
      },
    });

    return {
      campaign_id: campaignId,
      audience_group_id: group.id,
      audience_group_name: group.name,
      audience_version: version.version,
      rule_hash: version.ruleHash,
      linked_at: link.linkedAt.toISOString(),
      campaign_status: campaign.status,
    };
  }

  /** §9 step 10: what the review screen and the wizard read back. */
  async getAudienceLink(principal: UserPrincipal, campaignId: string) {
    const campaign = await this.prisma.campaign.findFirst({
      where: { id: campaignId, buyerOrgId: principal.orgId },
    });
    if (!campaign) throw new OolixError('CAMP_001', 'Campaign not found.');

    const link = await this.prisma.campaignAudienceLink.findFirst({
      where: { campaignId },
      include: { audienceGroup: true, audienceVersionRef: true },
    });
    if (!link) return { campaign_id: campaignId, audience: null };

    return {
      campaign_id: campaignId,
      audience: {
        audience_group_id: link.audienceGroupId,
        audience_group_name: link.audienceGroup.name,
        audience_version: link.audienceVersion,
        rule_hash: link.ruleHash,
        // The rules are shown back to the BUYER, who wrote them. Nothing here
        // came from a Partner.
        rules: link.audienceVersionRef.rulesJson,
        linked_at: link.linkedAt.toISOString(),
      },
    };
  }

  /** Unlink while still drafting -- §9 keeps step 3 revisable until submit. */
  async unlinkAudience(principal: UserPrincipal, campaignId: string) {
    await this.requireOwnedDraft(principal, campaignId);

    const link = await this.prisma.campaignAudienceLink.findFirst({ where: { campaignId } });
    if (!link) throw new OolixError('CAMP_001', 'This campaign has no linked audience.');

    const dependent = await this.prisma.partnerRequest.count({
      where: { campaignId, targetingSource: 'AUDIENCE_GROUP', status: { not: 'REJECTED' } },
    });
    if (dependent > 0) {
      throw new OolixError(
        'CAMP_002',
        'Partner requests on this campaign target this audience; remove them first.',
      );
    }

    await this.prisma.campaignAudienceLink.delete({
      where: {
        campaignId_audienceGroupId: { campaignId, audienceGroupId: link.audienceGroupId },
      },
    });

    await this.audit.record({
      action: 'CAMPAIGN_AUDIENCE_UNLINKED',
      entityType: 'campaign',
      entityId: campaignId,
      orgId: principal.orgId,
      actor: principal.userId,
      metadata: { audience_group_id: link.audienceGroupId },
    });

    return { campaign_id: campaignId, audience: null };
  }

  async addPartnerRequest(
    principal: UserPrincipal,
    campaignId: string,
    input: CreatePartnerRequestInput,
  ) {
    const campaign = await this.requireOwnedDraft(principal, campaignId);

    // v6 §19: two targeting shapes, and the request must resolve to exactly
    // one. `targeting` normalises both into the fields the rest of this method
    // needs -- allowed categories, allowed channels, a currency -- so the
    // validation below is identical whichever path a Buyer took.
    const targeting = input.segment_id
      ? await this.resolveSegmentTargeting(input.partner_org_id, input.segment_id)
      : await this.resolveAudienceTargeting(
          campaignId,
          input.partner_org_id,
          input.reach_estimate_id,
        );
    const segment = targeting.segment;

    // §37: a Partner that is not READY_FOR_CAMPAIGNS cannot serve, so letting
    // a Buyer request it would produce an activation that can never go live.
    //
    // Readiness is EVALUATED here rather than read from the persisted field.
    // That field is a cache refreshed on Partner-side writes, so it can lag
    // reality -- an Agent revoked minutes ago would still read READY. Gating
    // real supply on a stale cache is exactly the kind of mistake §37's
    // "derived from observable facts" framing is meant to prevent.
    const readiness = await this.partnerProfiles.evaluateReadiness(input.partner_org_id);
    if (readiness.readiness !== 'READY_FOR_CAMPAIGNS') {
      throw new OolixError(
        'PART_002',
        `Partner is not ready for campaigns (status: ${readiness.readiness}; ` +
          `blocking: ${readiness.blocking.join(', ') || 'none'}).`,
      );
    }

    // §41 / §37: the Partner's own category policy is applied before the
    // request is ever shown to an approver.
    await this.assertCategoryAllowed(
      input.partner_org_id,
      campaign.category,
      targeting.policyOverlay,
    );

    for (const ch of input.channels) {
      await this.assertChannelRequestValid(
        ch,
        { allowedChannels: targeting.allowedChannels },
        input.partner_org_id,
      );
    }

    const creatives = await this.prisma.creativeVersion.findMany({
      where: { id: { in: input.creative_version_ids }, campaignId },
    });
    if (creatives.length !== input.creative_version_ids.length) {
      throw new OolixError(
        'VAL_001',
        'One or more creative versions do not belong to this campaign.',
      );
    }
    // §70: "Only READY creative versions can be submitted to Partner approval."
    const notReady = creatives.filter((c) => c.status !== 'READY');
    if (notReady.length > 0) {
      throw new OolixError('VAL_001', 'All creatives must be READY before requesting approval.', {
        fieldErrors: notReady.map((c) => ({
          field: 'creative_version_ids',
          message: `${c.id} is ${c.status}`,
        })),
      });
    }

    const requested = input.channels.reduce((sum, c) => sum + BigInt(c.allocation_minor), 0n);
    await this.assertBudgetCoversAllocations(campaignId, campaign.budgetMinor, requested);

    const existing = await this.prisma.partnerRequest.findFirst({
      where: { campaignId, partnerOrgId: input.partner_org_id },
      orderBy: { requestVersion: 'desc' },
    });
    if (existing && ['DRAFT', 'PARTNER_REVIEW', 'APPROVED'].includes(existing.status)) {
      throw new OolixError(
        'CAMP_002',
        'This campaign already has an active request for that Partner.',
      );
    }

    const requestVersion = (existing?.requestVersion ?? 0) + 1;

    const request = await this.prisma.$transaction(async (tx) => {
      const created = await tx.partnerRequest.create({
        data: {
          campaignId,
          partnerOrgId: input.partner_org_id,
          // §19: exactly one of these is set. `targetingSource` says which,
          // so nothing downstream has to infer it from a null.
          segmentId: targeting.segmentId,
          targetingSource: targeting.source,
          audienceGroupId: targeting.audienceGroupId,
          audienceVersion: targeting.audienceVersion,
          // §10: frozen at request time. The Partner's approval binds to this
          // value, not to whatever the audience says later.
          audienceRuleHash: targeting.ruleHash,
          reachEstimateId: targeting.reachEstimateId,
          requestVersion,
          status: 'DRAFT',
          audienceExpansionAllowed: input.audience_expansion_allowed,
          // §40.9: an immutable snapshot is frozen at submit. Storing the
          // request shape now means the Partner approves exactly what was
          // shown, not a live join that could change underneath them.
          snapshotJson: {
            campaign: {
              name: campaign.name,
              objective: campaign.objective,
              category: campaign.category,
              purpose_id: campaign.purposeId,
              start_at: campaign.startAt.toISOString(),
              end_at: campaign.endAt.toISOString(),
              geographies: campaign.geographies,
              landing_url: campaign.landingUrl,
              lead_definition: campaign.leadDefinition,
            },
            // §40.9: whichever shape was targeted, frozen. The Partner
            // approves what is recorded here, not a live join.
            segment: segment
              ? {
                  id: segment.id,
                  internal_key: segment.internalKey,
                  display_name: segment.displayName,
                  reach_bucket: toWireBucket(segment.reachBucket),
                }
              : null,
            audience: targeting.audienceSnapshot,
            channels: input.channels,
            creative_version_ids: input.creative_version_ids,
            audience_expansion_allowed: input.audience_expansion_allowed,
          } as never,
        },
      });

      for (const ch of input.channels) {
        await tx.channelRequest.create({
          data: {
            requestId: created.id,
            channel: ch.channel as never,
            placementIds: ch.placement_ids,
            allocationMinor: BigInt(ch.allocation_minor),
            frequencyCap: ch.frequency_cap as never,
            creativeVersionIds: input.creative_version_ids,
          },
        });
      }

      for (const cvId of input.creative_version_ids) {
        await tx.partnerCreativeDecision.create({
          data: { partnerRequestId: created.id, creativeVersionId: cvId, status: 'PENDING' },
        });
      }

      if (input.partner_payout) {
        const offer = segment?.offers[0];
        await tx.commercialTerms.create({
          data: {
            requestId: created.id,
            pricingModel: input.partner_payout.model as never,
            unitPriceMinor: BigInt(input.partner_payout.unit_price_minor),
            currency: offer?.currency ?? campaign.currency,
            maxBudgetMinor: requested,
          },
        });
      }

      return created;
    });

    await this.audit.record({
      action: 'PARTNER_REQUEST_DRAFTED',
      entityType: 'partner_request',
      entityId: request.id,
      orgId: principal.orgId,
      metadata: {
        partner_org_id: input.partner_org_id,
        channels: input.channels.map((c) => c.channel),
      },
    });

    return {
      request_id: request.id,
      status: request.status,
      request_version: request.requestVersion,
      channel_requests: input.channels.map((c) => ({
        channel: c.channel,
        // §13: one activation per Partner x channel, allocated at approval.
        provisional_activation_id: null,
        allocation_minor: c.allocation_minor,
      })),
    };
  }

  /**
   * v6 §19: the legacy prebuilt-segment path.
   *
   * Unchanged from v5 -- a Partner with an existing CDP audience can still be
   * activated, and §80's N-1 rule means both shapes have to keep working while
   * Buyers migrate.
   */
  private async resolveSegmentTargeting(partnerOrgId: string, segmentId: string) {
    const segment = await this.prisma.segment.findFirst({
      where: { id: segmentId, partnerOrgId, status: 'PUBLISHED' },
      include: { organization: true, offers: true },
    });
    if (!segment) {
      throw new OolixError('PART_001', 'Segment not found or not published by that Partner.');
    }

    return {
      source: 'PREBUILT_SEGMENT' as const,
      segment,
      segmentId: segment.id,
      audienceGroupId: null,
      audienceVersion: null,
      ruleHash: null,
      reachEstimateId: null,
      audienceSnapshot: null,
      allowedChannels: segment.allowedChannels,
      policyOverlay: {
        allowedCategories: segment.allowedCategories,
        blockedCategories: segment.blockedCategories,
      },
    };
  }

  /**
   * v6 §9 steps 4-6: target the campaign's linked Audience Group at one Partner.
   *
   * The checks here are what stop a Buyer routing around §7. A Partner is
   * selectable only if a match snapshot says they can actually evaluate the
   * rules; a Partner that is INCOMPATIBLE is one whose data cannot answer a
   * REQUIRED question, and asking them anyway would produce an activation that
   * silently serves the wrong people.
   */
  private async resolveAudienceTargeting(
    campaignId: string,
    partnerOrgId: string,
    reachEstimateId?: string,
  ) {
    const link = await this.prisma.campaignAudienceLink.findFirst({
      where: { campaignId },
      include: { audienceGroup: true, audienceVersionRef: true },
    });
    if (!link) {
      throw new OolixError(
        'CAMP_002',
        'This campaign has no linked audience. Link an Audience Group first, or pass a segment_id for the legacy path.',
        { fieldErrors: [{ field: 'segment_id', message: 'required when no audience is linked' }] },
      );
    }

    const snapshot = await this.prisma.partnerMatchSnapshot.findFirst({
      where: {
        audienceGroupId: link.audienceGroupId,
        audienceVersion: link.audienceVersion,
        partnerOrgId,
      },
      orderBy: { capabilityVersion: 'desc' },
    });
    if (!snapshot) {
      throw new OolixError(
        'PART_001',
        'This Partner has not been matched against this audience version. Open Partner matches first.',
      );
    }
    if (snapshot.status === 'INCOMPATIBLE') {
      const missing = (snapshot.missingRequiredJson as string[] | null) ?? [];
      // §7: a missing REQUIRED attribute is not a lower score, it is a "no".
      // Naming the attribute lets the Buyer relax the rule rather than guess.
      throw new OolixError(
        'PART_002',
        `This Partner cannot evaluate a required rule in this audience${
          missing.length > 0 ? ` (${missing.join(', ')})` : ''
        }.`,
      );
    }

    // §9: the Buyer chose this Partner while looking at a reach estimate, so
    // that estimate is frozen onto the request. It must belong to this Partner
    // and this exact audience version -- an estimate for a different version
    // describes a different audience.
    let estimateId: string | null = null;
    if (reachEstimateId) {
      const estimate = await this.prisma.reachEstimate.findFirst({
        where: {
          id: reachEstimateId,
          partnerOrgId,
          audienceGroupId: link.audienceGroupId,
          audienceVersion: link.audienceVersion,
        },
      });
      if (!estimate) {
        throw new OolixError(
          'VAL_001',
          'That reach estimate is not for this Partner and audience version.',
          {
            fieldErrors: [
              { field: 'reach_estimate_id', message: 'unknown for this audience version' },
            ],
          },
        );
      }
      if (estimate.ruleHash !== link.ruleHash) {
        throw new OolixError(
          'VAL_001',
          'That reach estimate was produced for different audience rules.',
        );
      }
      estimateId = estimate.id;
    }

    const capability = await this.prisma.partnerCapability.findFirst({
      where: { partnerOrgId, status: 'ACTIVE' },
      orderBy: { capabilityVersion: 'desc' },
    });
    const channels = ((capability?.channelsJson as string[] | null) ?? []).filter(
      // §7/§15: an external channel a Partner merely declares is CONDITIONAL,
      // not usable, until the eligibility gate passes. assertChannelRequestValid
      // enforces the feature flag; excluding them here means the Buyer is told
      // "not permitted" rather than being silently allowed to request one.
      (c) => c !== 'META' && c !== 'GOOGLE',
    );

    return {
      source: 'AUDIENCE_GROUP' as const,
      segment: null,
      segmentId: null,
      audienceGroupId: link.audienceGroupId,
      audienceVersion: link.audienceVersion,
      ruleHash: link.ruleHash,
      reachEstimateId: estimateId,
      audienceSnapshot: {
        audience_group_id: link.audienceGroupId,
        audience_group_name: link.audienceGroup.name,
        audience_version: link.audienceVersion,
        rule_hash: link.ruleHash,
        // §10's review table: the Partner sees the rules they are approving,
        // split by required and optional exactly as §10 lists them.
        rules: link.audienceVersionRef.rulesJson,
        capability_version: snapshot.capabilityVersion,
        match_status: snapshot.status,
        supported_rules: snapshot.supportedRulesJson,
        missing_optional_rules: snapshot.missingOptionalJson,
        reach_estimate_id: estimateId,
      },
      allowedChannels: channels,
      // With no segment there is no segment-level category overlay; the
      // Partner's own policy is the only gate, which is what §41 describes.
      policyOverlay: { allowedCategories: [], blockedCategories: [] },
    };
  }

  private async assertCategoryAllowed(
    partnerOrgId: string,
    campaignCategory: string,
    segment: { allowedCategories: string[]; blockedCategories: string[] },
  ): Promise<void> {
    const policy = await this.prisma.partnerPolicy.findFirst({
      where: { partnerOrgId },
      orderBy: { version: 'desc' },
    });

    const cat = campaignCategory.toLowerCase();
    const blocked = [...(policy?.blockedCategories ?? []), ...segment.blockedCategories].map((c) =>
      c.toLowerCase(),
    );
    if (blocked.includes(cat)) {
      throw new OolixError(
        'PART_002',
        `This Partner does not accept "${campaignCategory}" advertisers.`,
      );
    }

    const allowed = [...(policy?.allowedCategories ?? []), ...segment.allowedCategories].map((c) =>
      c.toLowerCase(),
    );
    if (allowed.length > 0 && !allowed.includes(cat)) {
      throw new OolixError(
        'PART_002',
        `Category "${campaignCategory}" is outside this Partner's allowed categories.`,
      );
    }
  }

  private async assertChannelRequestValid(
    ch: { channel: Channel; placement_ids: string[] },
    segment: { allowedChannels: string[] },
    partnerOrgId: string,
  ): Promise<void> {
    if (!segment.allowedChannels.includes(ch.channel)) {
      throw new OolixError('VAL_001', `Segment does not permit channel ${ch.channel}.`, {
        fieldErrors: [{ field: 'channels', message: `${ch.channel} not allowed for this segment` }],
      });
    }

    // §84 / §32: an external channel behind a disabled flag must not even be
    // requestable -- §32 says "do not show Google as selectable" until the
    // eligibility model is proven.
    if (isExternalChannel(ch.channel)) {
      const enabled =
        ch.channel === 'META'
          ? this.config.FEATURE_META_ENABLED
          : this.config.FEATURE_GOOGLE_ENABLED;
      if (!enabled) {
        throw new OolixError(
          'CHAN_001',
          `${ch.channel} activation is not enabled on this deployment (spec §84). ` +
            'Partner-owned website and app channels remain available.',
        );
      }
    }

    if (ch.placement_ids.length > 0) {
      const placements = await this.prisma.placement.findMany({
        where: { id: { in: ch.placement_ids }, partnerOrgId, status: 'ACTIVE' },
      });
      if (placements.length !== ch.placement_ids.length) {
        // §76.2: "every placement must be Partner-published and explicitly
        // approved."
        throw new OolixError('PART_001', 'One or more placements are unknown or not active.');
      }
    } else if (!isExternalChannel(ch.channel)) {
      throw new OolixError('VAL_001', `Channel ${ch.channel} requires at least one placement.`, {
        fieldErrors: [{ field: 'placement_ids', message: 'required for partner-owned channels' }],
      });
    }
  }

  /**
   * §40.6 / §67: the sum of allocations must not exceed the campaign budget.
   *
   * "Sum of allocations must be <= total budget; reserve/unallocated amount
   * allowed if configured."
   */
  private async assertBudgetCoversAllocations(
    campaignId: string,
    budgetMinor: bigint,
    additionalMinor = 0n,
  ): Promise<void> {
    const rows = await this.prisma.channelRequest.findMany({
      where: {
        request: {
          campaignId,
          // A rejected or expired request no longer reserves budget.
          status: { in: ['DRAFT', 'PARTNER_REVIEW', 'CHANGE_REQUESTED', 'APPROVED'] },
        },
      },
      select: { allocationMinor: true },
    });

    const allocated = rows.reduce((sum, r) => sum + r.allocationMinor, 0n) + additionalMinor;

    if (allocated > budgetMinor) {
      throw new OolixError(
        'CAMP_003',
        `Allocations (${allocated}) exceed the campaign budget (${budgetMinor}).`,
        {
          fieldErrors: [
            { field: 'allocation_minor', message: `${allocated - budgetMinor} over budget` },
          ],
        },
      );
    }
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  async get(principal: UserPrincipal, campaignId: string) {
    const campaign = await this.prisma.campaign.findFirst({
      where: { id: campaignId, buyerOrgId: principal.orgId },
      include: {
        partnerRequests: {
          include: {
            organization: { select: { id: true, name: true } },
            segment: { select: { id: true, displayName: true, reachBucket: true } },
            audienceGroup: { select: { id: true, name: true } },
            reachEstimate: { select: { reachBucket: true, status: true } },
            channelRequests: true,
            activations: true,
          },
        },
        creativeVersions: true,
      },
    });
    if (!campaign) throw new OolixError('CAMP_001', 'Campaign not found.');

    const activationStates = campaign.partnerRequests.flatMap((r) =>
      r.activations.map((a) => a.status as ActivationState),
    );
    const allResolved = campaign.partnerRequests.every((r) =>
      ['APPROVED', 'REJECTED', 'REVOKED', 'EXPIRED'].includes(r.status),
    );

    const allocated = campaign.partnerRequests
      .flatMap((r) => r.channelRequests)
      .reduce((sum, c) => sum + c.allocationMinor, 0n);

    return {
      ...this.toWire(campaign),
      // §42: a projection over the activations, never a stored field that
      // could disagree with them.
      derived_status: deriveCampaignState(activationStates, {
        submitted: campaign.status !== 'DRAFT',
        allRequestsResolved: allResolved,
      }),
      budget: {
        total_minor: Number(campaign.budgetMinor),
        allocated_minor: Number(allocated),
        unallocated_minor: Number(campaign.budgetMinor - allocated),
        currency: campaign.currency,
      },
      partner_requests: campaign.partnerRequests.map((r) => ({
        request_id: r.id,
        partner: { id: r.organization.id, display_name: r.organization.name },
        // v6 §19: a request targets either an Audience Group (the primary
        // path) or a prebuilt segment. Both render; exactly one is set.
        targeting_source: r.targetingSource,
        audience: r.audienceGroup
          ? {
              audience_group_id: r.audienceGroupId,
              name: r.audienceGroup.name,
              audience_version: r.audienceVersion,
              rule_hash: r.audienceRuleHash,
              reach_bucket: toWireBucket(r.reachEstimate?.reachBucket ?? null),
            }
          : null,
        segment: r.segment
          ? {
              id: r.segment.id,
              display_name: r.segment.displayName,
              reach_bucket: toWireBucket(r.segment.reachBucket),
            }
          : null,
        status: r.status,
        request_version: r.requestVersion,
        expires_at: r.expiresAt?.toISOString() ?? null,
        channels: r.channelRequests.map((c) => ({
          channel: c.channel,
          placement_ids: c.placementIds,
          allocation_minor: Number(c.allocationMinor),
          frequency_cap: c.frequencyCap,
        })),
        activations: r.activations.map((a) => ({
          activation_id: a.id,
          channel: a.channel,
          status: a.status,
          status_reason: a.statusReason,
        })),
      })),
      creatives: campaign.creativeVersions.map((c) => ({
        creative_version_id: c.id,
        version: c.version,
        type: c.type,
        status: c.status,
      })),
    };
  }

  async list(principal: UserPrincipal) {
    const rows = await this.prisma.campaign.findMany({
      where: { buyerOrgId: principal.orgId },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return { items: rows.map((r) => this.toWire(r)), next_cursor: null };
  }

  private async requireOwnedDraft(principal: UserPrincipal, campaignId: string) {
    const campaign = await this.prisma.campaign.findFirst({
      where: { id: campaignId, buyerOrgId: principal.orgId },
    });
    if (!campaign) throw new OolixError('CAMP_001', 'Campaign not found.');
    if (campaign.status !== 'DRAFT') {
      throw new OolixError(
        'CAMP_002',
        `Campaign is ${campaign.status}; only DRAFT campaigns can be edited.`,
      );
    }
    return campaign;
  }

  private toWire(c: {
    id: string;
    name: string;
    objective: string;
    category: string;
    purposeId: string;
    budgetMinor: bigint;
    currency: string;
    status: string;
    startAt: Date;
    endAt: Date;
    geographies: string[];
    landingUrl: string | null;
    leadDefinition: unknown;
    version: number;
    createdAt: Date;
  }) {
    return {
      id: c.id,
      name: c.name,
      objective: c.objective,
      category: c.category,
      purpose_id: c.purposeId,
      budget: { amount_minor: Number(c.budgetMinor), currency: c.currency },
      status: c.status,
      start_at: c.startAt.toISOString(),
      end_at: c.endAt.toISOString(),
      geographies: c.geographies,
      landing_url: c.landingUrl,
      lead_definition: c.leadDefinition,
      version: c.version,
      created_at: c.createdAt.toISOString(),
    };
  }
}
