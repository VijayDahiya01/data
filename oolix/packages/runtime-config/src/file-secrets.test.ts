import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadFileSecrets } from './file-secrets.js';

const dir = mkdtempSync(path.join(tmpdir(), 'oolix-secrets-'));

function secretFile(name: string, contents: string): string {
  const p = path.join(dir, name);
  writeFileSync(p, contents);
  return p;
}

describe('loadFileSecrets', () => {
  it('reads the secret and removes the pointer', () => {
    const env: NodeJS.ProcessEnv = { DATABASE_URL_FILE: secretFile('db', 'postgres://real') };
    loadFileSecrets(env);
    expect(env.DATABASE_URL).toBe('postgres://real');
    expect(env.DATABASE_URL_FILE).toBeUndefined();
  });

  it('strips the trailing newline every editor adds', () => {
    // A password with an invisible newline fails to authenticate and the error
    // never mentions whitespace.
    const env: NodeJS.ProcessEnv = { SESSION_SECRET_FILE: secretFile('sess', 'hunter2\n') };
    loadFileSecrets(env);
    expect(env.SESSION_SECRET).toBe('hunter2');
  });

  it('keeps a newline that is inside the secret', () => {
    const env: NodeJS.ProcessEnv = {
      SIGNING_KEY_FILE: secretFile('pem', '-----BEGIN-----\nabc\n-----END-----\n'),
    };
    loadFileSecrets(env);
    expect(env.SIGNING_KEY).toBe('-----BEGIN-----\nabc\n-----END-----');
  });

  it('refuses a missing file rather than falling back', () => {
    const env: NodeJS.ProcessEnv = { DATABASE_URL_FILE: path.join(dir, 'absent') };
    expect(() => loadFileSecrets(env)).toThrow(/could not be read/);
  });

  it('refuses an empty secret file', () => {
    const env: NodeJS.ProcessEnv = { API_KEY_FILE: secretFile('empty', '') };
    expect(() => loadFileSecrets(env)).toThrow(/is empty/);
  });

  it('refuses a conflicting pair instead of picking one', () => {
    const env: NodeJS.ProcessEnv = {
      DATABASE_URL: 'postgres://stale',
      DATABASE_URL_FILE: secretFile('db2', 'postgres://real'),
    };
    expect(() => loadFileSecrets(env)).toThrow(/not clear which secret is intended/);
  });

  it('accepts a matching pair, since nothing is ambiguous', () => {
    const env: NodeJS.ProcessEnv = {
      DATABASE_URL: 'postgres://same',
      DATABASE_URL_FILE: secretFile('db3', 'postgres://same'),
    };
    expect(() => loadFileSecrets(env)).not.toThrow();
    expect(env.DATABASE_URL).toBe('postgres://same');
  });

  it('leaves ordinary variables alone', () => {
    const env: NodeJS.ProcessEnv = { LOG_LEVEL: 'debug', PROFILE: 'prod' };
    loadFileSecrets(env);
    expect(env).toEqual({ LOG_LEVEL: 'debug', PROFILE: 'prod' });
  });
});
