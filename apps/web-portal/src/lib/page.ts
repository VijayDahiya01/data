/**
 * Page-level session handling.
 *
 * Every authenticated screen starts with `requireContext()`. A missing or
 * expired session becomes a redirect to login with the current path preserved,
 * rather than an error page -- an expired token is the most ordinary thing
 * that happens in a portal, not a failure.
 */
import 'server-only';
import { redirect } from 'next/navigation';
import { ApiError, NotAuthenticatedError } from './api';
import { meContext, type MeContext } from './context';

export async function requireContext(returnTo?: string): Promise<MeContext> {
  try {
    return await meContext();
  } catch (err) {
    if (err instanceof NotAuthenticatedError || (err instanceof ApiError && err.isAuthFailure)) {
      const target = returnTo ? `/login?return_to=${encodeURIComponent(returnTo)}` : '/login';
      redirect(target);
    }
    throw err;
  }
}

/** Human-readable text for a §77.2 error code, for form-level messages. */
export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    const suffix = err.correlationId ? ` (ref ${err.correlationId})` : '';
    return `${err.message}${suffix}`;
  }
  return err instanceof Error ? err.message : 'Something went wrong.';
}
