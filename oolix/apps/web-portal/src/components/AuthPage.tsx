/**
 * The frame every signed-out page shares: sign-in, sign-up and the pages an
 * email link opens. Same look as the login page has always had.
 */
import type { ReactNode } from 'react';

export function AuthPage({
  title,
  lead,
  notice,
  children,
  footer,
}: {
  title: string;
  lead?: string;
  notice?: { tone?: 'warn' | 'ok'; text: string } | undefined;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <main className="login">
      <div className="brand-mark" aria-hidden="true">
        OX
      </div>
      <h1>{title}</h1>
      {lead ? <p className="muted">{lead}</p> : null}

      {notice ? (
        <div
          className={notice.tone === 'warn' ? 'notice notice-warn' : 'notice'}
          role="status"
          style={{ marginTop: '1rem' }}
        >
          {notice.text}
        </div>
      ) : null}

      <div className="card" style={{ marginTop: '1.25rem' }}>
        {children}
      </div>

      {footer ? (
        <p className="muted" style={{ marginTop: '1rem', textAlign: 'center' }}>
          {footer}
        </p>
      ) : null}
    </main>
  );
}
