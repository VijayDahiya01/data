/**
 * Sign a seeded account in and return its access token -- the same
 * `POST /v1/auth/login` the portal's sign-in form makes.
 *
 * Local stacks only: every seeded account shares the development password
 * `password` (oolix/packages/db/prisma/seed/index.ts), or SEED_USER_PASSWORD
 * against a seeded staging stack.
 *
 * Sign-in is limited to 10 attempts a minute per address, and every script
 * here runs from the same one. So a token is reused for as long as it has
 * a minute left, and a 429 waits out the Retry-After it names rather than
 * failing a verification run for a reason that has nothing to do with what it
 * verifies.
 */
const DEFAULT_API = process.env.API_PUBLIC_URL ?? process.env.API_URL ?? 'http://localhost:4000';

/** email -> { token, expiresAt } for this process. */
const cache = new Map();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {string} email  a seeded account, e.g. buyer.admin@example.test
 * @param {{ api?: string, password?: string }} [opts]
 * @returns {Promise<string>} a bearer token for the Oolix API
 */
export async function seedToken(email, opts = {}) {
  const api = (opts.api ?? DEFAULT_API).replace(/\/$/, '');
  const password = opts.password ?? process.env.SEED_USER_PASSWORD ?? 'password';
  const key = `${api} ${email}`;

  const kept = cache.get(key);
  if (kept && kept.expiresAt - Date.now() > 60_000) return kept.token;

  for (let attempt = 1; ; attempt += 1) {
    const res = await fetch(`${api}/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const text = await res.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = { raw: text };
    }

    if (res.status === 429 && attempt <= 3) {
      const wait = Math.min(Number(res.headers.get('retry-after')) || 30, 65);
      console.log(`  (sign-in limit reached; waiting ${wait}s before signing in ${email})`);
      await sleep(wait * 1000);
      continue;
    }
    if (!res.ok || !body?.access_token) {
      const why = body?.error ? `${body.error.code}: ${body.error.message}` : text.slice(0, 200);
      throw new Error(`sign-in for ${email} -> ${res.status} ${why}`);
    }

    cache.set(key, {
      token: body.access_token,
      expiresAt: Date.now() + (body.expires_in ?? 600) * 1000,
    });
    return body.access_token;
  }
}

/** Forget a cached token, e.g. after the account's password was changed. */
export function forgetToken(email, opts = {}) {
  const api = (opts.api ?? DEFAULT_API).replace(/\/$/, '');
  cache.delete(`${api} ${email}`);
}
