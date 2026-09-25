/**
 * Calls to the API's sign-in routes (/v1/auth/*), made by this server.
 *
 * These are the only unauthenticated calls the portal makes. Like every other
 * call they go server-to-server, so tokens still never reach the browser.
 *
 * Every call forwards the visitor's address in X-Forwarded-For. The API counts
 * sign-in attempts per address; without the header every visitor would arrive
 * from the portal's own address and share one budget -- ten sign-ins a minute
 * for the entire user base. The address comes from the header the TLS
 * terminator (Caddy) sets, which replaces whatever a client sent.
 */
import 'server-only';
import { headers } from 'next/headers';
import { env } from './env';
import { readResponse } from './api-error';
import type { Session } from './session';

export interface TokenPair {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  refresh_token: string;
  session_expires_at: string;
}

/** The visitor's own address, as the TLS terminator reported it. */
export async function visitorAddress(): Promise<string | undefined> {
  try {
    const h = await headers();
    return h.get('x-forwarded-for')?.split(',')[0]?.trim() || h.get('x-real-ip') || undefined;
  } catch {
    // Outside a request (a build step, a test): there is no visitor.
    return undefined;
  }
}

export async function postAuth<T>(path: string, body: unknown, forwardedFor?: string): Promise<T> {
  const res = await fetch(`${env().OOLIX_API_INTERNAL_URL}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(forwardedFor ? { 'X-Forwarded-For': forwardedFor } : {}),
    },
    body: JSON.stringify(body),
    cache: 'no-store',
  });
  return readResponse<T>(res);
}

export function refreshTokens(refreshToken: string, forwardedFor?: string): Promise<TokenPair> {
  return postAuth<TokenPair>('/v1/auth/refresh', { refresh_token: refreshToken }, forwardedFor);
}

/**
 * The session to store for a fresh token pair, keeping the organization the
 * person was working in. Expiry is brought forward 30 seconds so a call that
 * starts just before it never arrives just after it.
 */
export function sessionFromTokens(tokens: TokenPair, previous?: Partial<Session>): Session {
  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt: Date.now() + tokens.expires_in * 1000 - 30_000,
    ...(previous?.email ? { email: previous.email } : {}),
    ...(previous?.activeOrgId ? { activeOrgId: previous.activeOrgId } : {}),
  };
}
