/**
 * Canonical error registry and NO_AD reasons -- spec v5 §77, §99.
 *
 * Every HTTP error the platform returns uses this envelope. §53 requires a
 * structured code, a human message, an explicit retryable flag, field errors
 * and the correlation_id. §99 forbids leaking stack traces or secrets.
 */
import { z } from 'zod';

// --------------------------------------------------------------------------
// §77.1 NO_AD reason enum
//
// Returned by the Partner Agent to the Partner backend. These are diagnostic
// buckets for the Partner and for Oolix aggregate dashboards (§98.1). They
// describe a DECISION, never a person -- no reason here identifies a user.
// --------------------------------------------------------------------------
export const NO_AD_REASONS = [
  'NO_ELIGIBLE_CAMPAIGN',
  'USER_NOT_IN_SEGMENT',
  'CONSENT_NOT_ELIGIBLE',
  'FREQUENCY_CAPPED',
  'BUDGET_EXHAUSTED',
  'CAMPAIGN_NOT_ACTIVE',
  'PLACEMENT_DISABLED',
  'CATEGORY_BLOCKED',
  'CREATIVE_UNAVAILABLE',
  'CONTROL_SYNC_STALE',
  'SEGMENT_SOURCE_ERROR',
  'KILL_SWITCH_ACTIVE',
] as const;

export type NoAdReason = (typeof NO_AD_REASONS)[number];
export const NoAdReasonSchema = z.enum(NO_AD_REASONS);

// --------------------------------------------------------------------------
// §77.2 API error registry
// --------------------------------------------------------------------------
export const ERROR_CODES = {
  AUTH_001: { http: 401, message: 'Invalid or expired user or workload token.', retryable: false },
  PERM_001: { http: 403, message: 'Permission denied.', retryable: false },
  PERM_002: { http: 403, message: 'Organization or network access denied.', retryable: false },
  VAL_001: { http: 400, message: 'Validation error.', retryable: false },
  CAMP_001: { http: 404, message: 'Campaign not found.', retryable: false },
  CAMP_002: { http: 409, message: 'Invalid state transition.', retryable: false },
  CAMP_003: { http: 409, message: 'Budget allocation exceeded.', retryable: false },
  PART_001: { http: 404, message: 'Partner, segment or placement not found.', retryable: false },
  PART_002: {
    http: 409,
    message: 'Segment unavailable, stale or not publishable.',
    retryable: false,
  },
  CHAN_001: { http: 409, message: 'External channel not eligible.', retryable: false },
  CHAN_002: {
    http: 502,
    message: 'External channel configuration or provider error.',
    retryable: true,
  },
  AGENT_001: { http: 503, message: 'Partner Agent offline or stale.', retryable: true },
  SYS_001: { http: 429, message: 'Rate limit exceeded.', retryable: true },
  SYS_002: { http: 503, message: 'Service unavailable.', retryable: true },
  // §99: same Idempotency-Key replayed with a different payload.
  IDEMPOTENCY_CONFLICT: {
    http: 409,
    message: 'Idempotency key reused with a different payload.',
    retryable: false,
  },
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;
export const ERROR_CODE_VALUES = Object.keys(ERROR_CODES) as ErrorCode[];
export const ErrorCodeSchema = z.enum(ERROR_CODE_VALUES as [ErrorCode, ...ErrorCode[]]);

export interface FieldError {
  field: string;
  message: string;
}

export interface OolixErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    retryable: boolean;
    correlation_id: string;
    field_errors: FieldError[];
    /** Present only on SYS_001 (§94). */
    retry_after_seconds?: number;
  };
}

export function httpStatusFor(code: ErrorCode): number {
  return ERROR_CODES[code].http;
}

export function isRetryable(code: ErrorCode): boolean {
  return ERROR_CODES[code].retryable;
}

/**
 * Build the canonical error envelope (§53, §99).
 *
 * `message` may be overridden to add context, but it must never contain PII,
 * a raw click token, a partner_user_id, or provider credentials (§78.1).
 */
export function buildError(
  code: ErrorCode,
  correlationId: string,
  opts: { message?: string; fieldErrors?: FieldError[]; retryAfterSeconds?: number } = {},
): OolixErrorBody {
  const spec = ERROR_CODES[code];
  const body: OolixErrorBody = {
    error: {
      code,
      message: opts.message ?? spec.message,
      retryable: spec.retryable,
      correlation_id: correlationId,
      field_errors: opts.fieldErrors ?? [],
    },
  };
  if (opts.retryAfterSeconds !== undefined) {
    body.error.retry_after_seconds = opts.retryAfterSeconds;
  }
  return body;
}

/**
 * Domain error carrying a canonical code. The HTTP layer turns this into the
 * envelope above; nothing else in the codebase should hand-roll error shapes.
 */
export class OolixError extends Error {
  readonly code: ErrorCode;
  readonly fieldErrors: FieldError[];
  readonly retryAfterSeconds?: number;

  constructor(
    code: ErrorCode,
    message?: string,
    opts: { fieldErrors?: FieldError[]; retryAfterSeconds?: number; cause?: unknown } = {},
  ) {
    super(message ?? ERROR_CODES[code].message, { cause: opts.cause });
    this.name = 'OolixError';
    this.code = code;
    this.fieldErrors = opts.fieldErrors ?? [];
    if (opts.retryAfterSeconds !== undefined) this.retryAfterSeconds = opts.retryAfterSeconds;
  }

  get httpStatus(): number {
    return httpStatusFor(this.code);
  }

  get retryable(): boolean {
    return isRetryable(this.code);
  }
}
