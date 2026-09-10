/**
 * Portal server configuration (§65.1).
 *
 * Validated once, on the server, and never imported into a client component --
 * `OIDC_CLIENT_SECRET` and `PORTAL_SESSION_SECRET` must not be bundled into
 * anything the browser downloads. Nothing here is prefixed `NEXT_PUBLIC_`,
 * which is what keeps that true.
 */
import 'server-only';
import { z } from 'zod';

const EnvSchema = z.object({
  OIDC_ISSUER_URL: z.string().url(),
  OIDC_CLIENT_ID: z.string().min(1),
  OIDC_CLIENT_SECRET: z.string().min(1),

  WEB_PUBLIC_URL: z.string().url().default('http://localhost:3000'),
  OOLIX_API_INTERNAL_URL: z.string().url().default('http://localhost:4000'),

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
    // Fail at the first request rather than serving a half-configured portal
    // that redirects to an issuer that does not exist.
    throw new Error(`Invalid portal configuration (spec §65.1):\n${detail}`);
  }

  cached = parsed.data;
  return cached;
}

/** Absolute callback URL. Must match the Keycloak client's redirect URI. */
export function callbackUrl(): string {
  return new URL('/api/auth/callback', env().WEB_PUBLIC_URL).toString();
}
