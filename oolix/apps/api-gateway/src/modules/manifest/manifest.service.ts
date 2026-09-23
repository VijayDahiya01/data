/**
 * Manifest generation and control sync -- spec v5 §11.2, §75, §52.4.
 *
 * A manifest is the ONLY authorisation a Partner Agent has to serve an ad or
 * start an external upload (§11.2). It is:
 *
 *   signed    ES256 over canonical JSON, so tampering is detectable
 *   bound     to one Partner and one activation, so it cannot be replayed
 *   expiring  config_expires_at bounds the offline cache (§75)
 *   versioned so an Agent can detect drift and Oolix can revoke
 *
 * Manifests are re-signed rather than edited. §70's rollback rule -- "never
 * mutating the approved object in place" -- applies to the manifest too: a
 * budget or policy change produces a NEW version, and the Agent switches only
 * once it has verified it.
 */
import { Injectable, Inject } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { OolixError, durationToSeconds, type Channel } from '@oolix/contracts';
import { signManifest, type ManifestCreative, type ManifestPayload } from '@oolix/manifest-schema';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AuditService } from '../../common/audit/audit.service.js';
import { AgentKeyService } from '../../keys/agent-key.service.js';
import { CONFIG, type OolixConfig } from '../../config/configuration.js';
import { toBytes } from '../../common/bytes.js';

