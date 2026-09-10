/**
 * Log out (§35).
 *
 * Ends the Keycloak session too, not just ours. A local-only logout leaves the
 * user one redirect away from being signed straight back in, which on a shared
 * machine is not a logout at all.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { clearSession, readSession } from '@/lib/session';
import { endSessionUrl } from '@/lib/oidc';

async function logout(request: NextRequest) {
  const session = await readSession();
  await clearSession();

  const target = session ? await endSessionUrl() : null;
  return NextResponse.redirect(target ?? new URL('/login', request.url));
}

export const GET = logout;
export const POST = logout;
