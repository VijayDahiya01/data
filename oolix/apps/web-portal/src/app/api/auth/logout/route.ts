/**
 * Sign out (§35).
 *
 * Ends the sign-in at the API, not only here: the refresh token is revoked,
 * so a copy of the cookie taken earlier cannot keep a session alive. The
 * access token already issued lapses within ten minutes on its own, and it
 * only ever lived in this server's sealed cookie.
 *
 * POST only. A GET sign-out can be triggered by any page that embeds an
 * image pointing here.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { clearSession, readSession } from '@/lib/session';
import { postAuth } from '@/lib/auth-api';

export async function POST(request: NextRequest) {
  const session = await readSession();
  await clearSession();

  if (session?.refreshToken) {
    try {
      const visitor = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || undefined;
      await postAuth('/v1/auth/logout', { refresh_token: session.refreshToken }, visitor);
    } catch {
      // Already signed out, or the API is unreachable. The cookie is gone
      // either way, and the refresh token dies with its sign-in's end.
    }
  }

  // 303 so the browser follows with a GET, not a replayed POST.
  return NextResponse.redirect(new URL('/login', request.url), 303);
}
