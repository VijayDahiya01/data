/**
 * Synonyms learned from Partners (docs/DESIGN-PARTNER-DATA.md §5.6), against
 * the real schema: what a Partner may share, how an admin sees it, and that
 * nothing reaches the approved list -- which every Agent downloads -- before
 * an admin approves it.
 */
import { randomUUID } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './app.factory.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { SynonymsService } from '../src/modules/suggestions/synonyms.service.js';

describe('Shared synonyms (§5.6)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let synonyms: SynonymsService;
  const run = `syn${Date.now()}`;
  const attr = `syn_cat_${Date.now()}`;
  const orgs: string[] = [];

  beforeAll(async () => {
    ({ app } = await createTestApp());
    prisma = app.get(PrismaService);
    synonyms = app.get(SynonymsService);
    await prisma.attributeDefinition.create({
      data: {
        key: attr,
        displayName: 'Test category',
        category: 'COMMERCE',
        dataType: 'ENUM',
        operatorsJson: ['IN'],
        allowedValuesJson: ['FOOTWEAR', 'FASHION'],
      },
    });
    for (const n of [1, 2, 3]) {
      const o = await prisma.organization.create({
        data: {
          type: 'DATA_PARTNER',
          name: `${run} partner ${n}`,
          domain: `p${n}.${run}.example`,
          verificationStatus: 'BUSINESS_VERIFIED',
          country: 'IN',
        },
      });
      orgs.push(o.id);
    }
  });

  afterAll(async () => {
    if (prisma) {
      await prisma.sharedSynonym.deleteMany({ where: { attributeKey: attr } });
      await prisma.organization.deleteMany({ where: { id: { in: orgs } } });
      await prisma.attributeDefinition.deleteMany({ where: { key: attr } });
    }
    await app?.close();
  });

  const ours = <T extends { attribute_key: string }>(items: T[]) =>
    items.filter((i) => i.attribute_key === attr);

  it('keeps only shareable answers in the attribute’s codes', async () => {
    const got = await synonyms.share(orgs[0]!, randomUUID(), {
      answers: [
        { attribute_key: attr, value: 'Kurtis', code: 'FASHION' },
        { attribute_key: attr, value: 'Running shoes', code: 'FOOTWEAR' },
        { attribute_key: attr, value: 'asha@example.com', code: 'FASHION' }, // a person
        { attribute_key: attr, value: 'Toys', code: 'TOYS' }, // not a code
        { attribute_key: 'no_such_attribute', value: 'Kurtis', code: 'FASHION' },
      ],
    });
    expect(got).toEqual({ shared: 2, skipped: 3 });
  });

  it('shows an admin what Partners shared, counted and never named', async () => {
    await synonyms.share(orgs[1]!, randomUUID(), {
      answers: [{ attribute_key: attr, value: 'KURTIS', code: 'FASHION' }],
    });
    await synonyms.share(orgs[2]!, randomUUID(), {
      answers: [{ attribute_key: attr, value: 'kurtis', code: 'FOOTWEAR' }],
    });
    const { pending } = await synonyms.review();
    const mine = ours(pending);
    expect(mine[0]).toMatchObject({
      value_key: 'kurtis',
      partners: 3,
      codes: [
        { code: 'FASHION', partners: 2 },
        { code: 'FOOTWEAR', partners: 1 },
      ],
    });
    expect(mine.map((p) => p.value_key)).toEqual(['kurtis', 'running shoes']);
    expect(JSON.stringify(pending)).not.toContain(orgs[0]!);
  });

  it('sends nothing to Agents until an admin approves it', async () => {
    const before = await synonyms.approved();
    expect(ours(before.synonyms)).toEqual([]);

    await synonyms.decide(randomUUID(), {
      attribute_key: attr,
      value_key: 'Kurtis',
      code: 'FASHION',
      status: 'APPROVED',
    });
    await synonyms.decide(randomUUID(), {
      attribute_key: attr,
      value_key: 'running shoes',
      code: 'FOOTWEAR',
      status: 'REJECTED',
    });

    const after = await synonyms.approved();
    expect(ours(after.synonyms)).toEqual([
      { attribute_key: attr, value_key: 'kurtis', code: 'FASHION' },
    ]);
    expect(after.version).not.toBe(before.version);

    const { pending, decided } = await synonyms.review();
    expect(ours(pending)).toEqual([]);
    expect(
      ours(decided)
        .map((d) => d.status)
        .sort(),
    ).toEqual(['APPROVED', 'REJECTED']);

    await expect(
      synonyms.decide(randomUUID(), {
        attribute_key: attr,
        value_key: 'kurtis',
        code: 'TOYS',
        status: 'APPROVED',
      }),
    ).rejects.toMatchObject({ code: 'VAL_001' });
  });

  it('withdraws everything a Partner shared when it stops sharing', async () => {
    await synonyms.share(orgs[0]!, randomUUID(), { answers: [] });
    expect(await prisma.synonymContribution.count({ where: { partnerOrgId: orgs[0]! } })).toBe(0);
    expect(await prisma.synonymContribution.count({ where: { partnerOrgId: orgs[1]! } })).toBe(1);
  });
});
