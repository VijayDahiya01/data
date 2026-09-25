/**
 * @oolix/contracts -- the single definition of every cross-layer constant.
 *
 * Oolix Cloud, the worker, the web portal, the Ad SDK and (via generated Go
 * constants) the Partner Agent all resolve their enums here. §89 is explicit
 * that channel strings must not drift between database, API, manifest, queue
 * and frontend; the same reasoning applies to roles, states and error codes,
 * so all of them live in one package rather than being retyped per service.
 */

export * from './channel.js';
export * from './roles.js';
export * from './states.js';
export * from './errors.js';
export * from './events.js';
export * from './reach.js';
export * from './money.js';
export * from './catalog.js';
// v6: Buyer-defined audiences, capability matching and reach estimates.
export * from './audience.js';

/** Contract version reported by /healthz and in the Agent handshake (§53). */
export const CONTRACT_VERSION = '0.2.0';

/** Canonical API surface bases (§67). */
export const API_BASES = {
  /** Oolix user-facing API. */
  user: '/v1',
  /** Oolix Agent-facing API. */
  agent: '/agent/v1',
  /** Partner Agent local API (served by the Agent, inside Partner infra). */
  agentPrivate: '/private/v1',
} as const;

/** §86 default pagination. */
export const PAGINATION = {
  defaultPageSize: 25,
  maxPageSize: 100,
} as const;

/** §86 rate limits, per rolling 60s window (§94). */
export const RATE_LIMITS = {
  userRead: 300,
  campaignWrite: 60,
  catalogueSearch: 120,
  agentControl: 120,
  agentReporting: 60,
  crmLeadEvents: 120,
  signup: 5,
  // Sign-in and account recovery, all counted per client IP because the
  // caller has not authenticated yet. Per-account lockout (10 failures) is the
  // second, independent limit on password guessing.
  login: 10,
  passwordReset: 5,
  emailVerification: 5,
  /** Consuming an emailed link: verify an address, reset, accept an invitation. */
  authLink: 10,
  /**
   * A coarse outer bound, per client IP, applied BEFORE authentication.
   *
   * The per-principal limits above are the real policy, but they cannot be
   * applied to a caller who has not authenticated yet -- and an unauthenticated
   * flood is precisely what wants limiting: credential stuffing against the
   * token endpoint, or simply exhausting the pool with 401s.
   *
   * Deliberately generous. It is a flood guard, not a quota, and it has to sit
   * well above what a legitimate office behind one NAT address would use.
   */
  anonymousIp: 600,
} as const;

export type RateLimitClass = keyof typeof RATE_LIMITS;
