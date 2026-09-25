/**
 * Seed safety and schema invariants (§54, §73, §95).
 *
 * §95: "Production intentionally unsupported: pnpm db:seed --env=production ->
 * command must refuse." The refusal is tested by running the real command,
 * because the guarantee is about the COMMAND, not about a function someone
 * could stop calling.
 *
 * The schema assertions read `schema.prisma` rather than a live database, so
 * they run in the fast unit gate and catch a forbidden table in review rather
 * than after it has been migrated.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const schemaSource = readFileSync(path.join(packageRoot, 'prisma/schema.prisma'), 'utf8');

// Comments in schema.prisma state the very rules under test ("No column
// anywhere stores a partner_user_id"), so assertions run against declarations
// only. Otherwise documenting a rule would break the test that enforces it.
const schema = schemaSource
  .split(/\r?\n/)
  .filter((line) => !line.trimStart().startsWith('//'))
  .join('\n');

/** Run the seed command exactly as a developer or CI job would. */
function seed(env: string, extraEnv: Record<string, string> = {}) {
  // Node refuses to spawn a `.cmd` directly, and `shell: true` concatenates
  // arguments unescaped (DEP0190). `cmd /c` with a real argument array avoids
  // both.
  const args = ['db:seed', `--env=${env}`];
  const [command, argv] =
    process.platform === 'win32'
      ? (['cmd', ['/c', 'pnpm', ...args]] as const)
      : (['pnpm', args] as const);

  return spawnSync(command, [...argv], {
    cwd: packageRoot,
    encoding: 'utf8',
    // A real DATABASE_URL is deliberately absent: a refusal must happen before
    // anything connects. If the guard ever moved after the connection, this
    // test would start failing for a different reason -- which is also useful.
    env: { ...process.env, DATABASE_URL: '', ...extraEnv },
  });
}

describe('db:seed environment guard (§95)', () => {
  it('refuses to seed production', () => {
    const result = seed('production');
    expect(result.status).not.toBe(0);
    // Seeding production would create synthetic organizations that look real
    // in billing and reporting.
    expect(`${result.stderr}${result.stdout}`).toMatch(/REFUSED/i);
  }, 60_000);

  it('refuses the "prod" spelling too', () => {
    const result = seed('prod');
    expect(result.status).not.toBe(0);
  }, 60_000);

  it('refuses an environment it does not recognise', () => {
    // Failing closed matters more than convenience here: a typo must not fall
    // back to a default that happens to be writable.
    const result = seed('prodution');
    expect(result.status).not.toBe(0);
  }, 60_000);

  // Staging is reachable by more people than its testers, so its seeded
  // accounts must not share the well-known development password.
  it('refuses staging without a password of its own', () => {
    const result = seed('staging', { SEED_USER_PASSWORD: '' });
    expect(result.status).not.toBe(0);
    expect(`${result.stderr}${result.stdout}`).toMatch(/REFUSED[\s\S]*SEED_USER_PASSWORD/);
  }, 60_000);

  it('refuses a staging password the sign-up policy would refuse', () => {
    const result = seed('staging', { SEED_USER_PASSWORD: 'password' });
    expect(result.status).not.toBe(0);
    expect(`${result.stderr}${result.stdout}`).toMatch(/REFUSED/);
  }, 60_000);
});

describe('Central schema holds no customer data (§54, §73)', () => {
  const models = [...schema.matchAll(/^model\s+(\w+)\s*\{/gm)].map((m) => m[1]!);
  const mappedTables = [...schema.matchAll(/@@map\("([^"]+)"\)/g)].map((m) => m[1]!);

  it('declares none of the tables §73 forbids', () => {
    // §73: "Do NOT create these tables in Oolix Cloud." Each one would mean
    // Oolix had become the customer-data holder the design exists to avoid.
    const forbidden = [
      'customers',
      'audience_members',
      'segment_members',
      'partner_transactions',
      'cross_partner_identity',
    ];
    expect(mappedTables.filter((t) => forbidden.includes(t))).toEqual([]);

    const forbiddenModels = ['Customer', 'AudienceMember', 'SegmentMember', 'CrossPartnerIdentity'];
    expect(models.filter((m) => forbiddenModels.includes(m))).toEqual([]);
  });

  it('has no partner_user_id field anywhere (§54)', () => {
    // The Partner's own user identifier never leaves the Partner. Not in a
    // token, not in a report, and above all not in a column.
    expect(schema).not.toMatch(/partner_user_id/);
    expect(schema).not.toMatch(/partnerUserId/);
  });

  it('stores no exact segment reach (§72)', () => {
    // §72 publishes a BUCKET. A column holding the exact count would let reach
    // be differenced across refreshes back to individual membership changes.
    expect(schema).not.toMatch(/reachExact|reach_exact|exactReach/);
    expect(schema).toMatch(/reachBucket/);
  });

  it('stores attribution tokens only as a hash (§90)', () => {
    const model = /model AttributionToken \{[\s\S]*?\n\}/.exec(schema)?.[0] ?? '';
    expect(model).toMatch(/tokenHash\s+Bytes/);
    // A column that could hold the raw token is the whole vulnerability.
    expect(model).not.toMatch(/^\s+token\s+String/m);
    expect(model).not.toMatch(/clickToken/);
  });
});
