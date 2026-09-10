/**
 * Switch the active organization (§34).
 *
 * §34: "role switching must not require a second account." This changes which
 * organization subsequent API calls act within; it grants nothing. The API
 * re-derives roles and permissions from the database for whichever
 * organization is named (§4.2), so asking for one the user does not belong to
 * simply fails there.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { readSession, writeSession } from '@/lib/session';
import { meContext } from '@/lib/context';

export async function POST(request: NextRequest) {
  const session = await readSession();
  if (!session) return NextResponse.redirect(new URL('/login', request.url));

  const form = await request.formData();
  const orgId = String(form.get('org_id') ?? '');
  const returnTo = String(form.get('return_to') ?? '/');

  // Confirm membership before storing it, so the switcher cannot be used to
  // park an arbitrary id in the session and probe for its existence.
  const ctx = await meContext();
  const allowed = ctx.organizations.some((o) => o.id === orgId);
  if (!allowed) return NextResponse.redirect(new URL('/', request.url));

  await writeSession({ ...session, activeOrgId: orgId });

  const safe = returnTo.startsWith('/') && !returnTo.startsWith('//') ? returnTo : '/';
  return NextResponse.redirect(new URL(safe, request.url));
}
