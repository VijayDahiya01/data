/**
 * Prisma 7 configuration.
 *
 * In Prisma 7 the connection URL lives here rather than in schema.prisma, and
 * the runtime client connects through a driver adapter (see
 * src/prisma/prisma.service.ts). Migrations still read DATABASE_URL from the
 * environment, which keeps §65.1's env contract intact.
 */
import path from 'node:path';
import { config as loadEnv } from 'dotenv';
import { defineConfig, env } from 'prisma/config';

// The workspace keeps ONE .env at the repo root (§65.1). Prisma commands run
// from this app directory, so look in both places rather than requiring the
// developer to remember which directory they are in.
loadEnv({
  // oolix/packages/db -> the workspace root, where the one .env lives.
  path: [
    path.resolve(process.cwd(), '.env'),
    path.resolve(process.cwd(), '..', '..', '..', '.env'),
  ],
  quiet: true,
});

export default defineConfig({
  schema: path.join('prisma', 'schema.prisma'),

  migrations: {
    path: path.join('prisma', 'migrations'),
    // §95: seeding is explicitly unsupported against production.
    seed: 'tsx prisma/seed/index.ts',
  },

  datasource: {
    url: env('DATABASE_URL'),
  },
});
