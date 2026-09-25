/**
 * Your account: change your password.
 *
 * Changing it signs out every other session -- on another laptop, a phone, a
 * browser someone else might still have open -- and this one carries on.
 */
import { redirect } from 'next/navigation';
import { requireContext } from '@/lib/nav-entry';
import { Shell } from '@/components/Shell';
import { Card, PageHeader } from '@/components/ui';
import { ChangePasswordForm } from '@/components/AuthForms';

export default async function AccountPage() {
  const ctx = await requireContext('/account');
  // The rail needs an organization to draw; someone without one belongs in setup.
  if (!ctx.active_organization) redirect('/organization/new');

  return (
    <Shell ctx={ctx}>
      <PageHeader title="Your account" lead={`Signed in as ${ctx.user.email}.`} />
      <Card title="Change password">
        <ChangePasswordForm />
      </Card>
    </Shell>
  );
}
