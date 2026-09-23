/**
 * Log redaction -- spec v5 §23, §56, §78.1, §82.
 *
 * §78.1 lists what must never be logged:
 *   customer email/phone/mobile ID, Partner raw user ID, raw click token,
 *   OAuth secrets, DB passwords, external matching payloads.
 *
 * and adds the reason this module exists rather than a code-review rule:
 *   "Use explicit redaction middleware and field allow-lists rather than
 *    relying only on developer discipline."
 *
 * This is defence in depth. The architecture already keeps partner_user_id out
 * of Oolix entirely (§3), so a hit here means something upstream is wrong --
 * the counter exposed by {@link redactionHits} is deliberately alertable.
 */

/** Field names scrubbed anywhere they appear, at any depth. */
export const REDACTED_FIELDS: readonly string[] = [
  // Partner customer identity -- must never reach the control plane at all.
  'partner_user_id',
  'partnerUserId',
  'user_id_hash',
  'email',
  'phone',
  'mobile_id',
  'mobileId',
  'madid',
  'idfa',
  'gaid',
  // Attribution: §90 forbids the raw token in logs; the hash is safe.
  'click_token',
  'clickToken',
  'token',
  'bootstrap_token',
  'bootstrapToken',
  // Credentials.
  'password',
  'secret',
  'client_secret',
  'clientSecret',
  'access_token',
  'accessToken',
  'refresh_token',
  'refreshToken',
  'authorization',
  'api_key',
  'apiKey',
  'private_key',
  'privateKey',
  'dsn',
  'database_url',
  'DATABASE_URL',
  // External channel matching payloads (§17, §47).
  'matching_payload',
  'hashed_identifiers',
  'user_identifiers',
];

const REDACTED_SET = new Set(REDACTED_FIELDS.map((f) => f.toLowerCase()));

export const REDACTED_PLACEHOLDER = '[REDACTED]';

let hits = 0;

/** How many fields have been redacted since process start. Alert if non-zero. */
export function redactionHits(): number {
  return hits;
}

export function resetRedactionHits(): void {
  hits = 0;
}

/**
 * Recursively redact sensitive fields.
 *
 * Cycles are handled with a seen-set: a log call must never hang the process,
 * and request/response objects routinely contain circular references.
 */
export function redact<T>(value: T, maxDepth = 8): T {
  return redactInner(value, maxDepth, new WeakSet()) as T;
}

function redactInner(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (depth <= 0) return '[TRUNCATED]';

  if (seen.has(value as object)) return '[CIRCULAR]';
  seen.add(value as object);

  if (Array.isArray(value)) {
    return value.map((v) => redactInner(v, depth - 1, seen));
  }

  // Buffers/typed arrays are almost always hashes or binary; do not expand.
  if (ArrayBuffer.isView(value)) return `[BINARY ${(value as ArrayBufferView).byteLength}B]`;

  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  if (value instanceof Date) return value.toISOString();

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (REDACTED_SET.has(k.toLowerCase())) {
      out[k] = REDACTED_PLACEHOLDER;
      hits += 1;
      continue;
    }
    out[k] = redactInner(v, depth - 1, seen);
  }
  return out;
}

/**
 * Safe prefix of a token hash for correlating support reports.
 *
 * §71: "Log only token_hash prefix, never the raw token." Eight hex characters
 * is enough to correlate within one campaign and far too little to brute-force
 * back to a 32-byte token.
 */
export function tokenHashPrefix(tokenHash: Uint8Array | Buffer): string {
  return Buffer.from(tokenHash).subarray(0, 4).toString('hex');
}

/**
 * §53 / §82: PII must never appear in a URL, because URLs land in access logs,
 * proxy logs and browser history. Used by the HTTP layer to scrub paths and
 * query strings before they are logged.
 */
export function redactUrl(rawUrl: string): string {
  try {
    const u = new URL(rawUrl, 'http://placeholder.invalid');
    for (const key of [...u.searchParams.keys()]) {
      if (REDACTED_SET.has(key.toLowerCase())) u.searchParams.set(key, REDACTED_PLACEHOLDER);
    }
    return u.pathname + (u.search || '');
  } catch {
    return '[UNPARSEABLE_URL]';
  }
}
