/**
 * Choose a new password from the link in a reset email. The token is in the
 * URL, so the page sends no Referer anywhere.
 */
import Link from 'next/link';
import { AuthPage } from '@/components/AuthPage';
import { ResetPasswordForm } from '@/components/AuthForms';

export const metadata = {
  title: 'Choose a new password — Oolix',
  referrer: 'no-referrer' as const,
};

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;
  return (
    <AuthPage
      title="Choose a new password"
      lead="Every other signed-in session will be signed out."
      footer={<Link href="/forgot-password">Need a new link?</Link>}
    >
      {token ? (
        <ResetPasswordForm token={token} />
      ) : (
        <p style={{ margin: 0 }}>
          This page needs the link from your reset email.{' '}
          <Link href="/forgot-password">Ask for a new one</Link>.
        </p>
      )}
    </AuthPage>
  );
}
