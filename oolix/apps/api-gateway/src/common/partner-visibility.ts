/**
 * §66.2: which Data Partners a Buyer may discover and transact with.
 *
 * One rule, used everywhere a Buyer can reach a Partner — the capability
 * match, a reach-estimate request, the placement list. It used to be restated
 * in each of those places, and the copies had drifted: one counted a
 * marketplace offer on a draft segment, another asked for nothing at all.
 *
 * A Buyer sees a Partner when any of these holds:
 *
 *  - they share an ACTIVE Network membership;
 *  - the Partner offers a PUBLISHED segment on the marketplace;
 *  - the Partner has listed itself on the marketplace, which is how a Partner
 *    that only publishes capabilities (Partner Connect) is found at all.
 *
 * The last two are open to every Buyer, so they also require a verified
 * Partner. A suspended Partner is found by nobody, and a Buyer never finds
 * its own organization.
 */
import type { UserPrincipal } from '@oolix/auth-rbac';
import type { PrismaService } from '../prisma/prisma.service.js';

/** Verification states in which an organization has passed business checks. */
export const VERIFIED_STATUSES = ['BUSINESS_VERIFIED', 'ROLE_ONBOARDING', 'ACTIVE'] as const;

const verified = { verificationStatus: { in: [...VERIFIED_STATUSES] } };
const notSuspended = { verificationStatus: { not: 'SUSPENDED' as const } };

/** Every Partner this Buyer may see. */
export async function visiblePartnerIds(
  prisma: PrismaService,
  principal: UserPrincipal,
): Promise<string[]> {
  const [members, offers, listed] = await Promise.all([
    principal.networkIds.length > 0
      ? prisma.networkMembership.findMany({
          where: {
            networkId: { in: principal.networkIds },
            status: 'ACTIVE',
            organization: notSuspended,
          },
          select: { orgId: true },
        })
      : Promise.resolve([]),
    prisma.segmentOffer.findMany({
      where: {
        visibility: 'MARKETPLACE',
        segment: { status: 'PUBLISHED', organization: verified },
      },
      select: { segment: { select: { partnerOrgId: true } } },
    }),
    prisma.partnerProfile.findMany({
      where: { marketplaceListed: true, organization: verified },
      select: { orgId: true },
    }),
  ]);

  const ids = new Set([
    ...members.map((m) => m.orgId),
    ...offers.map((o) => o.segment.partnerOrgId),
    ...listed.map((l) => l.orgId),
  ]);
  ids.delete(principal.orgId);
  return [...ids];
}

/** Whether this Buyer may see one Partner — the same rule, asked of one org. */
export async function canSeePartner(
  prisma: PrismaService,
  principal: UserPrincipal,
  partnerOrgId: string,
): Promise<boolean> {
  if (partnerOrgId === principal.orgId) return false;

  const [member, offer, listed] = await Promise.all([
    principal.networkIds.length > 0
      ? prisma.networkMembership.findFirst({
          where: {
            orgId: partnerOrgId,
            networkId: { in: principal.networkIds },
            status: 'ACTIVE',
            organization: notSuspended,
          },
          select: { orgId: true },
        })
      : Promise.resolve(null),
    prisma.segmentOffer.findFirst({
      where: {
        visibility: 'MARKETPLACE',
        segment: { partnerOrgId, status: 'PUBLISHED', organization: verified },
      },
      select: { id: true },
    }),
    prisma.partnerProfile.findFirst({
      where: { orgId: partnerOrgId, marketplaceListed: true, organization: verified },
      select: { orgId: true },
    }),
  ]);
  return Boolean(member ?? offer ?? listed);
}
