/**
 * Server-side Oolix API client (§53, §67, §77.2, §99).
 *
 * Every call to the control plane goes through here, on the server. The
 * browser never receives an access token, so a script injected into a portal
 * page cannot lift one and call the API as the user.
 *
 * Two rules this file exists to enforce:
 *
 *   * `X-Org-Id` always carries the ACTIVE organization (§34: a user who
 *     belongs to several switches without a second account). The API
 *     re-derives permissions from the database for that organization anyway
 *     (§4.2) -- this header only says which one the user means.
 *   * §77.2 errors are surfaced as `ApiError` with the canonical code intact,
 *     so a screen can distinguish "you cannot do this" from "that no longer
 *     exists" instead of showing one generic failure.
 */
import 'server-only';
import { env } from './env';
import { readSession, writeSession, type Session } from './session';
import { refresh } from './oidc';

export interface FieldError {
  field: string;
  message: string;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;
  readonly fieldErrors: FieldError[];
  readonly correlationId?: string;
  readonly retryAfterSeconds?: number;

  constructor(
    status: number,
    body: {
      code?: string;
      message?: string;
      retryable?: boolean;
      field_errors?: FieldError[];
      correlation_id?: string;
      retry_after_seconds?: number;
    },
  ) {
    super(body.message ?? `Request failed with status ${status}`);
    this.name = 'ApiError';
    this.status = status;
    this.code = body.code ?? 'SYS_002';
    this.retryable = body.retryable ?? false;
    this.fieldErrors = body.field_errors ?? [];
    if (body.correlation_id) this.correlationId = body.correlation_id;
    if (body.retry_after_seconds !== undefined) this.retryAfterSeconds = body.retry_after_seconds;
  }

  /** True when the session is the problem rather than the request. */
  get isAuthFailure(): boolean {
    return this.status === 401;
  }
}

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
 * A session whose access token is still valid, refreshing it if not.
 *
 * Returns null when there is no usable session, which the callers turn into a
 * redirect to login rather than an error page.
 */
async function usableSession(): Promise<Session | null> {
  const session = await readSession();
  if (!session) return null;
  if (session.expiresAt > Date.now()) return session;
  if (!session.refreshToken) return null;

  try {
    const tokens = await refresh(session.refreshToken);
    const next: Session = {
      ...session,
      accessToken: tokens.accessToken,
      expiresAt: tokens.expiresAt,
      ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}),
    };
    await writeSession(next);
    return next;
  } catch {
    // The refresh token has been revoked or the Keycloak session ended. Treat
    // it as logged out; the user signs in again.
    return null;
  }
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

  const headers: Record<string, string> = {
    Authorization: `Bearer ${session.accessToken}`,
    Accept: 'application/json',
  };
  if (orgId) headers['X-Org-Id'] = orgId;
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

  const text = await res.text();
  const parsed: unknown = text ? safeJson(text) : null;

  if (!res.ok) {
    const envelope = (parsed as { error?: Record<string, unknown> } | null)?.error;
    throw new ApiError(res.status, (envelope ?? {}) as ConstructorParameters<typeof ApiError>[1]);
  }

  return parsed as T;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // The API always returns JSON; anything else means a proxy or gateway
    // answered instead, and the raw body is more useful than a parse error.
    return { raw: text };
  }
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
