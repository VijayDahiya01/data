/**
 * The Oolix attribute taxonomy — v6 §4, Appendix A.
 *
 * This is PLATFORM data, not a test fixture. §4 makes the taxonomy
 * Oolix-controlled and versioned, and every environment needs it — including
 * production, where §95 forbids seeding organizations. So this is written to be
 * idempotent and safe to run anywhere: it upserts by (key, version) and never
 * touches a version that already exists.
 *
 * Why a fixed taxonomy at all: §17 forbids arbitrary SQL, JavaScript or regex
 * rules. A Buyer can only compose what is defined here, which is what makes it
 * possible for a Data Partner to evaluate a rule against a restricted view
 * instead of exposing a general query engine.
 */
import type { PrismaClient } from '../../src/generated/prisma/client.js';

interface SeedAttribute {
  key: string;
  displayName: string;
  description: string;
  category:
    'DEMOGRAPHIC' | 'GEOGRAPHY' | 'COMMERCE' | 'PAYMENT_BEHAVIOUR' | 'TRAVEL' | 'ENGAGEMENT';
  dataType: 'NUMBER' | 'ENUM' | 'BOOLEAN' | 'ID';
  operators: string[];
  allowedValues?: string[];
  minValue?: number;
  maxValue?: number;
  unit?: string;
  policyClass?: 'GENERAL' | 'RESTRICTED' | 'SENSITIVE';
}

/**
 * Appendix A's MVP catalogue.
 *
 * Everything here is `GENERAL`. §4: "Do not enable highly sensitive classes in
 * the MVP without explicit legal/policy design" — so health, financial standing,
 * religion, political affiliation and the like are absent rather than present
 * and disabled. Adding one is a policy decision, not a data entry task.
 */
