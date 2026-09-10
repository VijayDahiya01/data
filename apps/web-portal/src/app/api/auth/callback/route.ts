/**
 * Complete the OIDC login (§35, §82).
 *
 * The code exchange happens here, on the server, with the client secret. The
 * browser sees a redirect and a sealed cookie — never a token.
 *
 * The session cookie is set on the response object directly rather than
 * through `cookies()`. Both work, but this one is unambiguous about ordering:
 * the cookie is part of the same redirect that sends the user onward, so the
 * very next request already carries it.
 *
 * No organization is chosen here. `/v1/me/context` resolves a sensible default
 * when no `X-Org-Id` is sent, and the switcher (§34) overrides it — so there is
 * no need to read the session back before it has been delivered.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { completeLogin } from '@/lib/oidc';
import { seal, SESSION_COOKIE, type Session } from '@/lib/session';
import { env } from '@/lib/env';

export async function GET(request: NextRequest) {
  const codeVerifier = request.cookies.get('oolix_pkce')?.value;
  const state = request.cookies.get('oolix_state')?.value;
  const returnTo = request.cookies.get('oolix_return_to')?.value ?? '/';

  if (!codeVerifier || !state) {
    // No challenge cookies means this is a stale or forged callback. Start over
    // rather than attempting an exchange that cannot be verified.
    return NextResponse.redirect(new URL('/login?error=expired', request.url));
  }

  let session: Session;
  try {
    // `new URL(request.url)`, not `request.nextUrl`: the latter is Next's own
    // NextURL subclass, which openid-client rejects as not being a URL.
    const tokens = await completeLogin(new URL(request.url), { codeVerifier, state });
    session = {
      accessToken: tokens.accessToken,
      expiresAt: tokens.expiresAt,
      subject: tokens.subject,
      ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}),
      ...(tokens.email ? { email: tokens.email } : {}),
    };
  } catch (err) {
    // Includes a state mismatch, which is the CSRF check doing its job.
    //
    // Logged server-side only. §99 forbids showing the user an internal reason,
    // but swallowing it entirely makes a misconfigured issuer impossible to
    // diagnose — the operator sees "sign-in failed" and nothing else.
    console.error('[oolix-portal] OIDC code exchange failed:', {
      name: err instanceof Error ? err.name : 'unknown',
      message: err instanceof Error ? err.message : String(err),
      code: (err as { code?: string })?.code,
      cause: (err as { cause?: unknown })?.cause,
    });
    return NextResponse.redirect(new URL('/login?error=exchange', request.url));
  }

  const res = NextResponse.redirect(new URL(returnTo, request.url));

  res.cookies.set(SESSION_COOKIE, seal(session), {
    httpOnly: true,
    sameSite: 'lax',
    secure: env().WEB_PUBLIC_URL.startsWith('https://'),
    path: '/',
    maxAge: 60 * 60 * 8,
  });

  res.cookies.delete('oolix_pkce');
  res.cookies.delete('oolix_state');
  res.cookies.delete('oolix_return_to');
  return res;
}
