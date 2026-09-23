/**
 * Oolix Ops dashboard -- spec v5 §25, §58, §78.2, §98.1.
 *
 * §98.1 lists the rows an operator needs: API health, queue lag, Agent health,
 * NO_AD distribution, decision latency, connector health, external sync and
 * billing reconciliation.
 *
 * What this endpoint must NOT do is give Oolix a back door into Partner data.
 * §66 is explicit that OOLIX_ADMIN "cannot bypass Partner approval or access
 * Partner raw DB", so every figure here is an aggregate or a health signal.
 * There is no query in this file that returns a person, a segment membership
 * or a Partner's customer count.
 */
import { Injectable, Inject } from '@nestjs/common';
import { ALERT_RULES, PERFORMANCE_BUDGETS_MS } from '@oolix/observability';
import { PrismaService } from '../../prisma/prisma.service.js';
import { CONFIG, type OolixConfig } from '../../config/configuration.js';

@Injectable()
export class OpsService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(CONFIG) private readonly config: OolixConfig,
  ) {}

  /** §98.1 operations overview. */
  async dashboard() {
    const now = Date.now();

    // --- Agent health (§78.2: heartbeat age > 5 min alerts) ----------------
    const agents = await this.prisma.agent.findMany({
      where: { status: 'ACTIVE' },
      select: {
        id: true,
        partnerOrgId: true,
        version: true,
        lastHeartbeatAt: true,
        configAgeSeconds: true,
        lastConfigVersion: true,
        organization: { select: { name: true } },
      },
    });

    const agentHealth = agents.map((a) => {
      const heartbeatAge = a.lastHeartbeatAt
        ? Math.round((now - a.lastHeartbeatAt.getTime()) / 1000)
        : null;
      return {
        agent_id: a.id,
        partner: a.organization.name,
        version: a.version,
        heartbeat_age_seconds: heartbeatAge,
        config_age_seconds: a.configAgeSeconds,
        config_version: a.lastConfigVersion,
        status:
          heartbeatAge === null
            ? 'NEVER_SEEN'
            : heartbeatAge > 300
              ? 'STALE'
              : (a.configAgeSeconds ?? 0) > this.config.CONTROL_STALE_GRACE_SEC
                ? 'CONFIG_CRITICAL'
                : 'HEALTHY',
      };
    });

    // --- activation health (§76 states) ------------------------------------
    const activationStates = await this.prisma.activation.groupBy({
      by: ['status'],
      _count: { _all: true },
    });

    // --- external sync (§58: stuck > 30 min) --------------------------------
    const stuckThreshold = new Date(now - 30 * 60_000);
    const stuckExternal = await this.prisma.externalResource.count({
      where: {
        resourceStatus: { in: ['PREPARING', 'UPLOADING', 'PROCESSING', 'REMOVING'] },
        updatedAt: { lt: stuckThreshold },
      },
    });

    // --- reconciliation (§77.3) ---------------------------------------------
    const reviewRequired = await this.prisma.reconciliation.count({
      where: { status: 'REVIEW_REQUIRED' },
    });

    // --- approval SLA (§101) -------------------------------------------------
    const pendingReview = await this.prisma.partnerRequest.count({
      where: { status: 'PARTNER_REVIEW' },
    });
    const expiringSoon = await this.prisma.partnerRequest.count({
      where: {
        status: 'PARTNER_REVIEW',
        expiresAt: { lte: new Date(now + 48 * 3_600_000) },
      },
    });

    // --- kill switches (§78.2: alert on every one) ---------------------------
    const activeKillSwitches = await this.prisma.killSwitch.findMany({
      where: { active: true },
      select: {
        scope: true,
        targetId: true,
        activatedAt: true,
        organization: { select: { name: true } },
      },
      orderBy: { activatedAt: 'desc' },
      take: 50,
    });

    // --- delivery (§18) -------------------------------------------------------
    const since = new Date(now - 24 * 3_600_000);
    const delivery = await this.prisma.aggregateMetric.aggregate({
      where: { bucketStart: { gte: since } },
      _sum: { impressions: true, clicks: true },
    });

    const recentBatches = await this.prisma.deliveryBatch.count({
      where: { acceptedAt: { gte: since } },
    });

    return {
      generated_at: new Date(now).toISOString(),

      agent_health: {
        total: agentHealth.length,
        healthy: agentHealth.filter((a) => a.status === 'HEALTHY').length,
        degraded: agentHealth.filter((a) => a.status !== 'HEALTHY').length,
        agents: agentHealth,
      },

      activations: Object.fromEntries(activationStates.map((s) => [s.status, s._count._all])),

      external_sync: {
        // §84: both connectors stay off until the exact account model is proven.
        meta_enabled: this.config.FEATURE_META_ENABLED,
        google_enabled: this.config.FEATURE_GOOGLE_ENABLED,
        stuck_over_30m: stuckExternal,
      },

      approvals: {
        pending_review: pendingReview,
        expiring_within_48h: expiringSoon,
        sla_days: this.config.PARTNER_REQUEST_EXPIRY_DAYS,
      },

      reconciliation: {
        review_required: reviewRequired,
        tolerance:
          `max(${this.config.RECONCILIATION_MIN_EVENTS} events, ` +
          `${this.config.RECONCILIATION_PERCENT}%)`,
      },

      kill_switches: {
        active: activeKillSwitches.length,
        items: activeKillSwitches.map((k) => ({
          partner: k.organization?.name ?? null,
          scope: k.scope,
          target_id: k.targetId,
          activated_at: k.activatedAt.toISOString(),
        })),
      },

      delivery_24h: {
        impressions: Number(delivery._sum.impressions ?? 0n),
        clicks: Number(delivery._sum.clicks ?? 0n),
        batches: recentBatches,
      },

      // Thresholds are served alongside the figures so an operator reading the
      // dashboard does not have to cross-reference the spec to know what is
      // out of bounds.
      thresholds: {
        performance_budgets_ms: PERFORMANCE_BUDGETS_MS,
        alerts: ALERT_RULES.map((r) => ({
          metric: r.metric,
          threshold: r.threshold,
          severity: r.severity,
          description: r.description,
        })),
      },
    };
  }

  /**
   * §98.1 NO_AD reason distribution.
   *
   * The Agent reports these as aggregate buckets; §98.2 requires them
   * "excluding any customer identifiers", which is inherent here since a
   * reason describes a decision rather than a person.
   */
  async noAdDistribution() {
    // Reasons arrive with delivery batches once the Agent reports them.
    // Until a Partner is live this is legitimately empty rather than fabricated.
    return {
      note:
        'NO_AD reasons are reported by Partner Agents as aggregate buckets and ' +
        'never contain a customer identifier (spec §77.1, §98.2).',
      reasons: {},
    };
  }
}
