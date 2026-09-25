import { describe, it, expect } from 'vitest';
import { randomBytes, scryptSync } from 'node:crypto';
import {
  hashPassword,
  verifyPassword,
  verifyAgainstDecoy,
  passwordProblems,
  SCRYPT_PARAMS,
} from './password.js';

describe('password storage', () => {
  it('stores a self-describing scrypt hash and verifies the same password', async () => {
    const stored = await hashPassword('correct horse battery staple');
    const [scheme, N, r, p, salt, key] = stored.split('$');
    expect(scheme).toBe('scrypt');
    expect([Number(N), Number(r), Number(p)]).toEqual([
      SCRYPT_PARAMS.N,
      SCRYPT_PARAMS.r,
      SCRYPT_PARAMS.p,
    ]);
    expect(Buffer.from(salt!, 'base64url')).toHaveLength(16);
    expect(Buffer.from(key!, 'base64url')).toHaveLength(64);

    expect(await verifyPassword('correct horse battery staple', stored)).toEqual({
      ok: true,
      needsRehash: false,
    });
  });

  it('refuses a wrong password', async () => {
    const stored = await hashPassword('correct horse battery staple');
    expect((await verifyPassword('correct horse battery stable', stored)).ok).toBe(false);
  });

  it('salts every hash, so equal passwords never share one', async () => {
    const [a, b] = await Promise.all([
      hashPassword('same password here'),
      hashPassword('same password here'),
    ]);
    expect(a).not.toBe(b);
  });

  it('flags a hash made with weaker parameters for re-hashing', async () => {
    // What a hash from an earlier, cheaper setting looks like.
    const salt = randomBytes(16);
    const key = scryptSync('an older password', salt, 64, { N: 2 ** 14, r: 8, p: 1 });
    const old = [
      'scrypt',
      2 ** 14,
      8,
      1,
      salt.toString('base64url'),
      key.toString('base64url'),
    ].join('$');

    expect(await verifyPassword('an older password', old)).toEqual({ ok: true, needsRehash: true });
    // A wrong password is never "needs rehash" -- that would leak that it was close.
    expect(await verifyPassword('not the password', old)).toEqual({
      ok: false,
      needsRehash: false,
    });
  });

  it('treats a malformed stored value as a failed check, not a crash', async () => {
    for (const bad of [
      '',
      'plaintext',
      'bcrypt$10$x$y',
      'scrypt$0$8$1$aaaa$bbbb',
      'scrypt$x$y$z$a$',
    ]) {
      expect((await verifyPassword('anything at all', bad)).ok).toBe(false);
    }
  });

  it('normalises Unicode, so one password typed two ways is one password', async () => {
    // U+FB01 is the "fi" ligature some keyboards and autocorrect produce.
    const stored = await hashPassword('ﬁrst-light-of-day');
    expect((await verifyPassword('first-light-of-day', stored)).ok).toBe(true);
  });

  it('runs a decoy verification without throwing', async () => {
    await expect(verifyAgainstDecoy('whatever was typed')).resolves.toBeUndefined();
  });
});

describe('password policy', () => {
  const email = 'priya.sharma@example.test';

  it('accepts a long, varied password', () => {
    expect(passwordProblems('tangerine-orbit-47-lantern', email)).toEqual([]);
  });

  it('refuses anything under 12 characters', () => {
    expect(passwordProblems('Sh0rt!pass', email)).toContain('Use at least 12 characters.');
  });

  it('refuses anything over 128 characters', () => {
    const long = 'abcdefghij'.repeat(13);
    expect(passwordProblems(long, email)).toContain('Use at most 128 characters.');
  });

  it('counts characters, not UTF-16 code units', () => {
    // Eleven emoji are 22 code units. Counting units would call this long
    // enough; it is eleven characters.
    const eleven = '🍊🌍🔭🪐🌙🎈🎯🧭📡🪄🎨';
    expect(eleven.length).toBe(22);
    expect(passwordProblems(eleven, email)).toContain('Use at least 12 characters.');
  });

  it('refuses a password built from the email address', () => {
    expect(passwordProblems('Priya.Sharma2026!', email)).toContain(
      'Do not build the password from your email address.',
    );
  });

  it('refuses one made of too few distinct characters', () => {
    expect(passwordProblems('aaaaaaaaaaaaaa', email)).toContain(
      'Use more variety — this repeats too few characters.',
    );
    expect(passwordProblems('abababab1212', email)).toContain(
      'Use more variety — this repeats too few characters.',
    );
  });

  it('refuses the most common passwords, whatever their case', () => {
    for (const common of ['qwerty123456', 'QWERTY123456', '1q2w3e4r5t6y']) {
      expect(passwordProblems(common, email)).toContain(
        'This password is one of the most commonly used. Choose another.',
      );
    }
  });
});
