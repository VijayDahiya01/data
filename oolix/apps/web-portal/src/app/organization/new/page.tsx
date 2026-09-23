/**
 * Create an organization (§35.2).
 *
 * Reached by a signed-in user who does not belong to an organization yet —
 * §35.2 treats that as a normal state, not an error. §66.3 then allows
 * browsing and drafting while verification is pending, but not submitting a
 * campaign or publishing supply.
 */
import { requireContext } from '@/lib/nav-entry';
import { redirect } from 'next/navigation';
import { Card, Notice, PageHeader } from '@/components/ui';
import { OrganizationForm } from '@/components/OrganizationForm';

export default async function NewOrganizationPage() {
  const ctx = await requireContext('/organization/new');

  // Someone who already belongs somewhere does not need this screen.
  if (ctx.active_organization) redirect('/');

  return (
    <main className="content" style={{ margin: '0 auto' }}>
      <PageHeader
        title="Create your organization"
        lead={`Signed in as ${ctx.user.email}. One more step before you can do anything useful.`}
      />

      <Card>
        <OrganizationForm />
      </Card>

      <Notice tone="plain">
        You can browse and draft straight away. Submitting a campaign, or publishing an audience as
        a Data Partner, waits until business verification completes.
      </Notice>
    </main>
  );
}
