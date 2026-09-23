/**
 * Read secrets from files rather than the environment (§82).
 *
 * A secret passed as an environment variable leaks in more places than people
 * expect: `docker inspect` prints it, `/proc/1/environ` holds it, a crash
 * reporter serialises it, and every child process inherits it. The file
 * convention is what Docker secrets, Kubernetes secret volumes and the managed
 * secret-store sidecars already speak, so supporting it is what lets a real
 * deployment keep secrets out of the environment without this codebase having
 * to know which secret manager is in use.
 *
 *   DATABASE_URL_FILE=/run/secrets/database_url
 *
 * is read once at start-up and becomes `DATABASE_URL`. The `_FILE` variable is
 * then removed, so even the path does not linger.
 */
import { readFileSync } from 'node:fs';

export function loadFileSecrets(env: NodeJS.ProcessEnv = process.env): void {
  for (const [key, value] of Object.entries(env)) {
    if (!key.endsWith('_FILE') || !value) continue;
    const target = key.slice(0, -'_FILE'.length);
    if (!target) continue;

    let contents: string;
    try {
      contents = readFileSync(value, 'utf8');
    } catch (cause) {
      // Fail loudly. A missing secret file that fell back to a default would
      // start the service on the wrong credentials, which is worse than not
      // starting at all: it looks like it worked.
      throw new Error(
        `${key} points at ${value}, which could not be read. ` +
          `The secret is required and there is no default for it.`,
        { cause },
      );
    }

    // Trailing newlines are near-universal in secret files: an editor adds
    // one, `echo` adds one, a Kubernetes secret often carries one. A password
    // with an invisible newline fails to authenticate and gives no hint why.
    const secret = contents.replace(/\r?\n$/, '');
    if (secret === '') {
      throw new Error(`${key} points at ${value}, which is empty.`);
    }

    const existing = env[target];
    if (existing !== undefined && existing !== secret) {
      // Which credential is live is not a question to answer with a precedence
      // rule nobody will remember at three in the morning.
      throw new Error(
        `Both ${target} and ${key} are set, with different values. ` +
          `Remove one: it is not clear which secret is intended.`,
      );
    }

    env[target] = secret;
    delete env[key];
  }
}
