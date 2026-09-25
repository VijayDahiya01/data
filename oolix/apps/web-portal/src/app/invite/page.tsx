/**
 * Accept an invitation from the link in the email (§35.3). The token is in
 * the URL, so the page sends no Referer anywhere.
 */
import Link from 'next/link';
import { AuthPage } from '@/components/AuthPage';
import { AcceptInvitationForm } from '@/components/AuthForms';

export const metadata = {
  title: 'Accept your invitation — Oolix',
  referrer: 'no-referrer' as const,
};

export default async function InvitePage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;
  return (
    <AuthPage
      title="Join your team on Oolix"
      lead="Choose a password, and you are in."
      footer={<Link href="/login">Already set up? Sign in</Link>}
    >
      {token ? (
        <AcceptInvitationForm token={token} />
      ) : (
        <p style={{ margin: 0 }}>
          This page needs the link from your invitation email. Ask whoever invited you to send it
          again.
        </p>
      )}
    </AuthPage>
  );
}
