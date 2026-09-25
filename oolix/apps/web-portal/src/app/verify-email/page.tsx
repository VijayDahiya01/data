/**
 * Confirm an email address from the link in the sign-up email.
 *
 * The token rides in the URL, so this page sends no Referer anywhere, and it
 * is spent only by the button -- see ConfirmEmailForm for why opening the link
 * alone must not confirm anything.
 */
import Link from 'next/link';
import { AuthPage } from '@/components/AuthPage';
import { ConfirmEmailForm } from '@/components/AuthForms';

export const metadata = { title: 'Confirm your email — Oolix', referrer: 'no-referrer' as const };

export default async function VerifyEmailPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;
  return (
    <AuthPage title="Confirm your email" footer={<Link href="/login">Back to sign in</Link>}>
      {token ? (
        <ConfirmEmailForm token={token} />
      ) : (
        <p style={{ margin: 0 }}>
          This page needs the link from your email. Open the email again and use its button.
        </p>
      )}
    </AuthPage>
  );
}
