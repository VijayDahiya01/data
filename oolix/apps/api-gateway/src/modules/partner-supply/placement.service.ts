/**
 * Placement management -- spec v5 §43.
 *
 * A placement is the Partner's declaration of WHERE an approved campaign may
 * appear. §43's non-negotiables, all enforced here or downstream:
 *
 *   - the Partner frontend never sends partner_user_id to Oolix
 *   - ad placement failure cannot block checkout, booking or login
 *   - the Partner can disable any placement with a kill switch
 */
import { Injectable, Inject } from '@nestjs/common';
import { z } from 'zod';
import { MVP_ENABLED_FORMATS, OolixError, type PlacementFormat } from '@oolix/contracts';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AuditService } from '../../common/audit/audit.service.js';

export const CreatePlacementSchema = z.object({
  placement_key: z
    .string()
    .min(2)
    .max(120)
    .regex(/^[a-z0-9_]+$/, 'lowercase alphanumeric and underscore'),
  display_name: z.string().min(2).max(120),
  surface: z.enum(['web', 'ios', 'android', 'react_native', 'flutter', 'backend_native']),
  format: z.enum(['banner', 'native_card', 'carousel', 'inline', 'modal']),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  context_tags: z.array(z.string().max(60)).default([]),
  allowed_categories: z.array(z.string().max(80)).min(1),
  blocked_categories: z.array(z.string().max(80)).default([]),
  /** §43: default cap when a campaign does not request a stricter one. */
  max_frequency_default: z.number().int().positive().max(50).default(2),
  fallback: z.enum(['NO_AD', 'HOUSE_CONTENT']).default('NO_AD'),
});

export type CreatePlacementInput = z.infer<typeof CreatePlacementSchema>;

export const UpdatePlacementSchema = CreatePlacementSchema.partial().omit({
  placement_key: true,
});
export type UpdatePlacementInput = z.infer<typeof UpdatePlacementSchema>;

@Injectable()
export class PlacementService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async create(partnerOrgId: string, input: CreatePlacementInput) {
    // §43 / §70: the MVP supports IMAGE and NATIVE_CARD creatives, so only the
    // formats those can fill are offered. Accepting `carousel` here would let
    // a Partner publish inventory no approved creative could ever fill.
    if (!MVP_ENABLED_FORMATS.includes(input.format as PlacementFormat)) {
      throw new OolixError(
        'VAL_001',
        `Format "${input.format}" is not enabled in the MVP (spec §43, §70).`,
        {
          fieldErrors: [
            { field: 'format', message: `supported: ${MVP_ENABLED_FORMATS.join(', ')}` },
          ],
        },
      );
    }

    const clash = await this.prisma.placement.findUnique({
      where: { partnerOrgId_placementKey: { partnerOrgId, placementKey: input.placement_key } },
      select: { id: true },
    });
    if (clash) {
      throw new OolixError('VAL_001', 'A placement with this key already exists.', {
        fieldErrors: [{ field: 'placement_key', message: 'already in use' }],
      });
    }

    const placement = await this.prisma.placement.create({
      data: {
        partnerOrgId,
        placementKey: input.placement_key,
        displayName: input.display_name,
        surface: input.surface as never,
        format: input.format as never,
        width: input.width ?? null,
        height: input.height ?? null,
        contextTags: input.context_tags,
        allowedCategories: input.allowed_categories,
        blockedCategories: input.blocked_categories,
        maxFrequencyDefault: input.max_frequency_default,
        fallback: input.fallback as never,
        status: 'DRAFT',
      },
    });

    await this.audit.record({
      action: 'PLACEMENT_CREATED',
      entityType: 'placement',
      entityId: placement.id,
      orgId: partnerOrgId,
      metadata: { placement_key: input.placement_key, surface: input.surface },
    });

    return this.toWire(placement);
  }

  async update(partnerOrgId: string, placementId: string, input: UpdatePlacementInput) {
    await this.requireOwned(partnerOrgId, placementId);

    if (input.format && !MVP_ENABLED_FORMATS.includes(input.format as PlacementFormat)) {
      throw new OolixError('VAL_001', `Format "${input.format}" is not enabled in the MVP.`);
    }

    const data: Record<string, unknown> = {};
    if (input.display_name) data.displayName = input.display_name;
    if (input.surface) data.surface = input.surface;
    if (input.format) data.format = input.format;
    if (input.width !== undefined) data.width = input.width;
    if (input.height !== undefined) data.height = input.height;
    if (input.context_tags) data.contextTags = input.context_tags;
    if (input.allowed_categories) data.allowedCategories = input.allowed_categories;
    if (input.blocked_categories) data.blockedCategories = input.blocked_categories;
    if (input.max_frequency_default) data.maxFrequencyDefault = input.max_frequency_default;
    if (input.fallback) data.fallback = input.fallback;

    const updated = await this.prisma.placement.update({
      where: { id: placementId },
      data: data as never,
    });

    await this.audit.record({
      action: 'PLACEMENT_UPDATED',
      entityType: 'placement',
      entityId: placementId,
      orgId: partnerOrgId,
      metadata: { fields: Object.keys(data) },
    });

    return this.toWire(updated);
  }

  /**
   * Activate or disable a placement.
   *
   * §43: "Partner can disable any placement with a kill switch." Disabling is
   * immediate and unilateral -- it needs no Buyer agreement and ends serving
   * on the next control sync (§75).
   */
  async setStatus(partnerOrgId: string, placementId: string, status: 'ACTIVE' | 'DISABLED') {
    await this.requireOwned(partnerOrgId, placementId);

    const updated = await this.prisma.placement.update({
      where: { id: placementId },
      data: { status },
    });

    await this.audit.record({
      action: status === 'DISABLED' ? 'PLACEMENT_DISABLED' : 'PLACEMENT_ACTIVATED',
      entityType: 'placement',
      entityId: placementId,
      orgId: partnerOrgId,
      metadata: { status },
    });

    return this.toWire(updated);
  }

  async list(partnerOrgId: string) {
    const rows = await this.prisma.placement.findMany({
      where: { partnerOrgId },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) => this.toWire(r));
  }

  private async requireOwned(partnerOrgId: string, placementId: string) {
    const placement = await this.prisma.placement.findUnique({ where: { id: placementId } });
    if (!placement || placement.partnerOrgId !== partnerOrgId) {
      throw new OolixError('PART_001', 'Placement not found.');
    }
    return placement;
  }

  private toWire(p: {
    id: string;
    placementKey: string;
    displayName: string;
    surface: string;
    format: string;
    width: number | null;
    height: number | null;
    contextTags: string[];
    allowedCategories: string[];
    blockedCategories: string[];
    maxFrequencyDefault: number;
    fallback: string;
    status: string;
  }) {
    return {
      placement_id: p.id,
      placement_key: p.placementKey,
      display_name: p.displayName,
      surface: p.surface,
      format: p.format,
      dimensions: p.width && p.height ? { width: p.width, height: p.height } : null,
      context_tags: p.contextTags,
      allowed_categories: p.allowedCategories,
      blocked_categories: p.blockedCategories,
      max_frequency_default: p.maxFrequencyDefault,
      fallback: p.fallback,
      status: p.status,
    };
  }
}
