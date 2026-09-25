/**
 * Integration test environment (§79.1, §95).
 *
 * CI supplies DATABASE_URL/REDIS_URL through service containers; a developer
 * running `pnpm test:integration` locally has them in `.env`. Everything else
 * is given a test-only default here so the suite never depends on a developer
 * having exported eleven variables by hand.
 *
 * APP_ENV is pinned to `test` -- §95 forbids production seeding, and several
 * guards behave differently outside local/test.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';

process.env.APP_ENV = 'test';
process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? 'error';

// Pick up the workspace .env when running locally. Absent in CI, which is fine:
// the service-container variables are already exported there.
let dir = __dirname;
for (let i = 0; i < 8; i += 1) {
  if (existsSync(path.join(dir, 'pnpm-workspace.yaml')) && existsSync(path.join(dir, '.env'))) {
    process.loadEnvFile(path.join(dir, '.env'));
    break;
  }
  const parent = path.dirname(dir);
  if (parent === dir) break;
  dir = parent;
}

process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://oolix:oolix@localhost:5432/oolix?schema=public';
process.env.REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';

// Sign-in is Oolix's own now, so the suite exercises it for real: emails are
// kept in memory for the tests to read (no mail is sent), and the breached-
// password lookup -- a call to an external service -- is off, so the suite
// never depends on the network.
process.env.EMAIL_PROVIDER = 'capture';
process.env.PASSWORD_BREACH_CHECK = 'false';

// Keys are generated on first boot into a scratch directory, so a CI runner
// starts from nothing and a developer's real local keys are left alone.
const keyDir = path.join(__dirname, '.keys-test');
process.env.MANIFEST_JWKS_PATH = path.join(keyDir, 'manifest-jwks-test.json');
process.env.MANIFEST_SIGNING_PRIVATE_KEY_PATH = path.join(keyDir, 'manifest-signing-test.pem');
