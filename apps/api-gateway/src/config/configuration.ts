/**
 * Environment configuration -- spec v5 §65.1.
 *
 * Validated once at boot with zod. A missing or malformed variable must stop
 * the process immediately rather than surface as an undefined at request time:
 * §82 requires secrets to come from a secret manager, and a silently-undefined
 * signing key would mean unsigned manifests reaching Partner Agents.
 */
import { z } from 'zod';

const bool = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === 'boolean' ? v : v.toLowerCase() === 'true'));

const int = (def?: number) =>
  z
    .union([z.number(), z.string()])
    .transform((v) => (typeof v === 'number' ? v : Number(v)))
    .pipe(z.number().int())
    .default(def as number);

export const ConfigSchema = z.object({
  APP_ENV: z.enum(['local', 'test', 'dev', 'staging', 'production']).default('local'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  LOG_FORMAT: z.enum(['json', 'pretty']).default('json'),

  API_PORT: int(4000),
  API_PUBLIC_URL: z.string().url().default('http://localhost:4000'),
  WEB_PUBLIC_URL: z.string().url().default('http://localhost:3000'),

  DATABASE_URL: z.string().min(1),
  DATABASE_POOL_SIZE: int(10),
  REDIS_URL: z.string().min(1),

  // OIDC (§64). Identity is delegated; Oolix stores only the subject claim.
  OIDC_ISSUER_URL: z.string().url(),
  OIDC_CLIENT_ID: z.string().min(1),
  OIDC_AUDIENCE: z.string().min(1).default('oolix-api'),

  AWS_REGION: z.string().default('ap-south-1'),
  AWS_ENDPOINT_URL: z.string().url().optional(),
  S3_CREATIVE_BUCKET: z.string().default('oolix-creatives-local'),
  CDN_PUBLIC_BASE_URL: z.string().default('http://localhost:4566/oolix-creatives-local'),
  SQS_DOMAIN_EVENTS_URL: z.string().optional(),
  SQS_REPORTING_URL: z.string().optional(),

  // Manifest signing (§75).
  MANIFEST_SIGNING_KEY_ID: z.string().default('local-es256-key-1'),
  MANIFEST_SIGNING_PRIVATE_KEY_PATH: z.string().default('./.keys/manifest-signing-local.pem'),
  MANIFEST_JWKS_PATH: z.string().default('./.keys/manifest-jwks-local.json'),
  MANIFEST_ISSUER: z.string().url().default('http://localhost:4000'),
  MANIFEST_AUDIENCE: z.string().default('oolix-partner-agent'),
  MANIFEST_CONFIG_TTL_SEC: int(900),

  // Agent workload auth (§92).
  AGENT_TOKEN_ISSUER: z.string().url().default('http://localhost:4000'),
  AGENT_TOKEN_AUDIENCE: z.string().default('oolix-agent-api'),
  AGENT_ACCESS_TOKEN_TTL_SEC: int(900),
  AGENT_BOOTSTRAP_TOKEN_TTL_SEC: int(900),

  CLICK_TOKEN_TTL_DAYS: int(7),

  // Catalogue anti-differencing (§72).
  CATALOG_MIN_REACH: int(1000),
  CATALOG_BUCKET_PUBLICATION_INTERVAL_HOURS: int(24),

  CONTROL_SYNC_INTERVAL_SEC: int(30),
  CONTROL_STALE_GRACE_SEC: int(900),

  // Approval SLA (§101).
  PARTNER_REQUEST_EXPIRY_DAYS: int(7),
  PARTNER_REQUEST_EXTENSION_MAX_DAYS: int(7),

  // Reconciliation tolerance (§77.3).
  RECONCILIATION_MIN_EVENTS: int(10),
  RECONCILIATION_PERCENT: z
    .union([z.number(), z.string()])
    .transform((v) => Number(v))
    .default(0.5),

  // §15, §16, §84: external channels stay off until eligibility is proven.
  FEATURE_META_ENABLED: bool.default(false),
  FEATURE_GOOGLE_ENABLED: bool.default(false),
});

export type OolixConfig = z.infer<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): OolixConfig {
  const parsed = ConfigSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration (spec §65.1):\n${issues}`);
  }
  return parsed.data;
}

export const CONFIG = Symbol('OOLIX_CONFIG');