@Injectable()
export class ManifestService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(AgentKeyService) private readonly keys: AgentKeyService,
    @Inject(CONFIG) private readonly config: OolixConfig,
  ) {}

  /**
   * Build and sign a manifest for one activation.
   *
   * Everything in the payload comes from the APPROVAL, not from the original
   * request: the Partner may have approved a subset of channels, placements,
   * creatives or budget (§41), and the Agent must enforce what was approved.
   */
  async signForActivation(activationId: string): Promise<{ manifestVersion: number; jws: string }> {
    const activation = await this.prisma.activation.findUnique({
      where: { id: activationId },
      include: {
        request: {
          include: {
            campaign: true,
            segment: true,
            // v6 Appendix B: the approved audience travels in the manifest so
            // the Agent can compile and materialize it locally (§11).
            audienceGroup: true,
            audienceVersionRef: true,
            reachEstimate: true,
            channelRequests: true,
            approvals: { where: { decision: 'APPROVE' }, orderBy: { approvedAt: 'desc' }, take: 1 },
            creativeDecisions: {
              where: { status: 'APPROVED' },
              include: { creativeVersion: true },
            },
          },
        },
        placement: true,
      },
    });
    if (!activation) throw new OolixError('CAMP_001', 'Activation not found.');

    const request = activation.request;
    const approval = request.approvals[0];
    if (!approval) {
      // §11.2: no valid approval means no manifest, and therefore no ad.
      throw new OolixError('CAMP_002', 'Cannot sign a manifest without an approval (spec §11.2).');
    }

    const channelRequest = request.channelRequests.find((c) => c.channel === activation.channel);
    if (!channelRequest) {
      throw new OolixError('CAMP_002', 'Activation has no matching channel request.');
    }

    const approvedCreatives = request.creativeDecisions.map((d) => d.creativeVersion);
    if (approvedCreatives.length === 0) {
      throw new OolixError('CAMP_002', 'No approved creative versions for this activation.');
    }

    // Resolve placement keys so the Agent matches on its own published keys
    // without needing a lookup against Oolix at decision time (§75 offline).
    const approvedPlacementIds =
      approval.approvedPlacementIds.length > 0
        ? channelRequest.placementIds.filter((p) => approval.approvedPlacementIds.includes(p))
        : channelRequest.placementIds;

    const placements = await this.prisma.placement.findMany({
      where: { id: { in: approvedPlacementIds }, status: 'ACTIVE' },
      select: { id: true, placementKey: true },
    });

    const policy = await this.prisma.partnerPolicy.findFirst({
      where: { partnerOrgId: request.partnerOrgId },
      orderBy: { version: 'desc' },
    });

    const nextVersion = activation.manifestVersion + 1;
    const now = new Date();
    const configExpiresAt = new Date(now.getTime() + this.config.MANIFEST_CONFIG_TTL_SEC * 1000);

    const cap = channelRequest.frequencyCap as { max_impressions: number; window: string };
    // Fail fast on a malformed window: the Agent cannot enforce a cap it
    // cannot parse, and an unenforceable cap is worse than a rejected sign.
    durationToSeconds(cap.window);

    const payload: ManifestPayload = {
      manifest_version: nextVersion,
      activation_id: activation.id,
      partner_org_id: request.partnerOrgId,
      // v6 §19: one of these two paths, never both. A prebuilt segment stays
      // valid supply; an Audience Group is the primary path.
      segment_id: request.segmentId,
      segment_key: request.segment?.internalKey ?? null,

      // v6 Appendix B. The Agent compiles these rules against its own mapping
      // and materializes the matching members locally (§11) -- Oolix never
      // learns who they are. `rule_hash` is what lets the Agent confirm it is
      // serving exactly what the Partner approved (§10).
      audience:
        request.audienceGroup && request.audienceVersionRef
          ? {
              audience_group_id: request.audienceGroup.id,
              audience_version: request.audienceVersionRef.version,
              rule_hash: request.audienceVersionRef.ruleHash,
              rules: request.audienceVersionRef.rulesJson as never,
              reach_estimate_id: request.reachEstimateId,
              capability_version: request.reachEstimate?.capabilityVersion ?? null,
              mapping_version: request.reachEstimate?.mappingVersion ?? null,
            }
          : null,
      channel: activation.channel as Channel,
      placement_ids: placements.map((p) => p.id),
      placement_keys: placements.map((p) => p.placementKey),
      creative_version_ids: approvedCreatives.map((c) => c.id),
      budget: {
        // §73: budgets are BIGINT. Serialized as a decimal string so JSON
        // number precision cannot silently truncate a large allocation.
        allocation_minor: activation.budgetMinor.toString(),
        currency: activation.currency,
        // §76.1: the Agent stops locally at 98%, reserving headroom for
        // reporting lag.
        local_stop_fraction: 0.98,
      },
      frequency_cap: cap,
      purpose_id: request.campaign.purposeId,
      policy_version: policy ? `P-${policy.version}` : 'P-0',
      allowed_categories: policy?.allowedCategories ?? [],
      blocked_categories: policy?.blockedCategories ?? [],
      campaign_category: request.campaign.category,
      issued_at: now.toISOString(),
      config_expires_at: configExpiresAt.toISOString(),
      start_at: request.campaign.startAt.toISOString(),
      end_at: request.campaign.endAt.toISOString(),
      approval_reference: approval.id,
      audience_expansion_allowed: request.audienceExpansionAllowed,
    };

    const jws = await signManifest(payload, this.keys.manifestSigner(), {
      kid: this.keys.manifestKid(),
      issuer: this.config.MANIFEST_ISSUER,
      audience: this.config.MANIFEST_AUDIENCE,
    });

    await this.prisma.$transaction(async (tx) => {
      // Supersede any earlier manifest for this activation so a stale version
      // cannot be served alongside the new one.
      await tx.manifest.updateMany({
        where: { activationId: activation.id, revokedAt: null },
        data: { revokedAt: now },
      });

      await tx.manifest.create({
        data: {
          activationId: activation.id,
          manifestVersion: nextVersion,
          jws,
          kid: this.keys.manifestKid(),
          issuedAt: now,
          configExpiresAt,
          payloadSha256: toBytes(createHash('sha256').update(JSON.stringify(payload)).digest()),
        },
      });

      await tx.activation.update({
        where: { id: activation.id },
        data: { manifestVersion: nextVersion },
      });
    });

    await this.audit.record({
      action: 'MANIFEST_SIGNED',
      entityType: 'activation',
      entityId: activation.id,
      orgId: request.partnerOrgId,
      metadata: {
        manifest_version: nextVersion,
        kid: this.keys.manifestKid(),
        config_expires_at: configExpiresAt.toISOString(),
        policy_version: payload.policy_version,
      },
    });

    return { manifestVersion: nextVersion, jws };
  }

  /**
   * §52.4 GET /agent/v1/config/pull.
   *
   * Returns every currently-valid manifest for this Partner, plus the creative
   * bundle and the kill switches the Agent must enforce locally.
   *
   * Deliberately scoped by the AGENT's partner id from its registration record
   * (§92.4), never by anything in the request, so one Partner's Agent can
   * never pull another Partner's configuration.
   */
  async configPull(partnerOrgId: string, sinceVersion?: number) {
    const now = new Date();

    const activations = await this.prisma.activation.findMany({
      where: {
        request: { partnerOrgId, status: 'APPROVED' },
        status: { in: ['READY', 'SYNCING', 'LIVE'] },
        // Owned-media only. An external activation is driven by the channel
        // adapter, not by the local ad-decision path.
        channel: { in: ['PARTNER_WEB', 'PARTNER_APP'] },
      },
      include: {
        manifests: { where: { revokedAt: null }, orderBy: { manifestVersion: 'desc' }, take: 1 },
        request: {
          include: {
            campaign: true,
            creativeDecisions: {
              where: { status: 'APPROVED' },
              include: { creativeVersion: true },
            },
          },
        },
      },
    });

    const live = activations.filter((a) => {
      const m = a.manifests[0];
      if (!m) return false;
      // A manifest past its config expiry is re-signed below rather than
      // shipped stale.
      return a.request.campaign.endAt.getTime() > now.getTime();
    });

    const manifests: string[] = [];
    const creativeMap = new Map<string, ManifestCreative>();
    let maxVersion = 0;

    for (const activation of live) {
      const manifest = activation.manifests[0]!;

      // Re-sign on pull when the cached manifest is at or near expiry. The
      // Agent polls every 30s (§75), so refreshing here keeps a healthy Agent
      // permanently inside its stale-grace window without a separate job.
      if (manifest.configExpiresAt.getTime() - now.getTime() < 60_000) {
        const resigned = await this.signForActivation(activation.id);
        manifests.push(resigned.jws);
        maxVersion = Math.max(maxVersion, resigned.manifestVersion);
      } else {
        manifests.push(manifest.jws);
        maxVersion = Math.max(maxVersion, manifest.manifestVersion);
      }

      for (const d of activation.request.creativeDecisions) {
        const cv = d.creativeVersion;
        if (creativeMap.has(cv.id)) continue;
        creativeMap.set(cv.id, {
          creative_version_id: cv.id,
          type: cv.type as 'IMAGE' | 'NATIVE_CARD',
          asset_url: cv.assetUri ? `${this.config.CDN_PUBLIC_BASE_URL}/${cv.assetUri}` : null,
          content_sha256: cv.contentSha256 ? Buffer.from(cv.contentSha256).toString('hex') : null,
          width: cv.width,
          height: cv.height,
          headline: cv.headline,
          body: cv.body,
          cta: cv.cta,
          destination_url: cv.destinationUrl ?? '',
          legal_disclaimer: cv.legalDisclaimer,
        });
      }
    }

    // §24: activations the Agent must stop serving immediately, even if it
    // still holds a valid cached manifest for them.
    const revoked = await this.prisma.activation.findMany({
      where: {
        request: { partnerOrgId },
        status: { in: ['ENDING', 'ENDED', 'PAUSED', 'FAILED'] },
      },
      select: { id: true },
    });

    const killSwitches = await this.prisma.killSwitch.findMany({
      where: { partnerOrgId, active: true },
      select: { scope: true, targetId: true },
    });

    return {
      config_version: maxVersion,
      issued_at: now.toISOString(),
      partner_org_id: partnerOrgId,
      manifests,
      creatives: [...creativeMap.values()],
      revoked_activation_ids: revoked.map((r) => r.id),
      kill_switches: killSwitches.map((k) => ({ scope: k.scope, target_id: k.targetId })),
      stale_grace_seconds: this.config.CONTROL_STALE_GRACE_SEC,
      /** Where to fetch verification keys, so a rotation is discoverable (§75). */
      jwks_uri: `${this.config.API_PUBLIC_URL}/.well-known/oolix-manifest-jwks.json`,
      /** Unchanged config short-circuits: the Agent skips re-verification. */
      unchanged: sinceVersion !== undefined && sinceVersion === maxVersion,
    };
  }

  /** §52.4 POST /agent/v1/config/ack -- the Agent confirms what it applied. */
  async configAck(agentId: string, partnerOrgId: string, configVersion: number) {
    await this.prisma.agent.update({
      where: { id: agentId },
      data: { lastConfigVersion: configVersion, configAgeSeconds: 0 },
    });

    await this.audit.record({
      action: 'AGENT_CONFIG_ACKED',
      entityType: 'agent',
      entityId: agentId,
      orgId: partnerOrgId,
      actorType: 'AGENT',
      metadata: { config_version: configVersion },
    });

    return { acknowledged: true, config_version: configVersion };
  }
}
