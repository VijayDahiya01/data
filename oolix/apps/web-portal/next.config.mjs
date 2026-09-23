import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Load the workspace `.env` before Next reads configuration (§65.1).
 *
 * Next only looks for `.env` beside the app, but this is a monorepo with one
 * environment file at the root — the same one the API and the worker read, so
 * the portal cannot drift out of step with the issuer or API URL they use.
 *
 * Deliberately skipped in production: §82 requires non-local secrets to come
 * from a secret manager, and a container that silently picked up a committed
 * `.env` would be exactly the failure that rule prevents.
 */
function loadWorkspaceEnv() {
  if (process.env.NODE_ENV === 'production' && process.env.APP_ENV === 'production') return;

  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i += 1) {
    if (existsSync(path.join(dir, 'pnpm-workspace.yaml')) && existsSync(path.join(dir, '.env'))) {
      process.loadEnvFile(path.join(dir, '.env'));
      return;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
}

loadWorkspaceEnv();

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // §82: the portal is the only permitted origin for the Oolix API, and the
  // API enforces that with CORS. Nothing here should widen it.
  poweredByHeader: false,

  // Emit a self-contained server bundle for containers.
  //
  // Without this a production image needs the whole workspace node_modules to
  // run `next start`. Standalone traces the modules actually reached and writes
  // a `server.js` that carries them, which is the difference between shipping a
  // dependency tree and shipping a program.
  //
  // `outputFileTracingRoot` points at the workspace root: in a monorepo the
  // tracer otherwise starts from this app directory and misses the hoisted
  // dependencies, producing a bundle that builds cleanly and crashes on start.
  output: 'standalone',
  // Three levels: oolix/apps/web-portal -> the workspace root. This is a count,
  // not a search, so it has to change whenever the portal moves -- and getting
  // it wrong is silent in exactly the way the note above describes. The
  // standalone bundle then mirrors the path below the root, which is why the
  // Dockerfile starts `oolix/apps/web-portal/server.js`.
  outputFileTracingRoot: path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..'),
};

export default nextConfig;
