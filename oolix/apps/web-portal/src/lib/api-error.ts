/**
 * The §77.2 error envelope as the portal sees it.
 *
 * Its own module so the signed-in API client (api.ts), the sign-in client
 * (auth-api.ts) and the request proxy can all use it without importing one
 * another.
 */

export interface FieldError {
  field: string;
  message: string;
}

export interface ErrorEnvelope {
  code?: string;
  message?: string;
  retryable?: boolean;
  field_errors?: FieldError[];
  correlation_id?: string;
  retry_after_seconds?: number;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;
  readonly fieldErrors: FieldError[];
  readonly correlationId?: string;
  readonly retryAfterSeconds?: number;

  constructor(status: number, body: ErrorEnvelope) {
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

/** Parse a response body, turning a non-2xx answer into an ApiError. */
export async function readResponse<T>(res: Response): Promise<T> {
  const text = await res.text();
  const parsed: unknown = text ? safeJson(text) : null;
  if (!res.ok) {
    const envelope = (parsed as { error?: ErrorEnvelope } | null)?.error;
    throw new ApiError(res.status, envelope ?? {});
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
