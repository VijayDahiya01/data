/**
 * Audience Groups, capability matching and reach estimates — v6 §4–§8.
 *
 * The v6 flow in one place: a Buyer describes an audience, Oolix works out
 * which Partners can evaluate that description, and selected Partners compute a
 * safe reach estimate locally.
 *
 * The privacy line does not move. This service stores rules and capability
 * metadata; it never learns which people match, never sees a Partner's local
 * field names, and never receives an exact count — §8.2 has the Agent apply the
 * minimum cohort threshold and return a bucket, and §17 restates it as a rule.
 */
import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import {
  canonicalAudienceRules,
  matchPartner,
  OolixError,
  REACH_ESTIMATE_MIN_REFRESH_MINUTES,
  REACH_ESTIMATE_TTL_HOURS,
  type AudienceRule,
  type MatchResult,
  type PartnerCapability,
  type RuleOperator,
} from '@oolix/contracts';
import type { UserPrincipal } from '@oolix/auth-rbac';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AuditService } from '../../common/audit/audit.service.js';
import { toWireBucket } from '../../common/reach.js';
import type {
  CreateAudienceInput,
  PublishCapabilitiesInput,
  UpdateAudienceInput,
} from './audience.schema.js';

interface TaxonomyEntry {
  key: string;
  dataType: string;
  operators: RuleOperator[];
  allowedValues: string[] | null;
  minValue: number | null;
  maxValue: number | null;
  policyClass: string;
}

/* --- Buyer-facing state (points 3, 13, 14) --------------------------------- */

/**
 * What a Buyer is told about an audience as a whole.
 *
 * "In Use" is not a stored status: it is READY plus at least one campaign
 * linked to it. Keeping it derived means it can never drift from the links
 * themselves, and it answers the question that actually changes a Buyer's
 * behaviour — editing this will not touch a running campaign.
 */
function groupDisplayStatus(status: string, linkedCampaigns: number): string {
  if (status === 'ARCHIVED') return 'Archived';
  if (status === 'DRAFT') return 'Draft';
  return linkedCampaigns > 0 ? 'In Use' : 'Ready';
}

/**
 * What a Buyer is told about one set of saved settings.
 *
 * SUPERSEDED is an accurate word for what the system did and a poor one for
 * what happened: the Buyer edited their audience, and the older settings are
 * still the ones their existing campaigns run on. "Previous settings" says
 * that; "superseded" suggests something was withdrawn.
 */
function versionDisplayStatus(status: string, isCurrent: boolean): string {
  if (isCurrent) return status === 'DRAFT' ? 'Draft' : 'Current settings';
  if (status === 'SUPERSEDED') return 'Previous settings';
  if (status === 'DRAFT') return 'Draft';
  return 'Previous settings';
}

