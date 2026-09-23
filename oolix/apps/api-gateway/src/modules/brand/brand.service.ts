/**
 * Brand profiles -- spec v5 §36 step 4, §40.2, §40.7.
 *
 * A brand is the advertiser identity a campaign runs under, and §41 puts it in
 * front of the Partner as one of the facts they decide on: "Buyer / brand
 * identity -- know who is advertising."
 *
 * It also carries the allow-listed landing domain. §40.7 requires a click or
 * lead campaign to point at a verified domain, and that check is only as good
 * as the domain recorded here -- so `landing_domain` is validated on the way
 * in rather than trusted from the campaign builder.
 */
import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { OolixError } from '@oolix/contracts';
import type { UserPrincipal } from '@oolix/auth-rbac';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AuditService } from '../../common/audit/audit.service.js';

/** §36 step 4: brand name, logo, category, website, default landing domain. */
export const CreateBrandSchema = z.object({
  name: z.string().min(2).max(120),
  category: z.string().min(2).max(80),
  website: z.string().url(),
  /**
   * Bare host, no scheme or path. Stored this way because §40.7 compares it
   * against a campaign's landing URL host; a value like
   * `https://brand.example/` would never match and would quietly disable the
   * check it exists to perform.
   */
  landing_domain: z
    .string()
    .min(3)
    .max(253)
    .regex(
      /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/i,
      'must be a bare domain such as brand.example',
    ),
  logo_uri: z.string().url().optional(),
});
export type CreateBrandInput = z.infer<typeof CreateBrandSchema>;

@Injectable()
export class BrandService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  /** §67: scoped to the caller's organization. There is no cross-Buyer read. */
  async list(principal: UserPrincipal) {
    const brands = await this.prisma.brand.findMany({
      where: { buyerOrgId: principal.orgId },
      orderBy: { createdAt: 'asc' },
    });

    return {
      items: brands.map((b) => ({
        id: b.id,
        name: b.name,
        category: b.category,
        website: b.website,
        landing_domain: b.landingDomain,
        logo_uri: b.logoUri,
        created_at: b.createdAt.toISOString(),
      })),
    };
  }

  async create(principal: UserPrincipal, input: CreateBrandInput) {
    const domain = input.landing_domain.toLowerCase();

    // The website and the landing domain must belong together. A brand whose
    // site is one company and whose landing domain is another defeats the
    // point of §40.7's allow-list, and a Partner approving on brand identity
    // (§41) would be approving something other than what they see.
    const websiteHost = new URL(input.website).hostname.toLowerCase();
    if (websiteHost !== domain && !websiteHost.endsWith(`.${domain}`)) {
      throw new OolixError('VAL_001', 'landing_domain must match the brand website domain.', {
        fieldErrors: [
          { field: 'landing_domain', message: `does not correspond to ${websiteHost}` },
        ],
      });
    }

    const existing = await this.prisma.brand.findFirst({
      where: { buyerOrgId: principal.orgId, name: input.name },
    });
    if (existing) {
      throw new OolixError('VAL_001', 'A brand with this name already exists.', {
        fieldErrors: [{ field: 'name', message: 'already in use' }],
      });
    }

    const brand = await this.prisma.brand.create({
      data: {
        buyerOrgId: principal.orgId,
        name: input.name,
        category: input.category,
        website: input.website,
        landingDomain: domain,
        logoUri: input.logo_uri ?? null,
      },
    });

    await this.audit.record({
      action: 'BRAND_CREATED',
      entityType: 'brand',
      entityId: brand.id,
      actor: principal.userId,
      orgId: principal.orgId,
      metadata: { name: brand.name, landing_domain: brand.landingDomain },
    });

    return {
      id: brand.id,
      name: brand.name,
      category: brand.category,
      website: brand.website,
      landing_domain: brand.landingDomain,
      logo_uri: brand.logoUri,
      created_at: brand.createdAt.toISOString(),
    };
  }
}
