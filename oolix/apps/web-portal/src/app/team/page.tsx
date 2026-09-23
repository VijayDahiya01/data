/**
 * Team and roles (§35.3, §66).
 *
 * §66 splits these roles deliberately, and §66.2 goes further: the user who
 * created a Partner request may not approve it, even inside one organization
 * and even holding both roles. Showing who holds what makes that separation
 * visible rather than a surprise at the moment somebody is refused.
 */
import { requireContext, can } from '@/lib/nav-entry';
import { apiOptional } from '@/lib/api';
import { Shell } from '@/components/Shell';
import { Card, Empty, Notice, PageHeader, StatusBadge } from '@/components/ui';
import { InviteMemberForm, RemoveMemberForm } from '@/components/OpsForms';

interface Member {
  user_id: string;
  name: string;
  email: string;
  roles: string[];
  status: string;
}

export default async function TeamPage() {
  const ctx = await requireContext('/team');
  const data = await apiOptional<{ items: Member[] }>('/v1/organizations/members');
  const members = data?.items ?? [];

  const mayManage = can(ctx, 'org:member:manage');

  return (
    <Shell ctx={ctx}>
      <PageHeader
        title="Team"
        lead={`Who can act for ${ctx.active_organization?.name ?? 'this organization'}, and in what way.`}
      />

      <Card title={`Members (${members.length})`}>
        {members.length === 0 ? (
          <Empty>No members listed.</Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Email</th>
                  <th>Roles</th>
                  <th>Status</th>
                  {mayManage ? <th /> : null}
                </tr>
              </thead>
              <tbody>
                {members.map((m) => (
                  <tr key={m.user_id}>
                    <td>{m.name}</td>
                    <td className="muted">{m.email}</td>
                    <td>
                      <div style={{ display: 'flex', gap: '0.25rem', flexWrap: 'wrap' }}>
                        {(m.roles ?? []).map((r) => (
                          <span className="badge" key={r}>
                            {r.replaceAll('_', ' ').toLowerCase()}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td>
                      <StatusBadge status={m.status} />
                    </td>
                    {mayManage ? (
                      <td>
                        {m.user_id === ctx.user.id ? (
                          <span className="faint">you</span>
                        ) : (
                          <RemoveMemberForm userId={m.user_id} name={m.name} />
                        )}
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {mayManage ? (
        <Card title="Invite someone">
          <InviteMemberForm />
        </Card>
      ) : (
        <Notice tone="warn">Your role can see the team but not change it.</Notice>
      )}

      <Notice tone="plain">
        Roles are separated on purpose. The person who registers an Agent is not automatically the
        person who accepts commercial terms, and the person who creates a campaign request cannot
        approve it — separation of duties is enforced per action, not per account.
      </Notice>
    </Shell>
  );
}
