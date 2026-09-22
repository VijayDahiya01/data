/**
 * Business verification -- spec v5 §35.2, §66.3.
 *
 * These pin the half of the verification model that did not exist until
 * 2026-09-22. An organization is created at BUSINESS_VERIFICATION_PENDING and
 * §66.3 lets it browse and draft but not submit or publish. Nothing in the
 * running system could move it on: the only writer of BUSINESS_VERIFIED was
 * the development seed, and `db:seed --env=production` refuses by design. A
 * real deployment could therefore onboard an organization and then refuse
 * everything it tried to do, with no way out but an UPDATE against the
 * production database.
 *
 * The properties below are the ones that are silent when wrong. A verify that
 * regressed ACTIVE to BUSINESS_VERIFIED would look like success. A revoke
 * without an audit row would leave a Partner cut off with no record of who did
 * it or why.
 */
import { IdentityOrgService } from './identity-org.service.js';

interface OrgRow {
  id: string;
  name: string;
  domain: string;
  type: string;
  country: string;
  verificationStatus: string;
}

const ORG: OrgRow = {
  id: 'org_1',
  name: 'Acme Travel',
  domain: 'acme.example',
  type: 'DATA_PARTNER',
  country: 'IN',
  verificationStatus: 'BUSINESS_VERIFICATION_PENDING',
};

/**
 * A Prisma stand-in that records what the transaction did.
 *
 * Hand-rolled rather than mocked wholesale so the assertions are about the
 * data written, not about which methods happened to be called.
 */
function harness(org: OrgRow | null) {
  const updated: Record<string, unknown>[] = [];
  const audited: Record<string, unknown>[] = [];

  const tx = {
    organization: {
      update: async ({ data }: { data: Record<string, unknown> }) => {
        updated.push(data);
        return { ...(org as OrgRow), ...data };
      },
    },
  };

  const prisma = {
    organization: {
      findUnique: async () => org,
      findMany: async () => [],
    },
    $transaction: async <T>(fn: (t: typeof tx) => Promise<T>): Promise<T> => fn(tx),
  };

  const audit = {
    record: async () => undefined,
    recordTx: async (_t: unknown, input: Record<string, unknown>) => {
      audited.push(input);
    },
  };

  const service = new IdentityOrgService(prisma as never, audit as never);
  return { service, updated, audited };
}

describe('§35.2 verifying an organization', () => {
  it('moves a pending organization to BUSINESS_VERIFIED', async () => {
    const { service, updated } = harness({ ...ORG });

    const result = await service.verifyOrganization('org_1', 'usr_admin');

    expect(updated).toEqual([{ verificationStatus: 'BUSINESS_VERIFIED' }]);
    expect(result.changed).toBe(true);
    expect(result.verification_status).toBe('BUSINESS_VERIFIED');
  });

  it('writes an audit row naming the transition and the actor', async () => {
    // §56: a state change nobody can attribute later is not an audit trail.
    const { service, audited } = harness({ ...ORG });

    await service.verifyOrganization('org_1', 'usr_admin', 'companies-house 12345');

    expect(audited).toHaveLength(1);
    expect(audited[0]).toMatchObject({
      action: 'ORGANIZATION_VERIFIED',
      entityType: 'organization',
      entityId: 'org_1',
      actor: 'usr_admin',
      metadata: {
        from: 'BUSINESS_VERIFICATION_PENDING',
        to: 'BUSINESS_VERIFIED',
        note: 'companies-house 12345',
      },
    });
  });

  it.each(['BUSINESS_VERIFIED', 'ROLE_ONBOARDING', 'ACTIVE'])(
    'does not drag %s backwards',
    async (state) => {
      // The one that would be silent. ROLE_ONBOARDING and ACTIVE are FURTHER
      // along than BUSINESS_VERIFIED, so a retried verify that rewrote the
      // state would undo progress and still report success.
      const { service, updated, audited } = harness({ ...ORG, verificationStatus: state });

      const result = await service.verifyOrganization('org_1', 'usr_admin');

      expect(updated).toEqual([]);
      expect(audited).toEqual([]);
      expect(result.changed).toBe(false);
      expect(result.verification_status).toBe(state);
    },
  );

  it('refuses an organization that does not exist', async () => {
    const { service } = harness(null);
    await expect(service.verifyOrganization('missing', 'usr_admin')).rejects.toThrow(/not found/i);
  });
});

describe('§35.2 revoking verification', () => {
  it('puts a verified organization back to pending, with the reason', async () => {
    const { service, updated, audited } = harness({
      ...ORG,
      verificationStatus: 'BUSINESS_VERIFIED',
    });

    const result = await service.revokeVerification('org_1', 'usr_admin', 'registration lapsed');

    expect(updated).toEqual([{ verificationStatus: 'BUSINESS_VERIFICATION_PENDING' }]);
    expect(result.changed).toBe(true);
    expect(audited[0]).toMatchObject({
      action: 'ORGANIZATION_VERIFICATION_REVOKED',
      actor: 'usr_admin',
      metadata: {
        from: 'BUSINESS_VERIFIED',
        to: 'BUSINESS_VERIFICATION_PENDING',
        reason: 'registration lapsed',
      },
    });
  });

  it('revokes from ACTIVE too, not only from BUSINESS_VERIFIED', async () => {
    // Every state that can submit or publish must be revocable, or an
    // organization becomes unstoppable by reaching ACTIVE.
    const { service, updated } = harness({ ...ORG, verificationStatus: 'ACTIVE' });

    await service.revokeVerification('org_1', 'usr_admin', 'under investigation');

    expect(updated).toEqual([{ verificationStatus: 'BUSINESS_VERIFICATION_PENDING' }]);
  });

  it('is a no-op on an organization that already cannot submit', async () => {
    const { service, updated, audited } = harness({ ...ORG });

    const result = await service.revokeVerification('org_1', 'usr_admin', 'no reason needed');

    expect(updated).toEqual([]);
    expect(audited).toEqual([]);
    expect(result.changed).toBe(false);
  });

  it('refuses an organization that does not exist', async () => {
    const { service } = harness(null);
    await expect(service.revokeVerification('missing', 'usr_admin', 'whatever')).rejects.toThrow(
      /not found/i,
    );
  });
});
