/**
 * Data Partner capability metadata — v6 §5.1, §7.
 *
 * §5.1 is what a Partner publishes to Oolix: which standardized attributes they
 * can answer questions about, over which geographies and channels. §17 draws
 * the line hard — Oolix stores "Partner capability metadata, not Partner
 * customer records or Partner local field names". So nothing here names a
 * column, a table or a person. `payment_method` is a taxonomy key; the fact
 * that Travel A stores it as `pay_mode` lives in the Agent's own config file
 * and never reaches this database.
 *
 * The two Partners deliberately publish DIFFERENT coverage. That is what makes
 * §7's asymmetry visible in the demo rather than theoretical: a travel audience
 * with a REQUIRED `recent_booking` rule is COMPATIBLE for Travel A and
 * INCOMPATIBLE for Rewards B — not "lower scoring", but unanswerable.
 */
import type { PrismaClient } from '../../src/generated/prisma/client.js';

/** §4: the operators each data type supports, mirrored from the taxonomy. */
const NUMBER_OPS = ['EQ', 'IN', 'LTE', 'GTE', 'BETWEEN'];
const ENUM_OPS = ['EQ', 'IN'];
const BOOLEAN_OPS = ['EQ'];

interface CapabilitySeed {
  partnerOrgId: string;
  label: string;
  /** Taxonomy keys only. Never a local field name (§17). */
  attributes: Array<{ attribute_key: string; operators: string[] }>;
  geographies: string[];
  channels: string[];
  /**
   * §11: the Agent reports which local mapping version it compiled against, so
   * a reach estimate can be traced to the mapping that produced it. It must
   * match the `mapping_version` in that Partner's agent config.
   */
  mappingVersion: number;
}

const attr = (keys: string[], operators: string[]) =>
  keys.map((attribute_key) => ({ attribute_key, operators }));

export const PARTNER_CAPABILITIES: CapabilitySeed[] = [
  {
    // Travel A runs the local Agent in this environment, and its attribute
    // view covers the full Appendix A catalogue — so its published capability
    // matches partner-agent/config.example.yaml exactly. Publishing more than
    // the Agent can map would make Oolix send rules the Agent must refuse.
    partnerOrgId: '22222222-2222-4222-8222-222222222222',
    label: 'Travel A',
    attributes: [
      ...attr(
        [
          'age',
          'purchase_recency_days',
          'purchase_frequency',
          'booking_recency_days',
          'active_user_days',
        ],
        NUMBER_OPS,
      ),
      ...attr(
        [
          'gender',
          'country',
          'state_region',
          'city',
          'purchase_category',
          'payment_method',
          'domestic_international',
          'loyalty_tier',
        ],
        ENUM_OPS,
      ),
      ...attr(['online_shopper', 'recent_booking', 'app_active'], BOOLEAN_OPS),
    ],
    geographies: ['IN'],
    // §7 / §84: Meta and Google are absent rather than declared-and-disabled.
    // A capability a Buyer can see is one they can select, and §32 says not to
    // show an external channel as selectable until eligibility is proven.
    channels: ['PARTNER_WEB', 'PARTNER_APP'],
    mappingVersion: 8,
  },
  {
    // Rewards B is a retail rewards programme: rich commerce data, no travel
    // history at all. Its Agent has no `has_recent_trip` column to map, so
    // declaring the attribute would be a lie the Agent could not honour.
    partnerOrgId: '33333333-3333-4333-8333-333333333333',
    label: 'Rewards B',
    attributes: [
      ...attr(['age', 'purchase_recency_days', 'active_user_days'], NUMBER_OPS),
      ...attr(
        ['gender', 'country', 'state_region', 'purchase_category', 'payment_method'],
        ENUM_OPS,
      ),
      ...attr(['online_shopper', 'app_active'], BOOLEAN_OPS),
    ],
    geographies: ['IN'],
    channels: ['PARTNER_WEB'],
    mappingVersion: 3,
  },
];

/**
 * Publish version 1 of each Partner's capabilities.
 *
 * Idempotent by (partner, capability_version) so re-seeding never creates a
 * second version. A real re-publish goes through
 * `POST /v1/partner/capabilities`, which mints a NEW version — §16 keeps old
 * versions readable so a past approval can still be explained.
 */
export async function seedPartnerCapabilities(prisma: PrismaClient): Promise<void> {
  for (const cap of PARTNER_CAPABILITIES) {
    await prisma.partnerCapability.upsert({
      where: {
        partnerOrgId_capabilityVersion: {
          partnerOrgId: cap.partnerOrgId,
          capabilityVersion: 1,
        },
      },
      create: {
        partnerOrgId: cap.partnerOrgId,
        capabilityVersion: 1,
        attributesJson: cap.attributes.map((a) => ({ ...a, status: 'AVAILABLE' })),
        geographiesJson: cap.geographies,
        channelsJson: cap.channels,
        status: 'ACTIVE',
        mappingVersion: cap.mappingVersion,
      },
      update: {},
    });
  }

  const summary = PARTNER_CAPABILITIES.map(
    (c) => `${c.label}: ${c.attributes.length} attributes`,
  ).join(', ');
  console.log(`[seed] partner capabilities (${summary})`);
}
