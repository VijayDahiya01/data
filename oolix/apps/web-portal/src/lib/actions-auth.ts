'use server';

/**
 * Sign-up, sign-in and account recovery (§35.1).
 *
 * The API owns every decision -- what counts as a good password, whether an
 * email has an account, when to lock one -- and these actions only carry the
 * form to it and the tokens back into the sealed session cookie. The one
 * place the portal adds anything is wording: an API error written for
 * developers becomes a sentence for the person at the keyboard.
 *
 * Passwords are never trimmed or logged. A trailing space is part of a
 * password, and a sign-in form is the one form whose contents must never
 * appear in a log line.
 */
import { redirect } from 'next/navigation';
import { ApiError } from './api-error';
import { api, NotAuthenticatedError } from './api';
import { postAuth, sessionFromTokens, visitorAddress, type TokenPair } from './auth-api';
import { readSession, writeSession } from './session';
import { TERMS_VERSION } from './terms';
import type { ActionState } from './actions';

export interface AuthState extends ActionState {
  /** The password was right but the address is unconfirmed: offer to resend. */
  unverified?: boolean;
  email?: string;
}

const text = (fd: FormData, key: string): string => String(fd.get(key) ?? '').trim();
const secret = (fd: FormData, key: string): string => String(fd.get(key) ?? '');

function toAuthState(err: unknown): AuthState {
  if (err instanceof ApiError) {
    if (err.code === 'SYS_001') {
      return {
        error: `Too many attempts from here. Try again in ${err.retryAfterSeconds ?? 60} seconds.`,
      };
    }
    const fieldErrors: Record<string, string> = {};
    for (const fe of err.fieldErrors) fieldErrors[fe.field] ??= fe.message;
    return { error: err.message, fieldErrors };
  }
  if (err instanceof NotAuthenticatedError) redirect('/login?error=session');
  // Unreachable API or a network fault. The detail goes to the server log,
  // never to the page (§99).
  console.error('[oolix-portal] sign-in request failed:', err instanceof Error ? err.name : err);
  return { error: 'Oolix is not reachable right now. Please try again in a moment.' };
}

/** A path on this site, never another origin -- the classic open-redirect hole. */
function safeReturnTo(value: string): string {
  return value.startsWith('/') && !value.startsWith('//') && !value.startsWith('/\\') ? value : '/';
}

/** Checked here only so the person hears about a typo before the API does. */
function mismatch(fd: FormData, field: string, confirm: string): AuthState | null {
  return secret(fd, field) === secret(fd, confirm)
    ? null
    : { fieldErrors: { [confirm]: 'The two passwords do not match.' } };
}

export async function signIn(_prev: AuthState, fd: FormData): Promise<AuthState> {
  const email = text(fd, 'email').toLowerCase();
  let tokens: TokenPair;
  try {
    tokens = await postAuth<TokenPair>(
      '/v1/auth/login',
      { email, password: secret(fd, 'password') },
      await visitorAddress(),
    );
  } catch (err) {
    if (err instanceof ApiError && err.code === 'AUTH_002') {
      return {
        error: 'Confirm your email address first — use the link we emailed when you signed up.',
        unverified: true,
        email,
      };
    }
    return toAuthState(err);
  }
  await writeSession(sessionFromTokens(tokens, { email }));
  redirect(safeReturnTo(text(fd, 'return_to')));
}

export async function signUp(_prev: AuthState, fd: FormData): Promise<AuthState> {
  const email = text(fd, 'email').toLowerCase();
  if (fd.get('accept_terms') !== 'on') {
    return { fieldErrors: { accept_terms: 'Accept the Terms and Privacy notice to continue.' } };
  }
  const typo = mismatch(fd, 'password', 'confirm_password');
  if (typo) return typo;
  try {
    await postAuth(
      '/v1/auth/signup',
      {
        email,
        name: text(fd, 'name'),
        password: secret(fd, 'password'),
        country: text(fd, 'country'),
        accept_terms: true,
        terms_version: TERMS_VERSION,
      },
      await visitorAddress(),
    );
  } catch (err) {
    return toAuthState(err);
  }
  return { ok: true, email };
}

export async function resendVerification(_prev: AuthState, fd: FormData): Promise<AuthState> {
  const email = text(fd, 'email').toLowerCase();
  try {
    await postAuth('/v1/auth/resend-verification', { email }, await visitorAddress());
  } catch (err) {
    return toAuthState(err);
  }
  return { ok: true, email };
}

export async function confirmEmail(_prev: AuthState, fd: FormData): Promise<AuthState> {
  try {
    await postAuth('/v1/auth/verify-email', { token: text(fd, 'token') }, await visitorAddress());
  } catch (err) {
    return toAuthState(err);
  }
  redirect('/login?verified=1');
}

export async function requestPasswordReset(_prev: AuthState, fd: FormData): Promise<AuthState> {
  try {
    await postAuth(
      '/v1/auth/forgot-password',
      { email: text(fd, 'email').toLowerCase() },
      await visitorAddress(),
    );
  } catch (err) {
    return toAuthState(err);
  }
  return { ok: true };
}

export async function resetPassword(_prev: AuthState, fd: FormData): Promise<AuthState> {
  const typo = mismatch(fd, 'password', 'confirm_password');
  if (typo) return typo;
  try {
    await postAuth(
      '/v1/auth/reset-password',
      { token: text(fd, 'token'), password: secret(fd, 'password') },
      await visitorAddress(),
    );
  } catch (err) {
    return toAuthState(err);
  }
  redirect('/login?reset=1');
}

export async function acceptInvitation(_prev: AuthState, fd: FormData): Promise<AuthState> {
  const password = secret(fd, 'password');
  const name = text(fd, 'name');
  if (password) {
    const typo = mismatch(fd, 'password', 'confirm_password');
    if (typo) return typo;
  }
  let result: { status: string } & Partial<TokenPair>;
  try {
    result = await postAuth(
      '/v1/auth/accept-invite',
      { token: text(fd, 'token'), ...(password ? { password } : {}), ...(name ? { name } : {}) },
      await visitorAddress(),
    );
  } catch (err) {
    return toAuthState(err);
  }
  // Someone new is signed straight in; someone with an account signs in as usual.
  if (result.access_token && result.refresh_token) {
    await writeSession(sessionFromTokens(result as TokenPair));
    redirect('/');
  }
  redirect('/login?joined=1');
}

export async function changePassword(_prev: AuthState, fd: FormData): Promise<AuthState> {
  const typo = mismatch(fd, 'new_password', 'confirm_password');
  if (typo) return typo;
  try {
    const tokens = await api<TokenPair>('/v1/me/password', {
      method: 'POST',
      body: {
        current_password: secret(fd, 'current_password'),
        new_password: secret(fd, 'new_password'),
      },
    });
    // Every other session just ended; this one carries on with the new pair.
    const current = await readSession();
    await writeSession(sessionFromTokens(tokens, current ?? {}));
  } catch (err) {
    return toAuthState(err);
  }
  return { ok: true };
}
