/**
 * Login (§35.1).
 *
 * §64 delegates identity to the OIDC provider, so there is no password field
 * here and Oolix never sees one. The button starts the authorization-code flow;
 * the exchange happens server-side (see /api/auth/callback).
 */
import { readSession } from '@/lib/session';
import { redirect } from 'next/navigation';
import { env } from '@/lib/env';

/**
 * Where seeded demo accounts exist, and therefore where naming them is safe.
 *
 * §95 refuses to seed anything beyond these, so in `dev`, `staging` or
 * `production` the credentials below would be both a disclosure and a lie —
 * they would not work.
 */
const DEMO_ENVIRONMENTS = new Set(['local', 'test']);

const MESSAGES: Record<string, string> = {
  expired: 'That sign-in attempt timed out. Please try again.',
  exchange: 'Sign-in could not be completed. Please try again.',
  session: 'Your session ended. Please sign in again.',
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; return_to?: string }>;
}) {
  const params = await searchParams;
  const session = await readSession();
  if (session && session.expiresAt > Date.now()) redirect(params.return_to ?? '/');

  const returnTo = params.return_to && params.return_to.startsWith('/') ? params.return_to : '/';
  const appEnv = env().APP_ENV;
  const href = `/api/auth/login?return_to=${encodeURIComponent(returnTo)}`;
  const message = params.error ? MESSAGES[params.error] : undefined;

  return (
    <main className="login">
      <div className="brand-mark" aria-hidden="true">
        OX
      </div>
      <h1>Oolix</h1>
      <p className="muted">Privacy-safe partner media activation.</p>

      {message ? <div className="notice notice-warn">{message}</div> : null}

      <div className="card" style={{ marginTop: '1.25rem' }}>
        <p style={{ marginTop: 0 }}>
          Sign in with your organization account. Your own identity provider handles sign-in — Oolix
          never sees your password.
        </p>
        <a className="btn btn-primary" href={href} style={{ width: '100%', textAlign: 'center' }}>
          Continue to sign in
        </a>
      </div>

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
    </main>
  );
}
