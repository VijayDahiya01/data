/**
 * ES256 key material for manifest signing (§75) and Agent access tokens (§92).
 *
 * PRODUCTION NOTE. §75 requires the manifest signing private key to live in
 * cloud KMS/HSM, where it is never exportable. This file-backed store is the
 * LOCAL DEVELOPMENT implementation of the same interface; swapping in a KMS
 * signer means implementing `KeyStore` and changing the provider, with no
 * change to callers.
 *
 * Keys are generated on first boot and written under .keys/, which is
 * gitignored (§82: no credentials in source control).
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { JWK } from 'jose';
import { generateManifestKeyPair, buildJwks } from '@oolix/manifest-schema';

export interface KeyStore {
  /** Current signing key id. */
  activeKid(): string;
  /** Private JWK for signing. In a KMS implementation this never leaves. */
  privateJwk(): JWK;
  /** Public JWKS, including any key still inside its rotation overlap (§75). */
  jwks(): { keys: JWK[] };
}

interface PersistedKeys {
  active_kid: string;
  keys: Array<{ kid: string; private_jwk: JWK; public_jwk: JWK; created_at: string }>;
}

/**
 * Resolve a key path against the workspace, never the current directory.
 *
 * `path.resolve` was the whole bug. The API is started with its own package as
 * the working directory, an operator's terminal sits at the repository root,
 * and the same configured value -- `./.keys/manifest-jwks-local.json` --
 * therefore named two different files. Both existed. Both looked right. A key
 * rotated from the repository root was written to a file the running service
 * had never opened, so the rotation appeared to succeed and changed nothing.
 *
 * An absolute path is used as given, which is what a deployment should
 * configure. A relative one is anchored to the workspace root so every caller
 * agrees regardless of where it was launched from.
 */
function resolveKeyPath(filePath: string): string {
  if (path.isAbsolute(filePath)) return filePath;

  let dir = __dirname;
  for (let i = 0; i < 8; i += 1) {
    if (existsSync(path.join(dir, 'pnpm-workspace.yaml'))) {
      return path.resolve(dir, filePath);
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  // No workspace marker: a built container, where the configured path should
  // have been absolute in the first place.
  return path.resolve(filePath);
}

export class FileKeyStore implements KeyStore {
  private constructor(
    private readonly data: PersistedKeys,
    readonly filePath: string,
  ) {}

  /**
   * Load the key file, creating it on first run.
   *
   * `purpose` separates the manifest key from the agent-token key: §75 and
   * §92 are different trust domains, and reusing one key across both would let
   * a leaked agent token key forge Partner manifests.
   */
  static async load(
    filePath: string,
    purpose: string,
    options: { allowCreate?: boolean } = {},
  ): Promise<FileKeyStore> {
    const resolved = resolveKeyPath(filePath);

    try {
      const raw = await readFile(resolved, 'utf8');
      return new FileKeyStore(JSON.parse(raw) as PersistedKeys, resolved);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }

    // Generating a key because a file was missing is a development
    // convenience and a production catastrophe. Every manifest an Agent has
    // cached was signed by the key that is not there, and minting a fresh one
    // invalidates all of them at once -- silently, and looking like a healthy
    // start-up. Outside development the absence of the key is the error.
    if (options.allowCreate === false) {
      throw new Error(
        `No ${purpose} signing key at ${resolved}, and this environment will not create one.
` +
          `Generating a key here would invalidate every manifest already signed with the real ` +
          `one. Mount the existing key, or create one deliberately with \`pnpm keys:init\`.`,
      );
    }

    const kid = `${purpose}-${new Date().toISOString().slice(0, 10)}-1`;
    const pair = await generateManifestKeyPair(kid);
    const data: PersistedKeys = {
      active_kid: kid,
      keys: [
        {
          kid,
          private_jwk: pair.privateJwk,
          public_jwk: pair.publicJwk,
          created_at: new Date().toISOString(),
        },
      ],
    };

    await mkdir(path.dirname(resolved), { recursive: true });
    // 0600: the private key must not be world-readable even locally.
    await writeFile(resolved, JSON.stringify(data, null, 2), { mode: 0o600 });

    return new FileKeyStore(data, resolved);
  }

  activeKid(): string {
    return this.data.active_kid;
  }

  privateJwk(): JWK {
    const entry = this.data.keys.find((k) => k.kid === this.data.active_kid);
    if (!entry)
      throw new Error(`active kid ${this.data.active_kid} is not present in the key file`);
    return entry.private_jwk;
  }

  jwks(): { keys: JWK[] } {
    // buildJwks strips any private parameters defensively -- this result is
    // served on a public endpoint.
    return buildJwks(this.data.keys.map((k) => k.public_jwk));
  }

  /**
   * Add a new key and make it active, keeping the previous one published.
   *
   * §75: "publish new public key before signing switch; accept old + new
   * during 24-hour overlap". Retiring the old key is a separate, later step.
   */
  async rotate(purpose: string): Promise<string> {
    const kid = `${purpose}-${new Date().toISOString().slice(0, 10)}-${this.data.keys.length + 1}`;
    const pair = await generateManifestKeyPair(kid);
    this.data.keys.push({
      kid,
      private_jwk: pair.privateJwk,
      public_jwk: pair.publicJwk,
      created_at: new Date().toISOString(),
    });
    this.data.active_kid = kid;
    await writeFile(this.filePath, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    return kid;
  }

  /** Every key currently published, oldest first. */
  inventory(): Array<{ kid: string; created_at: string; active: boolean }> {
    return this.data.keys.map((k) => ({
      kid: k.kid,
      created_at: k.created_at,
      active: k.kid === this.data.active_kid,
    }));
  }

  /**
   * Drop superseded keys once the §75 overlap has passed.
   *
   * The other half of rotation, and the half that is easy to never do. A key
   * that stays in the JWKS forever can still verify a manifest forever, so a
   * rotation that is never followed by a retirement buys nothing: the old key
   * remains as useful to an attacker as it ever was.
   *
   * Retiring is the destructive direction, so it refuses more than it accepts:
   * never the active key, never inside the overlap window, and never the last
   * key standing.
   */
  async retire(olderThanMs: number): Promise<string[]> {
    const cutoff = Date.now() - olderThanMs;
    const removed: string[] = [];

    const keep = this.data.keys.filter((k) => {
      if (k.kid === this.data.active_kid) return true;
      if (new Date(k.created_at).getTime() > cutoff) return true;
      removed.push(k.kid);
      return false;
    });

    if (keep.length === 0) {
      // Unreachable while the active key is always kept, but the cost of being
      // wrong here is every manifest in flight failing verification at once.
      throw new Error('refusing to retire every key: no signing key would remain');
    }
    if (removed.length === 0) return [];

    this.data.keys = keep;
    await writeFile(this.filePath, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    return removed;
  }
}
