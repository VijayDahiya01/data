/**
 * Keeps the signed-in session fresh, before any page renders.
 *
 * Access tokens last ten minutes. Renewing one means writing a new session
 * cookie, and Next.js refuses to set cookies while a page is rendering -- so
 * the API client used to try, fail, swallow the error and treat the person as
 * signed out. Proxy runs before rendering and may set cookies, so renewal
 * lives here: when the access token is within a minute of expiring, it is
 * exchanged for a new pair and the cookie is rewritten.
 *
 * The fresh cookie goes two ways: onto the response, for the browser to keep,
 * and onto THIS request's headers, so the page rendering right now uses the
 * new token instead of the one that just expired.
 *
 * This is session upkeep, not access control. Every API call is authorized by
 * the API itself; a request this proxy lets through with no session simply
 * meets a redirect to /login from the page.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { SESSION_COOKIE, seal, sessionCookieOptions, unseal } from '@/lib/session';
import { refreshTokens, sessionFromTokens } from '@/lib/auth-api';
import { ApiError } from '@/lib/api-error';

/** Renew this long before expiry, so a page never starts with a dying token. */
const RENEW_AHEAD_MS = 60_000;

export async function proxy(request: NextRequest) {
  const raw = request.cookies.get(SESSION_COOKIE)?.value;
  if (!raw) return NextResponse.next();

  const session = unseal(raw);
  if (!session?.refreshToken) return NextResponse.next();
  if (session.expiresAt - Date.now() > RENEW_AHEAD_MS) return NextResponse.next();

  const visitor = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || undefined;
  try {
    const renewed = seal(
      sessionFromTokens(await refreshTokens(session.refreshToken, visitor), session),
    );

    request.cookies.set(SESSION_COOKIE, renewed);
    const headers = new Headers(request.headers);
    headers.set('cookie', request.cookies.toString());

    const response = NextResponse.next({ request: { headers } });
    response.cookies.set(SESSION_COOKIE, renewed, sessionCookieOptions());
    return response;
  } catch (err) {
    // The API refused: the sign-in ended, was signed out elsewhere, or the
    // token was copied. Drop the cookie; the page sends them to /login.
    if (err instanceof ApiError && err.status < 500) {
      const response = NextResponse.next();
      response.cookies.delete(SESSION_COOKIE);
      return response;
    }
    // The API is unreachable. Leave the session alone and let the page deal
    // with it -- a blip must not sign everybody out.
    return NextResponse.next();
  }
}

export const config = {
  // Everything except static assets, which carry no session worth renewing.
  // Server actions are POSTs to page routes, so they are covered too.
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
