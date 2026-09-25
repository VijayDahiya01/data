/**
 * Password storage and policy.
 *
 * Oolix now holds user credentials itself (docs/SECURITY-REVIEW.md records the
 * decision and what compensates for it). Two rules shape this file:
 *
 * Storage is scrypt from node:crypto -- memory-hard, standard, and no native
 * dependency to build into three container images. The parameters travel
 * inside every hash (`scrypt$N$r$p$salt$hash`), so raising them later needs no
 * migration: a password that verifies against weaker parameters is re-hashed
 * at the next sign-in (`needsRehash`).
 *
 * Policy follows NIST SP 800-63B rather than composition rules: length is what
 * makes a password hard to guess, and "one upper-case letter and a digit"
 * mostly produces `Password1!`. What IS refused is anything short, anything
 * built from the email address, anything with barely any variety, and the
 * passwords that attackers try first.
 */
import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';
import { COMMON_PASSWORDS } from './common-passwords.js';

/**
 * OWASP's equivalent-strength scrypt settings include N=2^15, r=8, p=3: about
 * 32 MiB and a few tens of milliseconds per hash. The memory cost is the point
 * -- it is what makes a GPU guessing farm expensive.
 */
export const SCRYPT_PARAMS = { N: 2 ** 15, r: 8, p: 3 } as const;

const KEY_LENGTH = 64;
const SALT_LENGTH = 16;

/**
 * Node refuses a scrypt call whose working memory (about 128·N·r bytes) exceeds
 * `maxmem`, and its default sits exactly at 32 MiB -- the size chosen above.
 * An explicit ceiling with headroom keeps a verification from failing at the
 * boundary.
 */
const MAX_MEMORY = 128 * 1024 * 1024;

function derive(
  password: string,
  salt: Buffer,
  length: number,
  params: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    // NFKC: the same password typed on two keyboards must produce one key.
    scrypt(
      password.normalize('NFKC'),
      salt,
      length,
      { ...params, maxmem: MAX_MEMORY },
      (err, key) => (err ? reject(err) : resolve(key)),
    );
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const key = await derive(password, salt, KEY_LENGTH, SCRYPT_PARAMS);
  const { N, r, p } = SCRYPT_PARAMS;
  return ['scrypt', N, r, p, salt.toString('base64url'), key.toString('base64url')].join('$');
}

export interface PasswordCheck {
  ok: boolean;
  /** True when the password is right but was hashed with weaker parameters. */
  needsRehash: boolean;
}

export async function verifyPassword(password: string, stored: string): Promise<PasswordCheck> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return { ok: false, needsRehash: false };

  const [N, r, p] = parts.slice(1, 4).map(Number);
  const salt = Buffer.from(parts[4]!, 'base64url');
  const expected = Buffer.from(parts[5]!, 'base64url');
  if (![N, r, p].every((n) => Number.isInteger(n) && n! > 0) || expected.length === 0) {
    return { ok: false, needsRehash: false };
  }

  const actual = await derive(password, salt, expected.length, { N: N!, r: r!, p: p! });
  // Constant-time: a byte-by-byte comparison would leak how much matched.
  const ok = timingSafeEqual(actual, expected);
  const weaker = N! < SCRYPT_PARAMS.N || r! < SCRYPT_PARAMS.r || p! < SCRYPT_PARAMS.p;
  return { ok, needsRehash: ok && weaker };
}

let decoy: Promise<string> | undefined;

/**
 * Spend the same time a real verification would when there is no account.
 *
 * Without this, "no such user" answers in microseconds and "wrong password"
 * in milliseconds, and the difference tells an attacker which emails are
 * registered -- the enumeration the generic error message exists to prevent.
 */
export async function verifyAgainstDecoy(password: string): Promise<void> {
  decoy ??= hashPassword(randomBytes(24).toString('base64url'));
  await verifyPassword(password, await decoy);
}

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

/**
 * Why a password is refused, in words to show the person choosing it. Empty
 * means acceptable.
 *
 * The maximum exists because scrypt's cost scales with input length only
 * mildly, but an unbounded field is an invitation to send megabytes.
 */
export function passwordProblems(password: string, email: string): string[] {
  const problems: string[] = [];
  const length = [...password].length;

  if (length < PASSWORD_MIN_LENGTH) {
    problems.push(`Use at least ${PASSWORD_MIN_LENGTH} characters.`);
  }
  if (length > PASSWORD_MAX_LENGTH) {
    problems.push(`Use at most ${PASSWORD_MAX_LENGTH} characters.`);
  }

  const lower = password.toLowerCase();
  const localPart = email.split('@')[0]?.toLowerCase() ?? '';
  if (localPart.length >= 4 && lower.includes(localPart)) {
    problems.push('Do not build the password from your email address.');
  }

  if (new Set(lower).size < 5) {
    problems.push('Use more variety — this repeats too few characters.');
  }

  if (COMMON_PASSWORDS.has(lower)) {
    problems.push('This password is one of the most commonly used. Choose another.');
  }

  return problems;
}
