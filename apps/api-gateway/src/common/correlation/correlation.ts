/**
 * Correlation ID propagation -- spec v5 §53, §78, §99.
 *
 * §99: "Correlation ID is generated at the edge when missing and propagated
 * through API -> queue -> worker -> Agent -> external adapter."
 *
 * AsyncLocalStorage carries it implicitly so that deep code -- a Prisma hook,
 * an audit write, a queue publish -- can attach it without every function
 * signature growing a parameter it does not otherwise care about.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { isValidCorrelationId, newCorrelationId } from '@oolix/observability';

export interface RequestContext {
  correlationId: string;
  /** Populated by the auth guard once the principal is known. */
  orgId?: string;
  userId?: string;
  agentId?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

export const CORRELATION_HEADER = 'x-correlation-id';

export function runWithContext<T>(ctx: RequestContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

export function currentContext(): RequestContext | undefined {
  return storage.getStore();
}

/**
 * The correlation ID for the current request, or a fresh one outside a request
 * (scheduled jobs, queue consumers). Never returns undefined -- an unlabelled
 * log line is worse than a synthetic label.
 */
export function currentCorrelationId(): string {
  return storage.getStore()?.correlationId ?? newCorrelationId();
}

/** Attach identity to the active context once authentication has run. */
export function enrichContext(patch: Partial<RequestContext>): void {
  const ctx = storage.getStore();
  if (ctx) Object.assign(ctx, patch);
}

/**
 * Accept an inbound correlation ID only if it is well-formed.
 *
 * A caller-supplied value is echoed into logs, so an unvalidated one is a log
 * injection vector (newlines, control characters, unbounded length).
 */
export function resolveCorrelationId(headerValue: unknown): string {
  if (Array.isArray(headerValue)) headerValue = headerValue[0];
  return isValidCorrelationId(headerValue) ? headerValue : newCorrelationId();
}
