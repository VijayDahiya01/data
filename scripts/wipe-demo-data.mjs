#!/usr/bin/env node
/**
 * Remove every demo organization, account and transaction from the databases.
 *
 * This is destructive and deliberately so. It leaves exactly two things behind:
 *
 *   _prisma_migrations     the schema's own history. Dropping it would make the
 *                          database claim to be unmigrated and the next
 *                          `prisma migrate deploy` would try to replay
 *                          everything onto a populated schema.
 *
 *   attribute_definitions  the §4 attribute taxonomy. It is the product's own
 *                          vocabulary — `age`, `purchase_category`, their
 *                          operators and allowed values — not demo data. A
 *                          Buyer cannot describe an audience without it and a
 *                          Partner cannot declare a capability against it, so
 *                          removing it would leave an empty product rather than
 *                          a clean one.
 *
 * Everything else goes: organizations, users, brands, networks, segments,
 * placements, campaigns, requests, activations, audiences, estimates,
 * creatives, agents, payouts and the audit trail of all of it.
 *
 * TRUNCATE ... CASCADE rather than DELETE: the tables reference each other
 * heavily and ordering the deletes by hand would be fragile the moment the
 * schema changes.
 *
 * Usage: node scripts/wipe-demo-data.mjs --yes
 */
import pg from 'pg';

const OOLIX_DB =
  process.env.DATABASE_URL ?? 'postgresql://oolix:oolix@localhost:5432/oolix?schema=public';
const PARTNER_DB =
  process.env.PARTNER_DATABASE_URL ??
  'postgresql://partner:partner@localhost:5433/partner_audience';

/** Kept because they are schema or product vocabulary, not demo content. */
const KEEP = new Set(['_prisma_migrations', 'attribute_definitions']);

if (!process.argv.includes('--yes')) {
  console.log('Refusing to run without --yes. This deletes all data.');
  process.exit(1);
}

async function wipe(label, connectionString, keep) {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    const { rows } = await client.query(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`,
    );
    const targets = rows.map((r) => r.tablename).filter((t) => !keep.has(t));
    if (targets.length === 0) {
      console.log(`${label}: nothing to wipe`);
      return;
    }

    const before = await client.query(
      `SELECT coalesce(sum(n_live_tup), 0)::int AS n FROM pg_stat_user_tables
        WHERE relname = ANY($1::text[])`,
      [targets],
    );

    const quoted = targets.map((t) => `"${t}"`).join(', ');
    await client.query(`TRUNCATE TABLE ${quoted} RESTART IDENTITY CASCADE`);

    console.log(
      `${label}: emptied ${targets.length} tables (~${before.rows[0].n} rows), kept ${[...keep].join(', ')}`,
    );
  } finally {
    await client.end();
  }
}

await wipe('oolix', OOLIX_DB, KEEP);
// The Partner database holds only its own customer data; none of its tables are
// product vocabulary, so all of them go.
await wipe('partner_audience', PARTNER_DB, new Set());

console.log('\nDone. The databases now contain no organizations, accounts or customers.');
