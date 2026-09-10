/**
 * Prisma configuration for migrations inside the runtime image.
 *
 * Separate from packages/db/prisma.config.ts on purpose. That one is for
 * developers: it loads dotenv, points at a workspace-relative schema, and
 * declares a `tsx`-based seed command — none of which exist in a production
 * image, and all of which would have to be installed to satisfy an import.
 *
 * In Prisma 7 the datasource URL comes from a config file rather than the
 * schema, so without this file `prisma migrate deploy` refuses to run at all.
 * That is how the documented deployment step came to be one that had never
 * been executed end to end.
 *
 * DATABASE_URL is read from the environment, which is where a container's
 * orchestrator puts it — or where the _FILE secret indirection lands it.
 */
import { defineConfig, env } from 'prisma/config';

export default defineConfig({
  schema: 'node_modules/@oolix/db/prisma/schema.prisma',
  migrations: {
    path: 'node_modules/@oolix/db/prisma/migrations',
  },
  datasource: {
    url: env('DATABASE_URL'),
  },
});
