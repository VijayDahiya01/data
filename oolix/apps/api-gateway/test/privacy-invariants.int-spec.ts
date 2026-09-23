/**
 * The privacy invariants the whole product rests on (§1, §54, §73).
 *
 * §73 is a hard rule: Oolix holds no customer database. These are schema-level
 * assertions rather than behavioural ones, because the failure they guard
 * against is someone adding a well-intentioned column -- a "partner_user_id"
 * to make debugging easier -- and nobody noticing until it is full of real
 * people.
 */
import { Client } from 'pg';

describe('Central schema holds no customer data (§54, §73)', () => {
  let db: Client;

  beforeAll(async () => {
    db = new Client({ connectionString: process.env.DATABASE_URL });
    await db.connect();
  });

  afterAll(async () => {
    await db?.end();
  });

  it('has none of the forbidden tables', async () => {
    // §73: "Do NOT create these tables in Oolix Cloud." Each one would mean
    // Oolix had become the customer-data holder the design exists to avoid.
    const forbidden = [
      'customers',
      'audience_members',
      'segment_members',
      'partner_transactions',
      'cross_partner_identity',
    ];

    const { rows } = await db.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = ANY($1::text[])`,
      [forbidden],
    );
    expect(rows.map((r) => r.table_name)).toEqual([]);
  });

  it('has no partner_user_id column anywhere', async () => {
    // §54: the Partner's own user identifier never leaves the Partner. Not in
    // a token, not in a report, and above all not in a column.
    const { rows } = await db.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = 'public'
          AND (column_name = 'partner_user_id' OR column_name LIKE '%customer_id%')`,
    );
    expect(rows).toEqual([]);
  });

  it('stores attribution tokens only as a hash (§90)', async () => {
    const { rows } = await db.query<{ column_name: string; data_type: string }>(
      `SELECT column_name, data_type FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'attribution_tokens'`,
    );
    const names = rows.map((r) => r.column_name);

    expect(names).toContain('token_hash');
    // §90: "the raw token is never stored." A column that could hold it is the
    // whole vulnerability.
    expect(names).not.toContain('token');
    expect(names).not.toContain('click_token');
    expect(rows.find((r) => r.column_name === 'token_hash')?.data_type).toBe('bytea');
  });

  it('stores credentials only as hashes (§71, §92.1)', async () => {
    const { rows } = await db.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = 'public'
          AND (column_name LIKE '%api_key%' OR column_name LIKE '%token%' OR column_name LIKE '%secret%')`,
    );

    // Every credential-shaped column must be a hash. §71 and §92.1 both return
    // the plaintext exactly once and keep only the SHA-256.
    const plaintext = rows.filter(
      (r) =>
        !r.column_name.endsWith('_hash') &&
        !r.column_name.includes('token_type') &&
        !r.column_name.endsWith('_at') &&
        !r.column_name.endsWith('_id'),
    );
    expect(plaintext).toEqual([]);
  });

  it('has no per-impression event table (§18, §45)', async () => {
    // §18 uploads AGGREGATES. A central per-impression table would rebuild a
    // behavioural profile out of counters that were meant to stay aggregate.
    const { rows } = await db.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name IN ('impressions', 'impression_events', 'ad_events', 'raw_events')`,
    );
    expect(rows.map((r) => r.table_name)).toEqual([]);
  });
});
