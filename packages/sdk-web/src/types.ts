/**
 * Web Ad SDK types -- spec v5 §68.
 *
 * §68 constrains this package sharply, and the types encode those limits:
 *
 *   "SDK contains rendering, timeout/fallback, visibility measurement hooks
 *    and click handling only. It contains no Partner customer targeting rules."
 *   "SDK sends no customer ID to Oolix. It calls the Partner's backend
 *    endpoint or an approved same-network gateway."
 *
 * Note what is absent: there is no user id, no segment id and no Oolix URL in
 * any type here. The SDK cannot leak an identifier it is never given, and
 * cannot reach Oolix because it is never told where Oolix is. The Partner
 * backend resolves the logged-in user server-side (§68.1 step 2).
 */

/** §77.1 NO_AD reasons, duplicated as a narrow type to keep the SDK dependency-free. */
export type NoAdReason =
  | 'NO_ELIGIBLE_CAMPAIGN'
  | 'USER_NOT_IN_SEGMENT'
  | 'CONSENT_NOT_ELIGIBLE'
  | 'FREQUENCY_CAPPED'
  | 'BUDGET_EXHAUSTED'
  | 'CAMPAIGN_NOT_ACTIVE'
  | 'PLACEMENT_DISABLED'
  | 'CATEGORY_BLOCKED'
  | 'CREATIVE_UNAVAILABLE'
  | 'CONTROL_SYNC_STALE'
  | 'SEGMENT_SOURCE_ERROR'
  | 'KILL_SWITCH_ACTIVE';

export type CreativeFormat = 'IMAGE' | 'NATIVE_CARD';

export interface AdCreative {
  creative_version_id: string;
  format: CreativeFormat;
  headline?: string | null;
  body?: string | null;
  cta?: string | null;
  asset_url?: string | null;
  width?: number | null;
  height?: number | null;
  legal_disclaimer?: string | null;
  /**
   * Already carries the opaque attribution token as a query parameter (§14).
   * The SDK treats it as an opaque string and never parses or logs it.
   */
  destination_url: string;
}

export interface AdShowDecision {
  decision: 'SHOW';
  activation_id: string;
  /**
   * v6 §12: which locally compiled audience selected this person.
   *
   * Absent on the §19 prebuilt-segment path, where no audience was compiled.
   * It is a build number, not a count and not an identifier — and it never
   * leaves the Partner, because the whole decision never does.
   */
  audience_materialization_version?: number;
  creative: AdCreative;
  cache_ttl_ms?: number;
}

export interface AdNoDecision {
  decision: 'NO_AD';
  reason: NoAdReason;
  retry_after_ms?: number;
}

export type AdDecision = AdShowDecision | AdNoDecision;

/** Error codes the SDK surfaces to the Partner's own error handler. */
export type SdkErrorCode = 'TIMEOUT' | 'NETWORK' | 'BAD_RESPONSE' | 'HTTP_ERROR' | 'ABORTED';

export interface SdkError {
  code: SdkErrorCode;
  message: string;
  status?: number;
}

export interface DecisionRequestContext {
  /** Safe contextual tags only, e.g. page_type or locale (§12, §44). */
  [key: string]: string | number | boolean | undefined;
}

export interface RequestDecisionOptions {
  /** Partner backend endpoint. NOT an Oolix URL (§68). */
  decisionEndpoint: string;
  placementId: string;
  context?: DecisionRequestContext;
  /** §68 / §103: hard timeout before fallback. Default 150 ms. */
  requestTimeoutMs?: number;
  /** Forwarded verbatim so the Partner can carry its own session cookie. */
  fetchOptions?: RequestInit;
  signal?: AbortSignal;
}
