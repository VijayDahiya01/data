/**
 * Start the OIDC login (§35, §64).
 *
 * The PKCE verifier and state are stashed in short-lived httpOnly cookies
 * rather than in server memory, so a login still completes if the redirect
 * comes back to a different instance behind a load balancer.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { beginLogin } from '@/lib/oidc';
import { env } from '@/lib/env';

export async function GET(request: NextRequest) {
  const { authorizationUrl, codeVerifier, state } = await beginLogin();

  // Where to land afterwards. Restricted to a path on this origin: an absolute
  // URL here would make the portal an open redirector.
  const requested = request.nextUrl.searchParams.get('return_to') ?? '/';
  const returnTo = requested.startsWith('/') && !requested.startsWith('//') ? requested : '/';

  const res = NextResponse.redirect(authorizationUrl);
  const options = {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: env().WEB_PUBLIC_URL.startsWith('https://'),
    path: '/',
    maxAge: 600,
  };
  res.cookies.set('oolix_pkce', codeVerifier, options);
  res.cookies.set('oolix_state', state, options);
  res.cookies.set('oolix_return_to', returnTo, options);
  return res;
}
