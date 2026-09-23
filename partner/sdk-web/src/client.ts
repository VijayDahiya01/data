/**
 * Framework-free decision client -- spec v5 §68.
 *
 * The governing requirement is §9.2 / §43:
 *
 *   "All ad code must fail independently from the core customer journey."
 *   "Ad placement failure cannot block checkout/booking/login."
 *
 * So every failure path here resolves to NO_AD rather than rejecting. A
 * Partner integrating this cannot accidentally take their booking flow down by
 * forgetting a try/catch.
 */
import type {
  AdDecision,
  NoAdReason,
  RequestDecisionOptions,
  SdkError,
  SdkErrorCode,
} from './types.js';

/** §68 / §103: hard decision timeout before fallback. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 150;

export interface DecisionResult {
  decision: AdDecision;
  /**
   * Present when this NO_AD came from a local failure (timeout, network, bad
   * response) rather than from an actual Agent decision.
   */
  error?: SdkError;
  /** Wall-clock time the Partner backend call took, for the Partner's own RUM. */
  durationMs: number;
}

/**
 * Build a NO_AD result for a failure the SDK itself detected.
 *
 * The reason is always NO_ELIGIBLE_CAMPAIGN because §77.1's enum is the
 * Partner AGENT's vocabulary and the SDK must not invent values outside it.
 * Callers distinguish "the Agent decided not to serve" from "we never reached
 * the Agent" by the presence of `error`, not by the reason code.
 */
function noAd(reason: NoAdReason, started: number, error?: SdkError): DecisionResult {
  return {
    decision: { decision: 'NO_AD', reason },
    ...(error ? { error } : {}),
    durationMs: Math.round(performance.now() - started),
  };
}

function isAdDecision(value: unknown): value is AdDecision {
  if (typeof value !== 'object' || value === null) return false;
  const d = (value as { decision?: unknown }).decision;
  if (d === 'NO_AD') return true;
  if (d !== 'SHOW') return false;
  const c = (value as { creative?: unknown }).creative;
  return (
    typeof c === 'object' &&
    c !== null &&
    typeof (c as { destination_url?: unknown }).destination_url === 'string'
  );
}

/**
 * Ask the Partner backend for a decision.
 *
 * Never rejects. On timeout, network failure, HTTP error or an unparseable
 * body it resolves NO_AD with a diagnostic `error`, so the caller renders
 * fallback content and the host page continues unaffected.
 */
export async function requestDecision(opts: RequestDecisionOptions): Promise<DecisionResult> {
  const started = performance.now();
  const timeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);

  // Honour a caller-supplied signal (React unmount) alongside our timeout.
  const onExternalAbort = () => controller.abort(new Error('aborted'));
  opts.signal?.addEventListener('abort', onExternalAbort, { once: true });

  try {
    const res = await fetch(opts.decisionEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // The Partner backend identifies the user from its OWN session; the SDK
      // must therefore send credentials but never a user identifier (§68.1).
      credentials: 'same-origin',
      body: JSON.stringify({
        placement_id: opts.placementId,
        context: opts.context ?? {},
      }),
      signal: controller.signal,
      ...opts.fetchOptions,
    });

    if (!res.ok) {
      return noAd('NO_ELIGIBLE_CAMPAIGN', started, {
        code: 'HTTP_ERROR',
        message: `Partner backend returned ${res.status}`,
        status: res.status,
      });
    }

    const body: unknown = await res.json();
    if (!isAdDecision(body)) {
      return noAd('NO_ELIGIBLE_CAMPAIGN', started, {
        code: 'BAD_RESPONSE',
        message: 'Decision payload did not match the expected shape.',
      });
    }

    return { decision: body, durationMs: Math.round(performance.now() - started) };
  } catch (err) {
    const aborted = err instanceof Error && err.name === 'AbortError';
    const external = opts.signal?.aborted === true;
    const code: SdkErrorCode = aborted ? (external ? 'ABORTED' : 'TIMEOUT') : 'NETWORK';
    return noAd('NO_ELIGIBLE_CAMPAIGN', started, {
      code,
      message: err instanceof Error ? err.message : 'Unknown network failure',
    });
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onExternalAbort);
  }
}

/**
 * Report an impression or click back to the Partner backend.
 *
 * Uses `sendBeacon` where available so a click that navigates away still
 * records. Fire-and-forget by design: a failed beacon must never delay
 * navigation to the Buyer's landing page.
 */
export function reportEvent(
  endpoint: string,
  payload: { event: 'impression' | 'click'; activation_id: string; placement_id: string },
): void {
  try {
    const body = JSON.stringify(payload);
    if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
      navigator.sendBeacon(endpoint, new Blob([body], { type: 'application/json' }));
      return;
    }
    void fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body,
      keepalive: true,
    }).catch(() => {
      /* deliberately ignored: telemetry must never affect the host page */
    });
  } catch {
    /* deliberately ignored */
  }
}
