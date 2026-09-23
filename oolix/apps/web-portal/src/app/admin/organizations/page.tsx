/**
 * Platform organization administration (§34, §35.2, §66, §98.1).
 *
 * An organization is created at BUSINESS_VERIFICATION_PENDING, and §66.3 lets
 * it browse and draft but not submit or publish. This screen is what moves it
 * on. Until it existed nothing in the running system could: the only writer of
 * BUSINESS_VERIFIED was the development seed, which refuses to run against
 * production, so a real deployment could onboard an organization and then
 * refuse everything it tried to do.
 *
 * §66's limit is unchanged and deliberately visible here: running the platform
 * never includes approving on a Data Partner's behalf, or reaching their data.
 * Nothing on this page exposes a member, a customer, or a count of either
 * beyond how many people belong to an organization.
 */
import { requireContext } from '@/lib/nav-entry';
import { apiOptional } from '@/lib/api';
import { Shell } from '@/components/Shell';
import { OrganizationVerification } from '@/components/OrganizationVerification';
import { Card, Empty, Notice, PageHeader, StatusBadge, dateOnly } from '@/components/ui';

interface OrganizationRow {
  organization_id: string;
  name: string;
  domain: string;
  type: string;
  country: string;
  verification_status: string;
  created_at: string;
  member_count: number;
  can_submit_or_publish: boolean;
}

export default async function Page() {
  const ctx = await requireContext('/admin/organizations');

  const data = await apiOptional<{ organizations: OrganizationRow[] }>('/v1/admin/organizations');
  const organizations = data?.organizations ?? [];

  // §66.3 is what the operator is actually deciding, so lead with the ones
  // waiting on a decision rather than making them scan for the difference.
  const waiting = organizations.filter((o) => !o.can_submit_or_publish);
  const active = organizations.filter((o) => o.can_submit_or_publish);

  return (
    <Shell ctx={ctx}>
      <PageHeader
        title="Organizations"
        lead="Every organization on the platform, and its verification state."
      />

      {data === null ? (
        <Notice tone="warn">
          The organization list could not be loaded. This screen needs
          <code> admin:operate</code>, which only an Oolix administrator holds.
        </Notice>
      ) : null}

      <Card title={`Waiting on verification (${waiting.length})`}>
        {waiting.length === 0 ? (
          <Empty>Nothing is waiting. Every organization can submit and publish.</Empty>
        ) : (
          <>
            <p className="faint">
              Until an organization is verified it can prepare work but cannot submit a campaign or
              publish supply (§66.3).
            </p>
            <OrganizationTable rows={waiting} />
          </>
        )}
      </Card>

      <Card title={`Verified (${active.length})`}>
        {active.length === 0 ? (
          <Empty>No organization has been verified yet.</Empty>
        ) : (
          <OrganizationTable rows={active} />
        )}
      </Card>
    </Shell>
  );
}

function OrganizationTable({ rows }: { rows: OrganizationRow[] }) {
  return (
    <table>
      <thead>
        <tr>
          <th>Organization</th>
          <th>Type</th>
          <th>State</th>
          <th>People</th>
          <th>Created</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {rows.map((org) => (
          <tr key={org.organization_id}>
            <td>
              <strong>{org.name}</strong>
              <div className="faint">
                {org.domain} · {org.country}
              </div>
            </td>
            <td>{org.type.replaceAll('_', ' ').toLowerCase()}</td>
            <td>
              <StatusBadge status={org.verification_status} />
            </td>
            <td>{org.member_count}</td>
            <td>{dateOnly(org.created_at)}</td>
            <td>
              <OrganizationVerification
                orgId={org.organization_id}
                canSubmitOrPublish={org.can_submit_or_publish}
              />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
