#!/usr/bin/env node
/**
 * Re-open local identities for binding after Keycloak has been recreated.
 *
 * DEVELOPMENT ONLY. It refuses to run against production.
 *
 * # The symptom
 *
 * Every authenticated call returns 401 with "This email is already bound to a
 * different identity", and it appears immediately after the local Keycloak was
 * reset, its realm re-imported, or its volume removed.
 *
 * # Why it happens, and why the refusal is right
 *
 * Oolix binds a user row to the OIDC subject that first signed in. Recreating
 * Keycloak issues brand new subject ids for the same email addresses, so the
 * subject presented no longer matches the one stored. Silently accepting the
 * new one would mean an email address is enough to take over an existing
 * account -- which is exactly the takeover the check exists to prevent. The
 * refusal is correct and stays.
 *
 * What is safe locally is to return the affected rows to `pending:`, which is
 * the state a freshly invited user is in, so the next sign-in binds normally.
 * That is only safe because these are seeded identities on a laptop.
 *
 *   node scripts/rebind-identities.mjs
 */
import pg from 'pg';

const DB =
  process.env.DATABASE_URL ?? 'postgresql://oolix:oolix@localhost:5432/oolix?schema=public';

const appEnv = process.env.APP_ENV ?? 'development';
if (appEnv === 'production' || appEnv === 'prod') {
  console.error(
    '\nREFUSED: this unbinds every user from their identity provider account.\n' +
      'In production that is an account takeover waiting to happen, not a fix.\n',
  );
  process.exit(1);
}

// A second guard, because APP_ENV is easy to get wrong: a production database
// would not be reachable at a localhost default, and a real deployment names
// its host.
if (!/localhost|127\.0\.0\.1/.test(DB)) {
  console.error(
    `\nREFUSED: ${DB.replace(/:\/\/[^@]*@/, '://***@')} does not look local.\n` +
      'This script is for a development database only.\n',
  );
  process.exit(1);
}

const db = new pg.Client({ connectionString: DB });
await db.connect();

try {
  const before = await db.query(
    `SELECT count(*)::int AS n FROM users WHERE auth_subject NOT LIKE 'pending:%'`,
  );
  if (before.rows[0].n === 0) {
    console.log('\nNothing to do: every identity is already awaiting a first sign-in.\n');
  } else {
    await db.query(
      `UPDATE users SET auth_subject = 'pending:' || lower(email)
        WHERE auth_subject NOT LIKE 'pending:%'`,
    );
    console.log(
      `\n${before.rows[0].n} identit${before.rows[0].n === 1 ? 'y' : 'ies'} re-opened. ` +
        'The next sign-in binds them to the new Keycloak subjects.\n',
    );
  }
} finally {
  await db.end();
}
