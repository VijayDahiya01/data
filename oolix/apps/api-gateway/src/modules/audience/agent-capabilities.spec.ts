/**
 * A managed Agent publishing its own capabilities (Partner Connect).
 *
 * What is pinned: the Agent publishes for its OWN registered Partner and no
 * other (§92.4), under the same rules a person publishing from the portal
 * meets -- a verified business (§66.3), taxonomy operators only -- and the
 * audit trail names the Agent rather than pretending a person did it.
 */
import type { AgentPrincipal } from '@oolix/auth-rbac';
import { AudienceService } from './audience.service.js';
import { PublishCapabilitiesSchema } from './audience.schema.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { AuditService } from '../../common/audit/audit.service.js';

const agent: AgentPrincipal = {
  kind: 'agent',
  agentId: 'agent-1',
  clientId: 'oolix_agent_1',
  partnerOrgId: 'partner-1',
  scopes: ['capabilities:write'],
  agentVersion: '1.0.0',
};

interface Recorded {
  created: Array<{ data: Record<string, unknown> }>;
  superseded: unknown[];
  audits: Array<Record<string, unknown>>;
}

function serviceFor(verificationStatus: string | null) {
  const recorded: Recorded = { created: [], superseded: [], audits: [] };
  const tx = {
    partnerCapability: {
      update: async (args: unknown) => {
        recorded.superseded.push(args);
        return {};
      },
      create: async (args: { data: Record<string, unknown> }) => {
        recorded.created.push(args);
        return { id: 'cap-2', publishedAt: new Date('2026-09-26T00:00:00Z') };
      },
    },
  };
  const prisma = {
    organization: {
      findUnique: async () => (verificationStatus ? { verificationStatus } : null),
    },
    attributeDefinition: {
      findMany: async () => [
        { key: 'age', dataType: 'NUMBER', operatorsJson: ['BETWEEN'], allowedValuesJson: null },
        { key: 'city', dataType: 'ENUM', operatorsJson: ['IN'], allowedValuesJson: ['MUMBAI'] },
      ],
    },
    partnerCapability: {
      findFirst: async () => ({ id: 'cap-1', capabilityVersion: 1 }),
    },
    $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
  } as unknown as PrismaService;
  const audit = {
    record: async (input: Record<string, unknown>) => {
      recorded.audits.push(input);
    },
  } as unknown as AuditService;
  return { service: new AudienceService(prisma, audit), recorded };
}

const input = PublishCapabilitiesSchema.parse({
  attributes: [
    { attribute_key: 'age', operators: ['BETWEEN'] },
    { attribute_key: 'city', operators: ['IN'] },
  ],
  geographies: ['IN'],
  channels: ['PARTNER_WEB'],
  mapping_version: 1,
});

describe('AudienceService.publishCapabilitiesFromAgent', () => {
  it("publishes a new version for the Agent's own Partner, audited as the Agent", async () => {
    const { service, recorded } = serviceFor('BUSINESS_VERIFIED');
    const out = await service.publishCapabilitiesFromAgent(agent, input);

    expect(out.capability_version).toBe(2);
    expect(recorded.superseded).toHaveLength(1);
    expect(recorded.created[0]?.data.partnerOrgId).toBe('partner-1');
    expect(recorded.audits[0]).toMatchObject({
      action: 'PARTNER_CAPABILITIES_PUBLISHED',
      actor: 'agent-1',
      actorType: 'AGENT',
      orgId: 'partner-1',
    });
  });

  it('refuses a Partner that is not a verified business, and writes nothing', async () => {
    const { service, recorded } = serviceFor('BUSINESS_VERIFICATION_PENDING');
    await expect(service.publishCapabilitiesFromAgent(agent, input)).rejects.toMatchObject({
      code: 'PERM_001',
    });
    expect(recorded.created).toHaveLength(0);
    expect(recorded.audits).toHaveLength(0);
  });

  it('holds the Agent to the taxonomy, like a person', async () => {
    const { service, recorded } = serviceFor('ACTIVE');
    const wrong = PublishCapabilitiesSchema.parse({
      ...input,
      attributes: [{ attribute_key: 'age', operators: ['IN'] }],
    });
    await expect(service.publishCapabilitiesFromAgent(agent, wrong)).rejects.toMatchObject({
      code: 'VAL_001',
    });
    expect(recorded.created).toHaveLength(0);
  });
});

describe('AudienceService data quality (Partner Connect)', () => {
  function serviceForQuality() {
    const upserts: Array<{ where: unknown; create: Record<string, unknown> }> = [];
    const prisma = {
      attributeDefinition: {
        findMany: async () => [
          { key: 'age', dataType: 'NUMBER', operatorsJson: ['BETWEEN'], allowedValuesJson: null },
        ],
      },
      partnerDataQuality: {
        upsert: async (args: { where: unknown; create: Record<string, unknown> }) => {
          upserts.push(args);
          return {};
        },
        findUnique: async () => ({
          reportedAt: new Date('2026-09-26T02:00:00Z'),
          syncedAt: new Date('2026-09-26T01:55:00Z'),
          syncMode: 'FULL',
          customersBucket: '10K_50K',
          attributesJson: [{ attribute_key: 'age', coverage_pct: 92, unreadable_pct: 1 }],
        }),
      },
    } as unknown as PrismaService;
    return {
      service: new AudienceService(prisma, { record: async () => {} } as unknown as AuditService),
      upserts,
    };
  }

  it("stores the report for the Agent's own Partner, replacing the last", async () => {
    const { service, upserts } = serviceForQuality();
    await service.recordDataQuality(agent, {
      synced_at: '2026-09-26T01:55:00Z',
      sync_mode: 'FULL',
      customers_bucket: '10K_50K',
      attributes: [{ attribute_key: 'age', coverage_pct: 92, unreadable_pct: 1 }],
    });
    expect(upserts).toHaveLength(1);
    expect(upserts[0]?.where).toEqual({ partnerOrgId: 'partner-1' });
    expect(upserts[0]?.create).toMatchObject({
      partnerOrgId: 'partner-1',
      agentId: 'agent-1',
      customersBucket: '10K_50K',
    });
  });

  it('refuses an attribute the taxonomy does not know', async () => {
    const { service, upserts } = serviceForQuality();
    await expect(
      service.recordDataQuality(agent, {
        synced_at: '2026-09-26T01:55:00Z',
        sync_mode: 'FULL',
        customers_bucket: 'UNDER_10K',
        attributes: [{ attribute_key: 'income', coverage_pct: 10, unreadable_pct: 0 }],
      }),
    ).rejects.toMatchObject({ code: 'VAL_001' });
    expect(upserts).toHaveLength(0);
  });

  it('shows the Partner their latest report', async () => {
    const { service } = serviceForQuality();
    const out = await service.myDataQuality({ orgId: 'partner-1' } as never);
    expect(out).toMatchObject({ sync_mode: 'FULL', customers_bucket: '10K_50K' });
  });
});
