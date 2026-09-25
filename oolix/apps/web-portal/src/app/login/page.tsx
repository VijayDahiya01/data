/**
 * Sign in (§35.1).
 *
 * Oolix checks the password itself now (docs/SECURITY-REVIEW.md records the
 * decision to leave the external identity provider). The form posts to a
 * server action; the password goes to the API server-to-server and the
 * tokens that come back are sealed into an httpOnly cookie, so neither is
 * ever visible to a script on this page.
 */
import Link from 'next/link';
import { readSession } from '@/lib/session';
import { redirect } from 'next/navigation';
import { env } from '@/lib/env';
import { AuthPage } from '@/components/AuthPage';
import { SignInForm } from '@/components/AuthForms';

/**
 * Where seeded demo accounts exist, and therefore where naming them is safe.
 *
 * §95 refuses to seed anything beyond these, so in `dev`, `staging` or
 * `production` the credentials below would be both a disclosure and a lie —
 * they would not work.
 */
const DEMO_ENVIRONMENTS = new Set(['local', 'test']);

const MESSAGES: Record<string, { tone?: 'warn'; text: string }> = {
  session: { tone: 'warn', text: 'Your session ended. Please sign in again.' },
  verified: { text: 'Email address confirmed. You can sign in now.' },
  reset: {
    text: 'Password changed, and every other session signed out. Sign in with the new one.',
  },
  joined: { text: 'Invitation accepted. Sign in with your existing password.' },
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{
    error?: string;
    return_to?: string;
    verified?: string;
    reset?: string;
    joined?: string;
  }>;
}) {
  const params = await searchParams;
  const returnTo =
    params.return_to && params.return_to.startsWith('/') && !params.return_to.startsWith('//')
      ? params.return_to
      : '/';

  // Already signed in: carry on. Not when sent here BECAUSE the API refused
  // the session (`error`): the cookie would still look current, and sending
  // it back would loop until the access token's expiry. Signing in replaces it.
  const session = await readSession();
  if (session && session.expiresAt > Date.now() && !params.error) redirect(returnTo);

  const appEnv = env().APP_ENV;
  const key =
    params.error ??
    (params.verified ? 'verified' : params.reset ? 'reset' : params.joined ? 'joined' : undefined);
  const notice = key ? MESSAGES[key] : undefined;

  return (
    <AuthPage
      title="Oolix"
      lead="Privacy-safe partner media activation."
      notice={notice}
      footer={
        <>
          <Link href="/forgot-password">Forgot your password?</Link>
          {' · '}
          <Link href="/signup">Create an account</Link>
        </>
      }
    >
      <SignInForm returnTo={returnTo} />

      {/* Seeded accounts and their shared password, printed on the page.
          Harmless against a seeded database and indefensible against a real
          one, so it is gated on the environment rather than on remembering to
          take it out. `local` and `test` are the only environments where these
          accounts exist at all — §95 refuses to seed anything else. */}
      {DEMO_ENVIRONMENTS.has(appEnv) ? (
        <div className="notice" style={{ marginTop: '1.1rem' }}>
          <strong>Local development.</strong> Every seeded account uses the password{' '}
          <code>password</code>.
          <ul style={{ margin: '0.5rem 0 0', paddingLeft: '1.05rem' }}>
            <li>
              <code>demo@example.test</code> — one login, every persona. Switch between Buyer, Data
              Partner, Network and Oolix admin from the sidebar.
            </li>
            <li>
              <code>buyer.admin@example.test</code> — Buyer only
            </li>
            <li>
              <code>partner.approver@example.test</code> — approves Partner requests only
            </li>
          </ul>
        </div>
      ) : null}
    </AuthPage>
  );
}
