/**
 * Injects the authenticated principal established by AuthGuard.
 *
 * Controllers take the principal as a parameter rather than reaching into the
 * request, so the organization scope a handler operates on is visible in its
 * signature (§66: every route enforces org scope server-side).
 */
import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import { OolixError } from '@oolix/contracts';
import type { AuthenticatedRequest } from './auth.guard.js';

export const Principal = createParamDecorator((_data: unknown, ctx: ExecutionContext) => {
  const req = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
  if (!req.principal) {
    // Reaching a handler without a principal means the guard was bypassed --
    // fail loudly rather than let a handler run unauthenticated.
    throw new OolixError('AUTH_001', 'No authenticated principal on this request.');
  }
  return req.principal;
});
