/**
 * Server-side Oolix API client (§53, §67, §77.2, §99).
 *
 * Every call to the control plane goes through here, on the server. The
 * browser never receives an access token, so a script injected into a portal
 * page cannot lift one and call the API as the user.
 *
 * Three rules this file exists to enforce:
 *
 *   * `X-Org-Id` always carries the ACTIVE organization (§34: a user who
 *     belongs to several switches without a second account). The API
 *     re-derives permissions from the database for that organization anyway
 *     (§4.2) -- this header only says which one the user means.
 *   * §77.2 errors are surfaced as `ApiError` with the canonical code intact,
 *     so a screen can distinguish "you cannot do this" from "that no longer
 *     exists" instead of showing one generic failure.
 *   * The visitor's address travels in X-Forwarded-For. The API budgets
 *     requests per address; without it, every visitor would share the
 *     portal's own address and one visitor could throttle everybody.
 *
 * Tokens are renewed in proxy.ts, before the page renders -- not here. A page
 * cannot set cookies while rendering, so a renewal attempted here could never
 * be kept.
 */
import 'server-only';
import { env } from './env';
import { readSession, type Session } from './session';
import { ApiError, readResponse } from './api-error';
import { visitorAddress } from './auth-api';

export { ApiError, type FieldError } from './api-error';

export interface ApiOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  /** §53: required on submit, approval and mark-paid. */
  idempotencyKey?: string;
  /** Override the active organization for this call. */
  orgId?: string;
  /** Next.js cache behaviour. Control-plane reads are not cached by default. */
  cache?: RequestCache;
  revalidate?: number;
}

/**
 * The session, if its access token is still good.
 *
 * Null when there is none, or when proxy.ts could not renew it -- which the
 * callers turn into a redirect to login rather than an error page.
 */
async function usableSession(): Promise<Session | null> {
  const session = await readSession();
  if (!session) return null;
  return session.expiresAt > Date.now() ? session : null;
}

export class NotAuthenticatedError extends Error {
  constructor() {
    super('No active portal session.');
    this.name = 'NotAuthenticatedError';
  }
}

export async function api<T>(path: string, options: ApiOptions = {}): Promise<T> {
  const session = await usableSession();
  if (!session) throw new NotAuthenticatedError();

  const orgId = options.orgId ?? session.activeOrgId;
  const visitor = await visitorAddress();

  const headers: Record<string, string> = {
    Authorization: `Bearer ${session.accessToken}`,
    Accept: 'application/json',
  };
  if (orgId) headers['X-Org-Id'] = orgId;
  if (visitor) headers['X-Forwarded-For'] = visitor;
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey;

  const res = await fetch(`${env().OOLIX_API_INTERNAL_URL}${path}`, {
    method: options.method ?? 'GET',
    headers,
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    // Control-plane state changes constantly and a stale approval queue is
    // worse than a slow one.
    cache: options.cache ?? 'no-store',
    ...(options.revalidate !== undefined ? { next: { revalidate: options.revalidate } } : {}),
  });

  return readResponse<T>(res);
}

/**
 * Like `api`, but returns null instead of throwing on 403/404.
 *
 * §66.2 deliberately makes "not found" and "not visible to you" the same
 * answer, so a screen that renders a section conditionally should not treat
 * either as an error.
 */
export async function apiOptional<T>(path: string, options: ApiOptions = {}): Promise<T | null> {
  try {
    return await api<T>(path, options);
  } catch (err) {
    if (err instanceof ApiError && (err.status === 403 || err.status === 404)) return null;
    throw err;
  }
}
