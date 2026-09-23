/**
 * Load the repository `.env` before anything reads `process.env` (§65.1).
 *
 * Deliberately a no-op in production: §82 requires non-local secrets to come
 * from a secret manager, and a container that silently picked up a `.env`
 * someone left in the image would be exactly the failure that rule exists to
 * prevent. Locally, this is what makes `pnpm dev:api` work from a clean
 * checkout without the developer exporting eleven variables by hand.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';

export function loadDotEnv(): void {
  if (process.env.APP_ENV === 'production' || process.env.NODE_ENV === 'production') return;

  // Walk up from this file to the workspace root. The compiled file sits under
  // apps/api-gateway/dist/config, the source under apps/api-gateway/src/config,
  // so a fixed number of `..` would break in one of the two.
  let dir = __dirname;
  for (let i = 0; i < 8; i += 1) {
    const candidate = path.join(dir, '.env');
    if (existsSync(candidate) && existsSync(path.join(dir, 'pnpm-workspace.yaml'))) {
      process.loadEnvFile(candidate);
      return;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
}
