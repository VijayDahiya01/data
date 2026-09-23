/**
 * The Agent's report of an external audience sync -- §47.11, §48.9.
 *
 * Two things are being pinned here. One is that the endpoint refuses what it
 * should: another Partner's activation, and an activation that never cleared
 * eligibility. The other is that it records enough to tell a broken upload
 * from a working one, because the visible symptom of a wrong field mapping is
 * only that the campaign under-delivers.
 */
import { ChannelStatusService } from './channel-status.service.js';
import { ReportChannelSyncSchema } from './channel-status.schema.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { AuditService } from '../../common/audit/audit.service.js';

const PARTNER = 'partner-1';
const OTHER = 'partner-2';

interface Recorded {
  activationUpdates: unknown[];
  resourceWrites: unknown[];
  audits: Array<{ action: string; metadata?: Record<string, unknown> }>;
}

function serviceWith(activation: Record<string, unknown> | null): {
  service: ChannelStatusService;
  recorded: Recorded;
} {
  const recorded: Recorded = { activationUpdates: [], resourceWrites: [], audits: [] };

  const prisma = {
    activation: {
      findUnique: async () => activation,
      update: async (args: unknown) => {
        recorded.activationUpdates.push(args);
        return {};
      },
    },
    externalResource: {
      upsert: async (args: { create: { resourceStatus: string } }) => {
        recorded.resourceWrites.push(args);
        return { resourceStatus: args.create.resourceStatus };
      },
    },
  } as unknown as PrismaService;

  const audit = {
    record: async (input: { action: string; metadata?: Record<string, unknown> }) => {
      recorded.audits.push(input);
    },
  } as unknown as AuditService;

  return { service: new ChannelStatusService(prisma, audit), recorded };
}

function liveActivation(overrides: Record<string, unknown> = {}) {
  return {
    id: 'act-1',
    channel: 'META',
    status: 'READY',
    request: { partnerOrgId: PARTNER },
    ...overrides,
  };
}

const validInput = ReportChannelSyncSchema.parse({
  activation_id: '00000000-0000-4000-8000-000000000001',
  provider: 'META',
  resource_id: 'aud-1',
  status: 'READY',
  accepted: 100,
  skipped: 2,
});

describe('ChannelStatusService', () => {
  it('records the resource id and counts, and takes the activation live', async () => {
    const { service, recorded } = serviceWith(liveActivation());
    const out = await service.report(PARTNER, validInput);

    expect(out.accepted).toBe(100);
    expect(recorded.resourceWrites).toHaveLength(1);
    // READY means permission to upload; LIVE means it actually did. Without
    // the distinction nobody can tell a Buyer whether the campaign is running.
    expect(recorded.activationUpdates).toHaveLength(1);
    expect(recorded.audits[0]?.action).toBe('CHANNEL_AUDIENCE_SYNCED');
  });

  it('refuses a report for another Partner activation', async () => {
    // Otherwise any valid agent token is a cross-tenant write: an Agent could
    // end a competitor's campaign.
    const { service, recorded } = serviceWith(liveActivation());
    await expect(service.report(OTHER, validInput)).rejects.toThrow();
    expect(recorded.resourceWrites).toHaveLength(0);
    expect(recorded.activationUpdates).toHaveLength(0);
  });

  it('refuses a report for an activation that never cleared eligibility', async () => {
    // §48.5: if blocked, no customer data is prepared or uploaded. A status
    // arriving for one means a bug, or an Agent acting on a manifest it should
    // not be holding.
    const { service, recorded } = serviceWith(liveActivation({ status: 'PENDING_CHANNEL_CHECK' }));
    await expect(service.report(PARTNER, validInput)).rejects.toThrow();
    expect(recorded.resourceWrites).toHaveLength(0);
  });

  it('refuses a report for an owned-media activation', async () => {
    const { service } = serviceWith(liveActivation({ channel: 'PARTNER_WEB' }));
    await expect(service.report(PARTNER, validInput)).rejects.toThrow();
  });

  it('does not move the activation for mere progress states', async () => {
    // A status that flickers between UPLOADING and LIVE is worse than one that
    // waits.
    for (const status of ['PREPARING', 'UPLOADING', 'PROCESSING'] as const) {
      const { service, recorded } = serviceWith(liveActivation());
      await service.report(PARTNER, { ...validInput, status });
      expect(recorded.activationUpdates).toHaveLength(0);
    }
  });

  it('records a failure with its reason', async () => {
    const { service, recorded } = serviceWith(liveActivation());
    await service.report(PARTNER, {
      ...validInput,
      status: 'FAILED',
      error_detail: 'audience rejected by the platform',
    });
    expect(recorded.audits[0]?.action).toBe('CHANNEL_AUDIENCE_SYNC_FAILED');
    expect(recorded.activationUpdates).toHaveLength(1);
  });

  describe('the schema is the boundary that keeps audience data out', () => {
    it('rejects unknown fields rather than ignoring them', () => {
      // This endpoint is exactly where a well-meaning "sample of failed rows"
      // would arrive. Silently dropping it means nobody notices the attempt.
      const withExtra = {
        activation_id: '00000000-0000-4000-8000-000000000001',
        provider: 'META',
        status: 'READY',
        failed_rows: [{ email: 'person@example.com' }],
      };
      expect(ReportChannelSyncSchema.safeParse(withExtra).success).toBe(false);
    });

    it('bounds the error detail so it cannot carry a batch of records', () => {
      const huge = {
        activation_id: '00000000-0000-4000-8000-000000000001',
        provider: 'META',
        status: 'FAILED',
        error_detail: 'x'.repeat(5000),
      };
      expect(ReportChannelSyncSchema.safeParse(huge).success).toBe(false);
    });

    it('accepts only the two external providers', () => {
      const owned = {
        activation_id: '00000000-0000-4000-8000-000000000001',
        provider: 'PARTNER_WEB',
        status: 'READY',
      };
      expect(ReportChannelSyncSchema.safeParse(owned).success).toBe(false);
    });
  });
});
