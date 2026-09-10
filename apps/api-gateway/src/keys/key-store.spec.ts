/**
 * Rotation is only worth having if the second half of it works.
 *
 * Rotating without retiring leaves the superseded key able to verify manifests
 * forever, which buys nothing; retiring too eagerly invalidates manifests
 * Agents have already cached. Both directions are tested here because both
 * were, at various points, wrong.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FileKeyStore } from './key-store.js';

function tempKeyPath(name = 'keys.keyfile.json'): string {
  return path.join(mkdtempSync(path.join(tmpdir(), 'oolix-keystore-')), name);
}

describe('FileKeyStore', () => {
  it('creates a key on first load and never publishes the private half', async () => {
    const store = await FileKeyStore.load(tempKeyPath(), 'manifest');
    const jwks = store.jwks();

    expect(jwks.keys).toHaveLength(1);
    expect(jwks.keys[0]?.kid).toBe(store.activeKid());
    // The JWKS is served publicly; a leaked `d` is a total compromise.
    for (const key of jwks.keys) expect(key).not.toHaveProperty('d');
  });

  it('refuses to create a key when the environment forbids it', async () => {
    // Production: a missing key file means the real key was not mounted.
    // Inventing one would invalidate every manifest already signed.
    await expect(
      FileKeyStore.load(tempKeyPath('absent.json'), 'manifest', { allowCreate: false }),
    ).rejects.toThrow(/will not create one/);
  });

  it('keeps the old key published after rotating, per the §75 overlap', async () => {
    const store = await FileKeyStore.load(tempKeyPath(), 'manifest');
    const first = store.activeKid();

    const second = await store.rotate('manifest');

    expect(second).not.toBe(first);
    expect(store.activeKid()).toBe(second);
    // Both verify; only the new one signs.
    expect(
      store
        .jwks()
        .keys.map((k) => k.kid)
        .sort(),
    ).toEqual([first, second].sort());
    expect(store.privateJwk().kid).toBe(second);
  });

  it('will not retire a key that is still inside the overlap window', async () => {
    const store = await FileKeyStore.load(tempKeyPath(), 'manifest');
    const first = store.activeKid();
    await store.rotate('manifest');

    // Both keys were made moments ago, so a 24-hour window protects both.
    expect(await store.retire(24 * 3_600_000)).toEqual([]);
    expect(store.jwks().keys.map((k) => k.kid)).toContain(first);
  });

  it('retires a superseded key once the window has passed', async () => {
    const file = tempKeyPath();
    const store = await FileKeyStore.load(file, 'manifest');
    const first = store.activeKid();
    const second = await store.rotate('manifest');

    // Age the superseded key by rewriting its timestamp: waiting 24 hours is
    // not a test.
    const data = JSON.parse(readFileSync(store.filePath, 'utf8'));
    for (const k of data.keys) {
      if (k.kid === first) k.created_at = new Date(Date.now() - 48 * 3_600_000).toISOString();
    }
    writeFileSync(store.filePath, JSON.stringify(data));

    const reloaded = await FileKeyStore.load(file, 'manifest');
    expect(await reloaded.retire(24 * 3_600_000)).toEqual([first]);
    expect(reloaded.jwks().keys.map((k) => k.kid)).toEqual([second]);
  });

  it('never retires the active key, however old it is', async () => {
    const file = tempKeyPath();
    const store = await FileKeyStore.load(file, 'manifest');

    const data = JSON.parse(readFileSync(store.filePath, 'utf8'));
    for (const k of data.keys) {
      k.created_at = new Date(Date.now() - 365 * 86_400_000).toISOString();
    }
    writeFileSync(store.filePath, JSON.stringify(data));

    const reloaded = await FileKeyStore.load(file, 'manifest');
    expect(await reloaded.retire(1)).toEqual([]);
    // Retiring the last key would fail every signature at once.
    expect(reloaded.jwks().keys).toHaveLength(1);
  });

  it('resolves a relative path the same way from any working directory', async () => {
    // The defect this prevents: the service ran with its own package as the
    // working directory and an operator's shell sat at the repository root, so
    // the same configured path named two different files. A key rotated from
    // one was invisible to the other, and the rotation silently did nothing.
    const relative = './.keys/resolution-probe.keyfile.json';
    const original = process.cwd();

    const fromRoot = await FileKeyStore.load(relative, 'manifest');
    try {
      process.chdir(tmpdir());
      const fromElsewhere = await FileKeyStore.load(relative, 'manifest');
      expect(fromElsewhere.filePath).toBe(fromRoot.filePath);
      expect(fromElsewhere.activeKid()).toBe(fromRoot.activeKid());
    } finally {
      process.chdir(original);
      rmSync(fromRoot.filePath, { force: true });
    }
  });
});
