/**
 * Portal session -- an encrypted, httpOnly cookie (§82).
 *
 * The session holds the user's access and refresh tokens. It is deliberately NOT
 * exposed to the browser as a readable value: every call to the Oolix API is
 * made by this Next server, so a cross-site script on the portal cannot read a
 * token and replay it. That is also why the cookie is `httpOnly` and sealed
 * rather than merely signed -- a signed cookie is still readable by anyone who
 * gets hold of it.
 *
 * AES-256-GCM gives confidentiality and integrity in one pass, so a tampered
 * cookie fails to decrypt rather than decrypting into something unexpected.
 */
import 'server-only';
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { cookies } from 'next/headers';
import { env } from './env';

export const SESSION_COOKIE = 'oolix_session';

export interface Session {
  accessToken: string;
  /** Single use: every refresh returns a new one (see proxy.ts). */
  refreshToken: string;
  /** Unix ms. Refreshed slightly early so a call never races expiry. */
  expiresAt: number;
  email?: string;
  /** The organization the user is currently acting within (§34). */
  activeOrgId?: string;
}

/**
 * One definition, because three places write this cookie: sign-in (a server
 * action), the org switcher (a route handler) and the refresh in proxy.ts.
 *
 * `lax` rather than `strict` so following a link from an email or another
 * site still arrives signed in. `secure` follows the deployment scheme.
 */
export function sessionCookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: env().WEB_PUBLIC_URL.startsWith('https://'),
    path: '/',
    // Matches the API's sign-in lifetime (USER_SESSION_TTL_HOURS).
    maxAge: 60 * 60 * 8,
  };
}

/**
 * Browsers drop a cookie larger than about 4 KB without saying so, and the
 * symptom is indistinguishable from "login silently did nothing".
 *
 * That is exactly what happened when the session also carried the ID token:
 * access + refresh + id together crossed the limit, the cookie vanished, and
 * every page redirected back to login. The ID token is gone, and this guard
 * makes a future regression fail loudly rather than mysteriously.
 */
const MAX_COOKIE_BYTES = 3900;

const KEY_INFO = Buffer.from('oolix-portal-session-v1');

function key(salt: Buffer): Buffer {
  // HKDF rather than using the secret directly: the env value is a passphrase,
  // not necessarily 32 bytes of entropy, and a per-cookie salt means two
  // sessions never share a derived key.
  return Buffer.from(hkdfSync('sha256', env().PORTAL_SESSION_SECRET, salt, KEY_INFO, 32));
}

export function seal(session: Session): string {
  const value = encrypt(session);
  if (Buffer.byteLength(value, 'utf8') > MAX_COOKIE_BYTES) {
    throw new Error(
      `Portal session cookie would be ${Buffer.byteLength(value, 'utf8')} bytes, over the ` +
        `${MAX_COOKIE_BYTES}-byte budget. Browsers discard it silently. Move the session to a ` +
        'server-side store rather than trimming claims until it happens to fit.',
    );
  }
  return value;
}

function encrypt(session: Session): string {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(salt), iv);
  const body = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(session), 'utf8')),
    cipher.final(),
  ]);
  return [salt, iv, cipher.getAuthTag(), body].map((b) => b.toString('base64url')).join('.');
}

export function unseal(raw: string): Session | null {
  try {
    const parts = raw.split('.');
    if (parts.length !== 4) return null;
    const [salt, iv, tag, body] = parts.map((p) => Buffer.from(p, 'base64url'));

    const decipher = createDecipheriv('aes-256-gcm', key(salt!), iv!);
    decipher.setAuthTag(tag!);
    const json = Buffer.concat([decipher.update(body!), decipher.final()]).toString('utf8');
    return JSON.parse(json) as Session;
  } catch {
    // A cookie sealed with a rotated secret, or a tampered one, is simply
    // treated as absent. The user logs in again.
    return null;
  }
}

export async function readSession(): Promise<Session | null> {
  const raw = (await cookies()).get(SESSION_COOKIE)?.value;
  return raw ? unseal(raw) : null;
}

/**
 * Only from a server action or a route handler: Next.js refuses to set a
 * cookie while rendering a page. That is why token refresh lives in proxy.ts,
 * which runs before rendering, instead of in the API client.
 */
export async function writeSession(session: Session): Promise<void> {
  (await cookies()).set(SESSION_COOKIE, seal(session), sessionCookieOptions());
}

export async function clearSession(): Promise<void> {
  (await cookies()).delete(SESSION_COOKIE);
}