@Injectable()
export class AudienceService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  /* --- taxonomy (§4) ------------------------------------------------------- */

  async taxonomy() {
    const rows = await this.prisma.attributeDefinition.findMany({
      where: { active: true },
      orderBy: [{ category: 'asc' }, { key: 'asc' }],
    });

    return {
      items: rows.map((a) => ({
        key: a.key,
        display_name: a.displayName,
        description: a.description,
        category: a.category,
        data_type: a.dataType,
        operators: a.operatorsJson as RuleOperator[],
        allowed_values: (a.allowedValuesJson as string[] | null) ?? null,
        min_value: a.minValue,
        max_value: a.maxValue,
        unit: a.unit,
        policy_class: a.policyClass,
        version: a.version,
      })),
    };
  }

  private async loadTaxonomy(): Promise<Map<string, TaxonomyEntry>> {
    const rows = await this.prisma.attributeDefinition.findMany({ where: { active: true } });

    return new Map(
      rows.map((a) => [
        a.key,
        {
          key: a.key,
          dataType: a.dataType,
          operators: a.operatorsJson as RuleOperator[],
          allowedValues: (a.allowedValuesJson as string[] | null) ?? null,
          minValue: a.minValue,
          maxValue: a.maxValue,
          policyClass: a.policyClass,
        },
      ]),
    );
  }

  /**
   * §17: "Allowed fields/operators come from versioned AttributeDefinitions."
   *
   * This is the check that keeps a Buyer from reaching into a Partner's
   * database. Everything a rule can say has to be something the taxonomy
   * already permits — there is no path here that accepts an expression.
   */
  private validateRules(rules: AudienceRule[], taxonomy: Map<string, TaxonomyEntry>): void {
    const fieldErrors: { field: string; message: string }[] = [];
    const seen = new Set<string>();

    rules.forEach((rule, i) => {
      const at = `rules[${i}]`;
      const def = taxonomy.get(rule.attribute);

      if (!def) {
        fieldErrors.push({ field: `${at}.attribute`, message: `unknown attribute` });
        return;
      }

      // One rule per attribute: two rules on the same attribute would either
      // contradict or duplicate, and a Partner reviewing it (§10) should not
      // have to work out which.
      if (seen.has(rule.attribute)) {
        fieldErrors.push({ field: `${at}.attribute`, message: 'duplicated in this audience' });
      }
      seen.add(rule.attribute);

      if (def.policyClass !== 'GENERAL') {
        // §4: sensitive classes need explicit legal and policy design before
        // they are targetable. Refusing here means one cannot be used by
        // accident if a definition is ever added ahead of that decision.
        fieldErrors.push({
          field: `${at}.attribute`,
          message: `policy class ${def.policyClass} is not available for targeting`,
        });
      }

      if (!def.operators.includes(rule.operator)) {
        fieldErrors.push({
          field: `${at}.operator`,
          message: `${rule.attribute} supports ${def.operators.join(', ')}`,
        });
        return;
      }

      this.validateValue(at, rule, def, fieldErrors);
    });

    if (fieldErrors.length > 0) {
      throw new OolixError('VAL_001', 'One or more audience rules are not valid.', { fieldErrors });
    }
  }

  private validateValue(
    at: string,
    rule: AudienceRule,
    def: TaxonomyEntry,
    fieldErrors: { field: string; message: string }[],
  ): void {
    const field = `${at}.value`;
    const values = Array.isArray(rule.value) ? rule.value : [rule.value];

    if (rule.operator === 'BETWEEN') {
      if (!Array.isArray(rule.value) || rule.value.length !== 2) {
        fieldErrors.push({ field, message: 'BETWEEN needs exactly [min, max]' });
        return;
      }
      const [min, max] = rule.value.map(Number);
      if (!Number.isFinite(min) || !Number.isFinite(max)) {
        fieldErrors.push({ field, message: 'BETWEEN bounds must be numbers' });
        return;
      }
      if (min! > max!) {
        fieldErrors.push({ field, message: 'the lower bound is above the upper bound' });
      }
    }

    if (rule.operator === 'IN' && !Array.isArray(rule.value)) {
      fieldErrors.push({ field, message: 'IN needs a list of values' });
      return;
    }

    switch (def.dataType) {
      case 'BOOLEAN':
        if (typeof rule.value !== 'boolean') {
          fieldErrors.push({ field, message: 'expected true or false' });
        }
        break;

      case 'NUMBER':
        for (const v of values) {
          const n = Number(v);
          if (!Number.isFinite(n)) {
            fieldErrors.push({ field, message: 'expected a number' });
            break;
          }
          if (def.minValue !== null && n < def.minValue) {
            fieldErrors.push({ field, message: `below the permitted minimum of ${def.minValue}` });
            break;
          }
          if (def.maxValue !== null && n > def.maxValue) {
            fieldErrors.push({ field, message: `above the permitted maximum of ${def.maxValue}` });
            break;
          }
        }
        break;

      case 'ENUM':
      case 'ID':
        if (def.allowedValues) {
          const bad = values.filter((v) => !def.allowedValues!.includes(String(v)));
          if (bad.length > 0) {
            fieldErrors.push({
              field,
              message: `not permitted: ${bad.join(', ')}`,
            });
          }
        }
        break;
    }
  }

  /** §10, §16: what a Partner's approval binds to. */
  private ruleHash(rules: AudienceRule[]): string {
    return createHash('sha256').update(canonicalAudienceRules(rules)).digest('hex');
  }

  /* --- audience groups (§6, §14) ------------------------------------------- */

  async create(principal: UserPrincipal, input: CreateAudienceInput) {
    const taxonomy = await this.loadTaxonomy();
    this.validateRules(input.rules, taxonomy);

    const existing = await this.prisma.audienceGroup.findFirst({
      where: { buyerOrgId: principal.orgId, name: input.name },
    });
    if (existing) {
      throw new OolixError('VAL_001', 'An audience with this name already exists.', {
        fieldErrors: [{ field: 'name', message: 'already in use' }],
      });
    }

    const hash = this.ruleHash(input.rules);

    const group = await this.prisma.audienceGroup.create({
      data: {
        buyerOrgId: principal.orgId,
        name: input.name,
        description: input.description ?? null,
        status: 'DRAFT',
        currentVersion: 1,
        createdBy: principal.userId,
        versions: {
          create: {
            version: 1,
            rulesJson: input.rules as never,
            ruleHash: hash,
            status: 'DRAFT',
          },
        },
      },
    });

    await this.audit.record({
      action: 'AUDIENCE_GROUP_CREATED',
      entityType: 'audience_group',
      entityId: group.id,
      actor: principal.userId,
      orgId: principal.orgId,
      metadata: { name: group.name, version: 1, rule_hash: hash, rule_count: input.rules.length },
    });

    return { id: group.id, version: 1, status: 'DRAFT', rule_hash: hash };
  }

  async list(principal: UserPrincipal) {
    const groups = await this.prisma.audienceGroup.findMany({
      where: { buyerOrgId: principal.orgId },
      orderBy: { updatedAt: 'desc' },
      include: {
        versions: { orderBy: { version: 'desc' }, take: 1 },
        _count: { select: { links: true } },
      },
    });

    // Compatible-Partner counts come from stored match snapshots rather than
    // being recomputed: §16 ties a match to the capability version that
    // produced it, so a number computed fresh here could disagree with the one
    // the Buyer acted on.
    const matchCounts = await this.prisma.partnerMatchSnapshot.groupBy({
      by: ['audienceGroupId'],
      where: { audienceGroupId: { in: groups.map((g) => g.id) }, status: 'COMPATIBLE' },
      _count: { _all: true },
    });
    const compatible = new Map(matchCounts.map((m) => [m.audienceGroupId, m._count._all]));

    return {
      items: groups.map((g) => ({
        id: g.id,
        name: g.name,
        description: g.description,
        status: g.status,
        display_status: groupDisplayStatus(g.status, g._count.links),
        current_version: g.currentVersion,
        rule_count: ((g.versions[0]?.rulesJson ?? []) as unknown as AudienceRule[]).length,
        rule_hash: g.versions[0]?.ruleHash ?? null,
        compatible_partners: compatible.get(g.id) ?? 0,
        linked_campaigns: g._count.links,
        updated_at: g.updatedAt.toISOString(),
      })),
    };
  }

  async get(principal: UserPrincipal, id: string) {
    const group = await this.prisma.audienceGroup.findFirst({
      where: { id, buyerOrgId: principal.orgId },
      include: {
        versions: { orderBy: { version: 'desc' } },
        estimates: { include: { organization: { select: { name: true } } } },
        links: { include: { campaign: { select: { id: true, name: true, status: true } } } },
      },
    });
    if (!group) throw new OolixError('CAMP_001', 'Audience group not found.');

    // Point 15: which campaigns sit on which saved settings. Counted from the
    // links rather than stored, so it cannot fall out of step with them.
    const campaignsPerVersion = new Map<number, number>();
    for (const link of group.links) {
      campaignsPerVersion.set(
        link.audienceVersion,
        (campaignsPerVersion.get(link.audienceVersion) ?? 0) + 1,
      );
    }

    return {
      id: group.id,
      name: group.name,
      description: group.description,
      // The internal status is still reported: the Partner-facing and audit
      // paths read it, and point 13 asks only that the Buyer UI not show it raw.
      status: group.status,
      display_status: groupDisplayStatus(group.status, group.links.length),
      current_version: group.currentVersion,
      versions: group.versions.map((v) => ({
        version: v.version,
        status: v.status,
        is_current: v.version === group.currentVersion,
        display_status: versionDisplayStatus(v.status, v.version === group.currentVersion),
        used_by_campaigns: campaignsPerVersion.get(v.version) ?? 0,
        rule_hash: v.ruleHash,
        rules: v.rulesJson as unknown as AudienceRule[],
        created_at: v.createdAt.toISOString(),
      })),
      reach_estimates: group.estimates.map((e) => ({
        reach_estimate_id: e.id,
        partner_org_id: e.partnerOrgId,
        partner_name: e.organization.name,
        audience_version: e.audienceVersion,
        status: e.status,
        // §8.2: a bucket or nothing. There is no exact count to return.
        reach_bucket: toWireBucket(e.reachBucket),
        // When the request was made, so a client can tell "just asked" from
        // "asked an hour ago and nothing came back". The estimate is computed
        // inside the Partner, so a silent Agent leaves this pending
        // indefinitely and the Buyer needs to be able to see that.
        requested_at: e.requestedAt?.toISOString() ?? null,
        freshness_at: e.freshnessAt?.toISOString() ?? null,
        expires_at: e.expiresAt?.toISOString() ?? null,
        failure_reason: e.failureReason,
      })),
      linked_campaigns: group.links.map((l) => ({
        campaign_id: l.campaignId,
        campaign_name: l.campaign.name,
        campaign_status: l.campaign.status,
        audience_version: l.audienceVersion,
      })),
    };
  }

  /**
   * Point 17: the change history, in the words a Buyer uses.
   *
   * Deliberately thin. It answers "what did I change, when, and is anything
   * still running on the old settings" — which is the only reason a Buyer opens
   * history at all. The rules themselves are on the detail response, and the
   * rule hash is not here because a Buyer cannot act on it (point 18).
   */
  async history(principal: UserPrincipal, id: string) {
    const group = await this.prisma.audienceGroup.findFirst({
      where: { id, buyerOrgId: principal.orgId },
      include: {
        versions: { orderBy: { version: 'desc' } },
        links: { select: { audienceVersion: true } },
      },
    });
    if (!group) throw new OolixError('CAMP_001', 'Audience group not found.');

    const campaignsPerVersion = new Map<number, number>();
    for (const link of group.links) {
      campaignsPerVersion.set(
        link.audienceVersion,
        (campaignsPerVersion.get(link.audienceVersion) ?? 0) + 1,
      );
    }

    return {
      items: group.versions.map((v) => ({
        audience_version: v.version,
        is_current: v.version === group.currentVersion,
        display_status: versionDisplayStatus(v.status, v.version === group.currentVersion),
        used_by_campaigns: campaignsPerVersion.get(v.version) ?? 0,
        created_at: v.createdAt.toISOString(),
      })),
    };
  }

  /**
   * Edit.
   *
   * §16: "Editing a READY Audience Group creates a new version; live campaigns
   * stay on their approved version." So a DRAFT is edited in place and a READY
   * one forks — which is what stops an edit here from silently changing what a
   * Partner already agreed to serve.
   */
  async update(principal: UserPrincipal, id: string, input: UpdateAudienceInput) {
    const group = await this.prisma.audienceGroup.findFirst({
      where: { id, buyerOrgId: principal.orgId },
      include: { versions: { orderBy: { version: 'desc' }, take: 1 } },
    });
    if (!group) throw new OolixError('CAMP_001', 'Audience group not found.');
    if (group.status === 'ARCHIVED') {
      throw new OolixError('CAMP_002', 'This audience is archived.');
    }

    const latest = group.versions[0];
    if (!latest) throw new OolixError('SYS_002', 'Audience group has no version.');

    const rules = input.rules ?? (latest.rulesJson as unknown as AudienceRule[]);
    if (input.rules) {
      this.validateRules(input.rules, await this.loadTaxonomy());
    }

    const hash = this.ruleHash(rules);
    const rulesChanged = hash !== latest.ruleHash;
    const forks = latest.status === 'READY' && rulesChanged;

    const version = forks ? latest.version + 1 : latest.version;

    await this.prisma.$transaction(async (tx) => {
      if (forks) {
        await tx.audienceGroupVersion.update({
          where: { audienceGroupId_version: { audienceGroupId: id, version: latest.version } },
          data: { status: 'SUPERSEDED' },
        });
        await tx.audienceGroupVersion.create({
          data: {
            audienceGroupId: id,
            version,
            rulesJson: rules as never,
            ruleHash: hash,
            status: 'DRAFT',
          },
        });
      } else if (rulesChanged) {
        await tx.audienceGroupVersion.update({
          where: { audienceGroupId_version: { audienceGroupId: id, version: latest.version } },
          data: { rulesJson: rules as never, ruleHash: hash },
        });
      }

      await tx.audienceGroup.update({
        where: { id },
        data: {
          ...(input.name ? { name: input.name } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          currentVersion: version,
          ...(forks ? { status: 'DRAFT' as const } : {}),
        },
      });
    });

    if (rulesChanged) {
      await this.audit.record({
        action: forks ? 'AUDIENCE_VERSION_CREATED' : 'AUDIENCE_DRAFT_UPDATED',
        entityType: 'audience_group',
        entityId: id,
        actor: principal.userId,
        orgId: principal.orgId,
        metadata: { version, rule_hash: hash, forked_from: forks ? latest.version : null },
      });
    }

    return { id, version, status: forks ? 'DRAFT' : latest.status, rule_hash: hash, forked: forks };
  }

  /** §14: freeze the version so it can be matched, estimated and linked. */
  async publish(principal: UserPrincipal, id: string) {
    const group = await this.prisma.audienceGroup.findFirst({
      where: { id, buyerOrgId: principal.orgId },
      include: { versions: { orderBy: { version: 'desc' }, take: 1 } },
    });
    if (!group) throw new OolixError('CAMP_001', 'Audience group not found.');

    const latest = group.versions[0];
    if (!latest) throw new OolixError('SYS_002', 'Audience group has no version.');
    if (latest.status === 'READY') {
      return { id, version: latest.version, status: 'READY', rule_hash: latest.ruleHash };
    }

    // Re-validate at publish: the taxonomy is versioned and an attribute could
    // have been withdrawn since the draft was written (§4).
    this.validateRules(latest.rulesJson as unknown as AudienceRule[], await this.loadTaxonomy());

    await this.prisma.$transaction([
      this.prisma.audienceGroupVersion.update({
        where: { audienceGroupId_version: { audienceGroupId: id, version: latest.version } },
        data: { status: 'READY' },
      }),
      this.prisma.audienceGroup.update({ where: { id }, data: { status: 'READY' } }),
    ]);

    await this.audit.record({
      action: 'AUDIENCE_PUBLISHED',
      entityType: 'audience_group',
      entityId: id,
      actor: principal.userId,
      orgId: principal.orgId,
      metadata: { version: latest.version, rule_hash: latest.ruleHash },
    });

    return { id, version: latest.version, status: 'READY', rule_hash: latest.ruleHash };
  }

  /* --- Partner capabilities (§5) ------------------------------------------- */

  /**
   * §5.1: a Partner publishes what it can evaluate.
   *
   * Each publication is a new version rather than an edit. §16 binds a match —
   * and later an approval — to the capability version that produced it, so
   * rewriting one in place would change the meaning of a decision already made.
   */
  async publishCapabilities(principal: UserPrincipal, input: PublishCapabilitiesInput) {
    const taxonomy = await this.loadTaxonomy();

    const unknown = input.attributes
      .map((a) => a.attribute_key)
      .filter((key) => !taxonomy.has(key));
    if (unknown.length > 0) {
      throw new OolixError('VAL_001', 'Unknown attributes for this taxonomy version.', {
        fieldErrors: unknown.map((key) => ({ field: 'attributes', message: `unknown: ${key}` })),
      });
    }

    // A Partner cannot claim an operator the taxonomy does not define for that
    // attribute — it would produce matches nobody could actually evaluate.
    const badOperators: { field: string; message: string }[] = [];
    for (const attr of input.attributes) {
      const def = taxonomy.get(attr.attribute_key)!;
      const extra = attr.operators.filter((op) => !def.operators.includes(op));
      if (extra.length > 0) {
        badOperators.push({
          field: `attributes.${attr.attribute_key}`,
          message: `${attr.attribute_key} does not support ${extra.join(', ')}`,
        });
      }
    }
    if (badOperators.length > 0) {
      throw new OolixError('VAL_001', 'Unsupported operators declared.', {
        fieldErrors: badOperators,
      });
    }

    const current = await this.prisma.partnerCapability.findFirst({
      where: { partnerOrgId: principal.orgId },
      orderBy: { capabilityVersion: 'desc' },
    });
    const nextVersion = (current?.capabilityVersion ?? 0) + 1;

    const capability = await this.prisma.$transaction(async (tx) => {
      if (current) {
        await tx.partnerCapability.update({
          where: { id: current.id },
          data: { status: 'SUPERSEDED' },
        });
      }
      return tx.partnerCapability.create({
        data: {
          partnerOrgId: principal.orgId,
          capabilityVersion: nextVersion,
          attributesJson: input.attributes as never,
          geographiesJson: input.geographies,
          channelsJson: input.channels,
          status: 'ACTIVE',
          mappingVersion: input.mapping_version ?? null,
        },
      });
    });

    await this.audit.record({
      action: 'PARTNER_CAPABILITIES_PUBLISHED',
      entityType: 'partner_capability',
      entityId: capability.id,
      actor: principal.userId,
      orgId: principal.orgId,
      metadata: {
        capability_version: nextVersion,
        attribute_count: input.attributes.length,
        channels: input.channels,
      },
    });

    return {
      capability_version: nextVersion,
      attributes: input.attributes,
      geographies: input.geographies,
      channels: input.channels,
      published_at: capability.publishedAt.toISOString(),
    };
  }

  async myCapabilities(principal: UserPrincipal) {
    const current = await this.prisma.partnerCapability.findFirst({
      where: { partnerOrgId: principal.orgId, status: 'ACTIVE' },
      orderBy: { capabilityVersion: 'desc' },
    });

    if (!current) {
      return { capability_version: null, attributes: [], geographies: [], channels: [] };
    }

    return {
      capability_version: current.capabilityVersion,
      attributes: current.attributesJson,
      geographies: current.geographiesJson,
      channels: current.channelsJson,
      mapping_version: current.mappingVersion,
      published_at: current.publishedAt.toISOString(),
    };
  }

  /* --- matching (§7) -------------------------------------------------------- */

  /**
   * §7: which Partners can evaluate this audience.
   *
   * Scoped to Partners the Buyer can actually transact with (§66.2 network and
   * marketplace visibility), then matched on capability. Results are stored so
   * the estimate and approval that follow are tied to the capability version
   * that produced them (§16).
   */
  async partnerMatches(principal: UserPrincipal, id: string, requestedVersion?: number) {
    const group = await this.prisma.audienceGroup.findFirst({
      where: { id, buyerOrgId: principal.orgId },
      include: { versions: { orderBy: { version: 'desc' } } },
    });
    if (!group) throw new OolixError('CAMP_001', 'Audience group not found.');

    const version =
      group.versions.find((v) => v.version === (requestedVersion ?? group.currentVersion)) ??
      group.versions[0];
    if (!version) throw new OolixError('SYS_002', 'Audience group has no version.');

    const rules = version.rulesJson as unknown as AudienceRule[];

    // §66.2: only Partners in a network this Buyer belongs to, or offering
    // marketplace supply. A Buyer must not discover Partners they have no
    // relationship with.
    const visiblePartnerIds = await this.visiblePartnerIds(principal);

    const capabilities = await this.prisma.partnerCapability.findMany({
      where: { partnerOrgId: { in: visiblePartnerIds }, status: 'ACTIVE' },
      include: { organization: { select: { id: true, name: true, industry: true } } },
    });

    const estimates = await this.prisma.reachEstimate.findMany({
      where: { audienceGroupId: id, audienceVersion: version.version },
    });
    const estimateByPartner = new Map(estimates.map((e) => [e.partnerOrgId, e]));

    const results = capabilities.map((cap) => {
      const capability: PartnerCapability = {
        partner_org_id: cap.partnerOrgId,
        capability_version: cap.capabilityVersion,
        attributes: cap.attributesJson as unknown as PartnerCapability['attributes'],
        geographies: cap.geographiesJson as string[],
        channels: cap.channelsJson as string[],
      };

      const match: MatchResult = matchPartner(rules, capability);
      const estimate = estimateByPartner.get(cap.partnerOrgId);

      return {
        partner_org_id: cap.partnerOrgId,
        partner_name: cap.organization.name,
        partner_industry: cap.organization.industry,
        status: match.status,
        match_score: match.match_score,
        supported_rules: match.supported_rules,
        missing_required_rules: match.missing_required_rules,
        missing_optional_rules: match.missing_optional_rules,
        capability_version: cap.capabilityVersion,
        geographies: capability.geographies,
        // §7: an external channel stays CONDITIONAL until the eligibility gate
        // passes — a Partner declaring it does not make it usable (§15, §16).
        channels: capability.channels.map((channel) => ({
          channel,
          status: channel === 'META' || channel === 'GOOGLE' ? 'CONDITIONAL' : 'AVAILABLE',
        })),
        reach_estimate: estimate
          ? {
              reach_estimate_id: estimate.id,
              status: estimate.status,
              reach_bucket: toWireBucket(estimate.reachBucket),
              freshness_at: estimate.freshnessAt?.toISOString() ?? null,
              expires_at: estimate.expiresAt?.toISOString() ?? null,
            }
          : null,
      };
    });

    // Persist the snapshots so an estimate or approval can be traced back to
    // the exact capability version that made the Partner selectable.
    await Promise.all(
      results.map((r) =>
        this.prisma.partnerMatchSnapshot.upsert({
          where: {
            audienceGroupId_audienceVersion_partnerOrgId_capabilityVersion: {
              audienceGroupId: id,
              audienceVersion: version.version,
              partnerOrgId: r.partner_org_id,
              capabilityVersion: r.capability_version,
            },
          },
          create: {
            audienceGroupId: id,
            audienceVersion: version.version,
            partnerOrgId: r.partner_org_id,
            capabilityVersion: r.capability_version,
            status: r.status as never,
            matchScore: r.match_score,
            supportedRulesJson: r.supported_rules,
            missingRequiredJson: r.missing_required_rules,
            missingOptionalJson: r.missing_optional_rules,
            channelsJson: r.channels as never,
          },
          update: {
            status: r.status as never,
            matchScore: r.match_score,
            supportedRulesJson: r.supported_rules,
            missingRequiredJson: r.missing_required_rules,
            missingOptionalJson: r.missing_optional_rules,
            channelsJson: r.channels as never,
            computedAt: new Date(),
          },
        }),
      ),
    );

    // Compatible first, best coverage first within that. INCOMPATIBLE Partners
    // are still returned: §7 shows them below with the missing rule named, so a
    // Buyer can decide whether to relax a requirement.
    results.sort((a, b) => {
      if (a.status !== b.status) return a.status === 'COMPATIBLE' ? -1 : 1;
      return b.match_score - a.match_score;
    });

    return {
      audience_group_id: id,
      audience_version: version.version,
      rule_hash: version.ruleHash,
      items: results,
      notice:
        'Match score is schema compatibility — whether a Partner can evaluate these rules. It is not a measure of audience quality (§7).',
    };
  }

  /** §66.2: Partners this Buyer may transact with at all. */
  private async visiblePartnerIds(principal: UserPrincipal): Promise<string[]> {
    const networkPartners = await this.prisma.networkMembership.findMany({
      where: { networkId: { in: principal.networkIds }, status: 'ACTIVE' },
      select: { orgId: true },
    });

    const marketplace = await this.prisma.segmentOffer.findMany({
      where: { visibility: 'MARKETPLACE' },
      select: { segment: { select: { partnerOrgId: true } } },
    });

    return [
      ...new Set([
        ...networkPartners.map((n) => n.orgId),
        ...marketplace.map((m) => m.segment.partnerOrgId),
      ]),
    ].filter((orgId) => orgId !== principal.orgId);
  }

  /* --- reach estimates (§8) ------------------------------------------------- */

  /**
   * §8.1: ask selected Partners for a safe estimate.
   *
   * Returns immediately with REQUESTED rows; the Agent picks them up on its
   * next control sync, evaluates locally, and posts back a bucket. Nothing here
   * computes a count — Oolix has nothing to count.
   */
  async requestReachEstimates(
    principal: UserPrincipal,
    id: string,
    partnerOrgIds: string[],
    requestedVersion?: number,
  ) {
    const group = await this.prisma.audienceGroup.findFirst({
      where: { id, buyerOrgId: principal.orgId },
      include: { versions: { orderBy: { version: 'desc' } } },
    });
    if (!group) throw new OolixError('CAMP_001', 'Audience group not found.');

    const version =
      group.versions.find((v) => v.version === (requestedVersion ?? group.currentVersion)) ??
      group.versions[0];
    if (!version) throw new OolixError('SYS_002', 'Audience group has no version.');

    const rules = version.rulesJson as unknown as AudienceRule[];

    const requests: {
      reach_estimate_id: string;
      partner_org_id: string;
      status: string;
      cached: boolean;
    }[] = [];

    for (const partnerOrgId of partnerOrgIds) {
      // A Partner that cannot evaluate every REQUIRED rule cannot produce a
      // meaningful estimate, so asking would waste their query and mislead the
      // Buyer (§7).
      const capability = await this.prisma.partnerCapability.findFirst({
        where: { partnerOrgId, status: 'ACTIVE' },
        orderBy: { capabilityVersion: 'desc' },
      });
      if (!capability) {
        throw new OolixError('PART_002', 'That Partner has published no capabilities.');
      }

      const match = matchPartner(rules, {
        partner_org_id: partnerOrgId,
        capability_version: capability.capabilityVersion,
        attributes: capability.attributesJson as unknown as PartnerCapability['attributes'],
        geographies: capability.geographiesJson as string[],
        channels: capability.channelsJson as string[],
      });
      if (match.status === 'INCOMPATIBLE') {
        throw new OolixError(
          'PART_002',
          `That Partner cannot evaluate every required rule (missing: ${match.missing_required_rules.join(', ')}).`,
        );
      }

      const existing = await this.prisma.reachEstimate.findUnique({
        where: {
          audienceGroupId_audienceVersion_partnerOrgId: {
            audienceGroupId: id,
            audienceVersion: version.version,
            partnerOrgId,
          },
        },
      });

      // §17: repeated requests for the same audience, Partner and version are
      // cached and rate-limited. That is not only load control — repeatedly
      // re-running the same rule is how a cohort could be watched changing
      // (§72 anti-differencing).
      if (existing) {
        const age = Date.now() - existing.requestedAt.getTime();
        const fresh = age < REACH_ESTIMATE_MIN_REFRESH_MINUTES * 60_000;
        const usable = existing.status !== 'FAILED' && existing.status !== 'EXPIRED';

        if (fresh || usable) {
          requests.push({
            reach_estimate_id: existing.id,
            partner_org_id: partnerOrgId,
            status: existing.status,
            cached: true,
          });
          continue;
        }

        const refreshed = await this.prisma.reachEstimate.update({
          where: { id: existing.id },
          data: {
            status: 'REQUESTED',
            reachBucket: null,
            failureReason: null,
            requestedAt: new Date(),
            requestedBy: principal.userId,
            capabilityVersion: capability.capabilityVersion,
          },
        });
        requests.push({
          reach_estimate_id: refreshed.id,
          partner_org_id: partnerOrgId,
          status: refreshed.status,
          cached: false,
        });
        continue;
      }

      const created = await this.prisma.reachEstimate.create({
        data: {
          audienceGroupId: id,
          audienceVersion: version.version,
          partnerOrgId,
          status: 'REQUESTED',
          ruleHash: version.ruleHash,
          capabilityVersion: capability.capabilityVersion,
          requestedBy: principal.userId,
        },
      });

      requests.push({
        reach_estimate_id: created.id,
        partner_org_id: partnerOrgId,
        status: created.status,
        cached: false,
      });
    }

    await this.audit.record({
      action: 'REACH_ESTIMATES_REQUESTED',
      entityType: 'audience_group',
      entityId: id,
      actor: principal.userId,
      orgId: principal.orgId,
      metadata: { audience_version: version.version, partners: partnerOrgIds.length },
    });

    return { audience_version: version.version, rule_hash: version.ruleHash, requests };
  }

  async listReachEstimates(principal: UserPrincipal, id: string) {
    const group = await this.prisma.audienceGroup.findFirst({
      where: { id, buyerOrgId: principal.orgId },
    });
    if (!group) throw new OolixError('CAMP_001', 'Audience group not found.');

    const estimates = await this.prisma.reachEstimate.findMany({
      where: { audienceGroupId: id },
      include: { organization: { select: { name: true } } },
      orderBy: { requestedAt: 'desc' },
    });

    return {
      items: estimates.map((e) => ({
        reach_estimate_id: e.id,
        partner_org_id: e.partnerOrgId,
        partner_name: e.organization.name,
        audience_version: e.audienceVersion,
        status: e.status,
        reach_bucket: toWireBucket(e.reachBucket),
        rule_hash: e.ruleHash,
        capability_version: e.capabilityVersion,
        mapping_version: e.mappingVersion,
        freshness_at: e.freshnessAt?.toISOString() ?? null,
        expires_at: e.expiresAt?.toISOString() ?? null,
        failure_reason: e.failureReason,
        requested_at: e.requestedAt.toISOString(),
      })),
      ttl_hours: REACH_ESTIMATE_TTL_HOURS,
    };
  }
}
