/**
 * Portal server configuration (§65.1).
 *
 * Validated once, on the server, and never imported into a client component --
 * `PORTAL_SESSION_SECRET` must not be bundled into anything the browser
 * downloads. Nothing here is prefixed `NEXT_PUBLIC_`, which is what keeps that
 * true.
 */
import 'server-only';
import { z } from 'zod';

const EnvSchema = z.object({
  WEB_PUBLIC_URL: z.string().url().default('http://localhost:3000'),
  OOLIX_API_INTERNAL_URL: z.string().url().default('http://localhost:4000'),
  // The API's public address. Shown to Partners in the command that fetches
  // the Agent bundle onto their server, which reaches Oolix the way the Agent
  // will -- not over the internal network.
  API_PUBLIC_URL: z.string().url().default('http://localhost:4000'),

  // Seals the session cookie. A short secret here would make the cookie
  // forgeable, and the cookie carries the user's access token.
  PORTAL_SESSION_SECRET: z.string().min(16),

  // The project's own environment, from the workspace .env (§65.1). NOT
  // NODE_ENV: `next start` sets that to "production" even on a laptop, so it
  // cannot tell a local stack apart from a real deployment.
  APP_ENV: z.enum(['local', 'test', 'dev', 'staging', 'production']).default('local'),
});

export type PortalEnv = z.infer<typeof EnvSchema>;

let cached: PortalEnv | undefined;

export function env(): PortalEnv {
  if (cached) return cached;

  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    // Fail at the first request rather than serving a half-configured portal.
    throw new Error(`Invalid portal configuration (spec §65.1):\n${detail}`);
  }

  cached = parsed.data;
  return cached;
}
