/**
 * Idempotency-Key enforcement -- spec v5 §22.3, §53, §99.
 *
 * §53 requires the header on "campaign submit, approval, report batches,
 * channel sync and lead events" -- the operations where a retry would create a
 * SECOND business outcome rather than repeating the first. §99 defines the
 * semantics:
 *
 *   same key + same logical request  -> return the stored result
 *   same key + different payload     -> 409 IDEMPOTENCY_CONFLICT
 *
 * The interceptor sits above the handler so the guarantee is uniform: a
 * service cannot forget to implement it, and a new endpoint opts in with one
 * decorator rather than reimplementing the check.
 */
import {
  CallHandler,
  ExecutionContext,
  Inject,
  Injectable,
  NestInterceptor,
  SetMetadata,
} from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Observable, from, of, switchMap } from 'rxjs';
import { OolixError } from '@oolix/contracts';
import { IdempotencyService } from './idempotency.service.js';
import type { AuthenticatedRequest } from '../auth/auth.guard.js';

export const IDEMPOTENT_KEY = 'oolix:idempotent';

export interface IdempotentOptions {
  /** Reject the request when the header is absent (§53 for submit/approval). */
  required?: boolean;
  /** §99: longer retention for financial and external-sync operations. */
  retentionHours?: number;
}

/**
 * Mark a route as idempotent.
 *
 * `required: true` for anything that moves money or state a Partner relies on;
 * optional elsewhere, so a well-behaved client still gets replay protection
 * without every caller being forced to generate a key.
 */
export const Idempotent = (opts: IdempotentOptions = {}) =>
  SetMetadata(IDEMPOTENT_KEY, { required: false, ...opts });

@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(
    @Inject('Reflector') private readonly reflector: Reflector,
    @Inject(IdempotencyService) private readonly idempotency: IdempotencyService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const opts = this.reflector.getAllAndOverride<IdempotentOptions | undefined>(IDEMPOTENT_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!opts) return next.handle();

    const req = context.switchToHttp().getRequest<AuthenticatedRequest & FastifyRequest>();
    const reply = context.switchToHttp().getResponse<FastifyReply>();

    const header = req.headers['idempotency-key'];
    const key = Array.isArray(header) ? header[0] : header;

    if (!key) {
      if (opts.required) {
        throw new OolixError('VAL_001', 'Idempotency-Key header is required for this operation.', {
          fieldErrors: [{ field: 'Idempotency-Key', message: 'required (spec §53)' }],
        });
      }
      return next.handle();
    }

    if (key.length > 200) {
      throw new OolixError('VAL_001', 'Idempotency-Key is too long.');
    }

    const principal = req.principal;
    const orgId =
      principal?.kind === 'user'
        ? principal.orgId
        : principal?.kind === 'agent'
          ? principal.partnerOrgId
          : undefined;

    // Namespace the key by organization. Keys are client-generated, so two
    // tenants can legitimately pick the same one; without the namespace the
    // second would silently receive the first's stored response.
    const scopedKey = `${orgId ?? 'anon'}:${key}`;
    const endpoint = `${req.method} ${req.routeOptions?.url ?? req.url}`;
    const payload = req.body ?? null;

    return from(this.idempotency.check(scopedKey, endpoint, payload, orgId)).pipe(
      switchMap((stored) => {
        if (stored) {
          // §99: replay the stored result rather than re-executing.
          void reply.status(stored.status).header('idempotency-replayed', 'true');
          return of(stored.body);
        }

        return next.handle().pipe(
          switchMap((body) => {
            // Store only successful outcomes. A failed call should stay
            // retryable with the same key -- caching a 500 would strand the
            // caller until the record expired.
            const status = reply.statusCode;
            if (status < 200 || status >= 300) return of(body);

            // AWAIT the write before emitting the response.
            //
            // Fire-and-forget looks harmless but is not: the client most
            // likely to retry is the one whose first request timed out, and
            // its retry can arrive before an un-awaited write commits. The
            // record must be durable by the time the caller can possibly
            // send the retry, or the guarantee silently does not hold.
            return from(
              this.idempotency
                .store(
                  scopedKey,
                  endpoint,
                  payload,
                  { status, body },
                  {
                    ...(orgId ? { orgId } : {}),
                    ...(opts.retentionHours ? { retentionHours: opts.retentionHours } : {}),
                  },
                )
                .then(() => body)
                .catch(() => body),
            );
          }),
        );
      }),
    );
  }
}
