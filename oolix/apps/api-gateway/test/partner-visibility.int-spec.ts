/**
 * §66.2 visibility against the real schema: which Partners a Buyer finds.
 *
 * One rule now serves the capability match, reach-estimate requests and the
 * placement list. The cases below are the ones the old copies disagreed on --
 * a marketplace offer on a draft segment, an unverified Partner, a suspended
 * one -- plus the marketplace listing a Partner Connect Partner relies on.
 */
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { UserPrincipal } from '@oolix/auth-rbac';
import { createTestApp } from './app.factory.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { canSeePartner, visiblePartnerIds } from '../src/common/partner-visibility.js';

describe('Partner visibility (§66.2)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  const run = `vis-${Date.now()}`;
  const ids: Record<string, string> = {};
  let networkId = '';

  async function org(key: string, type: 'BUYER' | 'DATA_PARTNER', status: string) {
    const o = await prisma.organization.create({
      data: {
        type,
        name: `${run} ${key}`,
        domain: `${key}.${run}.example`,
        verificationStatus: status as never,
        country: 'IN',
      },
    });
    ids[key] = o.id;
    return o.id;
  }

  async function segmentOffer(partnerOrgId: string, status: 'DRAFT' | 'PUBLISHED') {
    const segment = await prisma.segment.create({
      data: {
        partnerOrgId,
        internalKey: `${run}-${status}`,
        displayName: 'Test segment',
        description: 'Test segment',
        safeMetadata: {},
        category: 'TRAVEL',
        geographies: ['IN'],
        reachBucket: 'UNDER_10K',
        refreshFrequency: 'DAILY',
        allowedChannels: ['PARTNER_WEB'],
        allowedCategories: [],
        blockedCategories: [],
        status,
      },
    });
    await prisma.segmentOffer.create({
      data: {
        segmentId: segment.id,
        pricingModel: 'CPM',
        unitPriceMinor: 100n,
        currency: 'INR',
        visibility: 'MARKETPLACE',
      },
    });
  }

  beforeAll(async () => {
    ({ app } = await createTestApp());
    prisma = app.get(PrismaService);

    const buyer = await org('buyer', 'BUYER', 'BUSINESS_VERIFIED');
    const networked = await org('networked', 'DATA_PARTNER', 'BUSINESS_VERIFIED');
    const suspended = await org('suspended', 'DATA_PARTNER', 'SUSPENDED');
    const listed = await org('listed', 'DATA_PARTNER', 'BUSINESS_VERIFIED');
    const listedUnverified = await org('listedUnverified', 'DATA_PARTNER', 'ORGANIZATION_CREATED');
    const publishedOffer = await org('publishedOffer', 'DATA_PARTNER', 'ACTIVE');
    const draftOffer = await org('draftOffer', 'DATA_PARTNER', 'ACTIVE');
    await org('stranger', 'DATA_PARTNER', 'BUSINESS_VERIFIED');

    const network = await prisma.network.create({
      data: { sponsorOrgId: buyer, name: `${run} network`, mode: 'PRIVATE' },
    });
    networkId = network.id;
    for (const orgId of [buyer, networked, suspended]) {
      await prisma.networkMembership.create({
        data: { networkId, orgId, status: 'ACTIVE' },
      });
    }

    for (const orgId of [listed, listedUnverified]) {
      await prisma.partnerProfile.create({
        data: { orgId, marketplaceListed: true, marketplaceListedAt: new Date() },
      });
    }
    await segmentOffer(publishedOffer, 'PUBLISHED');
    await segmentOffer(draftOffer, 'DRAFT');
  });

  afterAll(async () => {
    if (prisma) {
      await prisma.network.deleteMany({ where: { id: networkId } });
      await prisma.organization.deleteMany({ where: { id: { in: Object.values(ids) } } });
    }
    await app?.close();
  });

  const buyer = (networkIds: string[]): UserPrincipal =>
    ({ kind: 'user', orgId: ids.buyer, networkIds }) as unknown as UserPrincipal;

  const ours = (found: string[]) =>
    Object.entries(ids)
      .filter(([, id]) => found.includes(id))
      .map(([key]) => key)
      .sort();

  it('finds network members, listed Partners and published marketplace supply', async () => {
    const found = await visiblePartnerIds(prisma, buyer([networkId]));
    expect(ours(found)).toEqual(['listed', 'networked', 'publishedOffer']);
  });

  it('without a network, finds only what is open to every Buyer', async () => {
    const found = await visiblePartnerIds(prisma, buyer([]));
    expect(ours(found)).toEqual(['listed', 'publishedOffer']);
  });

  it('answers the same for one Partner at a time', async () => {
    const principal = buyer([networkId]);
    const seen: string[] = [];
    for (const [key, id] of Object.entries(ids)) {
      if (await canSeePartner(prisma, principal, id)) seen.push(key);
    }
    expect(seen.sort()).toEqual(['listed', 'networked', 'publishedOffer']);
  });

  it('stops finding a Partner once it unlists', async () => {
    await prisma.partnerProfile.update({
      where: { orgId: ids.listed },
      data: { marketplaceListed: false, marketplaceListedAt: null },
    });
    expect(await canSeePartner(prisma, buyer([]), ids.listed!)).toBe(false);
  });
});