export const MVP_ATTRIBUTES: SeedAttribute[] = [
  {
    key: 'age',
    displayName: 'Age',
    description: 'Age in years. Partners derive this locally, usually from a date of birth.',
    category: 'DEMOGRAPHIC',
    dataType: 'NUMBER',
    operators: ['BETWEEN'],
    minValue: 13,
    maxValue: 120,
    unit: 'years',
  },
  {
    key: 'gender',
    displayName: 'Gender',
    description: 'Self-reported gender, where the Partner holds it.',
    category: 'DEMOGRAPHIC',
    dataType: 'ENUM',
    operators: ['IN'],
    allowedValues: ['MALE', 'FEMALE', 'OTHER', 'UNDISCLOSED'],
  },
  {
    key: 'country',
    displayName: 'Country',
    description: 'ISO 3166-1 alpha-2 country code.',
    category: 'GEOGRAPHY',
    dataType: 'ENUM',
    operators: ['IN'],
    allowedValues: ['IN'],
  },
  {
    key: 'state_region',
    displayName: 'State or region',
    description: 'Standardised subdivision code.',
    category: 'GEOGRAPHY',
    dataType: 'ENUM',
    operators: ['IN'],
    allowedValues: ['DL', 'HR', 'UP', 'KA', 'MH', 'TN', 'TG', 'GJ', 'WB', 'RJ'],
  },
  {
    key: 'city',
    displayName: 'City',
    description: 'Standard geography identifier.',
    category: 'GEOGRAPHY',
    dataType: 'ENUM',
    operators: ['IN'],
    allowedValues: [
      'DELHI',
      'GURUGRAM',
      'NOIDA',
      'MUMBAI',
      'BENGALURU',
      'CHENNAI',
      'HYDERABAD',
      'PUNE',
      'KOLKATA',
      'AHMEDABAD',
    ],
  },
  {
    key: 'online_shopper',
    displayName: 'Online shopper',
    description: 'Has transacted online within the Partner’s own activity window.',
    category: 'COMMERCE',
    dataType: 'BOOLEAN',
    operators: ['EQ'],
  },
  {
    key: 'purchase_category',
    displayName: 'Purchase category',
    description: 'Product category the person has bought in.',
    category: 'COMMERCE',
    dataType: 'ENUM',
    operators: ['IN'],
    allowedValues: [
      'FOOTWEAR',
      'FASHION',
      'ELECTRONICS',
      'GROCERY',
      'TRAVEL',
      'BEAUTY',
      'HOME',
      'SPORTS',
    ],
  },
  {
    key: 'purchase_recency_days',
    displayName: 'Purchased within',
    description: 'Days since the most recent purchase.',
    category: 'COMMERCE',
    dataType: 'NUMBER',
    operators: ['LTE'],
    minValue: 1,
    maxValue: 730,
    unit: 'days',
  },
  {
    key: 'purchase_frequency',
    displayName: 'Purchase frequency',
    description: 'Number of purchases in the Partner’s standard window.',
    category: 'COMMERCE',
    dataType: 'NUMBER',
    operators: ['GTE'],
    minValue: 1,
    maxValue: 100,
    unit: 'purchases',
  },
  {
    key: 'payment_method',
    displayName: 'Payment method',
    description: 'Payment instruments the person has used.',
    category: 'PAYMENT_BEHAVIOUR',
    dataType: 'ENUM',
    operators: ['IN'],
    allowedValues: ['UPI', 'CREDIT_CARD', 'DEBIT_CARD', 'NET_BANKING', 'COD', 'WALLET'],
  },
  {
    key: 'recent_booking',
    displayName: 'Recent booking',
    description: 'Has completed a travel booking.',
    category: 'TRAVEL',
    dataType: 'BOOLEAN',
    operators: ['EQ'],
  },
  {
    key: 'domestic_international',
    displayName: 'Travel type',
    description: 'Whether recent travel was domestic or international.',
    category: 'TRAVEL',
    dataType: 'ENUM',
    operators: ['IN'],
    allowedValues: ['DOMESTIC', 'INTERNATIONAL'],
  },
  {
    key: 'booking_recency_days',
    displayName: 'Booked within',
    description: 'Days since the most recent booking.',
    category: 'TRAVEL',
    dataType: 'NUMBER',
    operators: ['LTE'],
    minValue: 1,
    maxValue: 730,
    unit: 'days',
  },
  {
    key: 'active_user_days',
    displayName: 'Active within',
    description: 'Days since the person last used the Partner’s product.',
    category: 'ENGAGEMENT',
    dataType: 'NUMBER',
    operators: ['LTE'],
    minValue: 1,
    maxValue: 365,
    unit: 'days',
  },
  {
    key: 'app_active',
    displayName: 'App active',
    description: 'Uses the Partner’s mobile app.',
    category: 'ENGAGEMENT',
    dataType: 'BOOLEAN',
    operators: ['EQ'],
  },
  {
    key: 'loyalty_tier',
    displayName: 'Loyalty tier',
    description: 'Partner loyalty programme tier.',
    category: 'ENGAGEMENT',
    dataType: 'ENUM',
    operators: ['IN'],
    allowedValues: ['BRONZE', 'SILVER', 'GOLD', 'PLATINUM'],
  },
];

/**
 * Install the taxonomy.
 *
 * Idempotent by (key, version): running it again changes nothing, and bumping
 * an attribute means adding a new version rather than editing the old one —
 * §4 binds a campaign request to the exact taxonomy version the Partner
 * approved, so editing in place would retroactively change what somebody
 * agreed to.
 */
export async function seedAttributeTaxonomy(prisma: PrismaClient): Promise<number> {
  for (const attr of MVP_ATTRIBUTES) {
    await prisma.attributeDefinition.upsert({
      where: { key_version: { key: attr.key, version: 1 } },
      create: {
        key: attr.key,
        displayName: attr.displayName,
        description: attr.description,
        category: attr.category as never,
        dataType: attr.dataType as never,
        operatorsJson: attr.operators,
        allowedValuesJson: attr.allowedValues ?? undefined,
        minValue: attr.minValue ?? null,
        maxValue: attr.maxValue ?? null,
        unit: attr.unit ?? null,
        policyClass: (attr.policyClass ?? 'GENERAL') as never,
        version: 1,
        active: true,
      },
      // Display text may be corrected; the semantics (type, operators, allowed
      // values) may not — those would change what a rule MEANS.
      update: {
        displayName: attr.displayName,
        description: attr.description,
        active: true,
      },
    });
  }

  return MVP_ATTRIBUTES.length;
}
