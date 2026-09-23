#!/usr/bin/env node
/**
 * Implementation pack drift check -- Appendix A, spec v5 §86, §95, §96.
 *
 * The pack contains three files that DESCRIBE code rather than being the code:
 * a snapshot of the first migration, a mirror of the seed fixtures, and a
 * README that maps Appendix A onto real paths. Documentation that describes
 * code is worse than no documentation once it drifts, because a reader trusts
 * it. This check makes drift a build failure instead.
 *
 * Usage: node scripts/verify-pack.mjs
 */
import { readFileSync, existsSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = path.resolve(import.meta.dirname, '..');
const pack = path.join(root, 'partner', 'pack');

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
  if (!ok) failures += 1;
  return ok;
};

const read = (p) => readFileSync(p, 'utf8');

console.log('\nImplementation pack verification -- Appendix A\n');

// ---------------------------------------------------------------------------
console.log('1. Every Appendix A artifact resolves to a real file');

const APPENDIX_A = [
  ['.env.example', '.env.example'],
  ['001_init.sql', 'partner/pack/001_init.sql'],
  ['Dockerfile.partner-agent', 'partner/pack/Dockerfile.partner-agent'],
  ['README.md', 'partner/pack/README.md'],
  ['agent-config.example.yaml', 'partner/agent/config.example.yaml'],
  ['docker-compose.yml', 'docker-compose.yml'],
  ['k8s-partner-agent.yaml', 'partner/pack/k8s-partner-agent.yaml'],
  ['openapi.yaml', 'partner/pack/openapi.yaml'],
  ['seed-data.yaml', 'partner/pack/seed-data.yaml'],
  ['agent-auth.md', 'partner/pack/agent-auth.md'],
  ['mock-partner/', 'partner/mock-partner'],
];

for (const [name, rel] of APPENDIX_A) {
  check(name, existsSync(path.join(root, rel)), rel);
}

// ---------------------------------------------------------------------------
console.log('\n2. 001_init.sql is a faithful snapshot (§96)');

const migrationsDir = path.join(root, 'oolix/packages/db/prisma/migrations');
const initDir = readdirSync(migrationsDir)
  .filter((d) => d.endsWith('_init'))
  .sort()[0];

if (!check('the Prisma init migration exists', Boolean(initDir), initDir ?? '(none)')) {
  process.exit(1);
}

const migrationSql = read(path.join(migrationsDir, initDir, 'migration.sql'));
const snapshot = read(path.join(pack, '001_init.sql'));

// The snapshot carries a header explaining what it is. Everything after the
// sentinel must match the migration byte for byte. An explicit sentinel beats
// counting comment lines: it cannot be broken by editing the header.
const SENTINEL = '-- >>> BEGIN VERBATIM SNAPSHOT';
const sentinelAt = snapshot.indexOf(SENTINEL);
const snapshotBody =
  sentinelAt === -1 ? '' : snapshot.slice(sentinelAt + SENTINEL.length).replace(/^\r?\n/, '');

const normalise = (s) => s.replace(/\r\n/g, '\n').trimEnd();
check(
  'the snapshot matches the Prisma migration exactly',
  normalise(snapshotBody) === normalise(migrationSql),
  `${initDir}/migration.sql`,
);

// §54 / §73 read directly off the migrations, so the guarantee is about what
// will actually be created rather than about the Prisma DSL.
//
// EVERY migration, not just the init one. A forbidden table introduced by a
// later migration is exactly as much of a breach as one added on day one, and
// reading only the init snapshot would have let the v6 audience tables through
// unexamined.
const strip = (sql) =>
  sql
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('--'))
    .join('\n');

// Built with `new RegExp` from a plain string rather than a template literal:
// `\\s` inside a template literal is an escape sequence JS resolves to `s`
// BEFORE RegExp ever sees it, which silently turns this guard into a pattern
// that matches nothing. A privacy check that can never fire is worse than no
// check, because it reports PASS.
const createsTable = (table) =>
  new RegExp('CREATE TABLE\\s+(IF NOT EXISTS\\s+)?"?' + table + '"?', 'i');

const allMigrations = readdirSync(migrationsDir)
  .filter((d) => /^\d/.test(d))
  .sort()
  .map((d) => ({ name: d, sql: strip(read(path.join(migrationsDir, d, 'migration.sql'))) }));

check(`every migration is checked (${allMigrations.length} found)`, allMigrations.length > 0);

for (const table of [
  'customers',
  'audience_members',
  'segment_members',
  'partner_transactions',
  'cross_partner_identity',
]) {
  const offender = allMigrations.find((m) => createsTable(table).test(m.sql));
  check(`no migration creates a "${table}" table (§73)`, !offender, offender?.name ?? '');
}

const withUserId = allMigrations.find((m) => /partner_user_id/i.test(m.sql));
check('no migration declares a partner_user_id column (§54)', !withUserId, withUserId?.name ?? '');

// ---------------------------------------------------------------------------
console.log('\n3. seed-data.yaml mirrors the executable seed (§95)');

const seedTs = read(path.join(root, 'oolix/packages/db/prisma/seed/index.ts'));
const seedYaml = read(path.join(pack, 'seed-data.yaml'));

// Every stable id the seed defines must appear in the documented fixture set,
// or the file is describing a system that no longer exists.
const seedIds = [
  ...seedTs.matchAll(/'([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})'/gi),
].map((m) => m[1].toLowerCase());
const uniqueIds = [...new Set(seedIds)];
const missingIds = uniqueIds.filter((id) => !seedYaml.toLowerCase().includes(id));
check(
  'every stable seed id is documented',
  missingIds.length === 0,
  missingIds.length ? missingIds.join(', ') : `${uniqueIds.length} ids`,
);

// And nothing documented may have been deleted from the seed.
const yamlIds = [
  ...seedYaml.matchAll(
    /\b([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\b/gi,
  ),
].map((m) => m[1].toLowerCase());
const stale = [...new Set(yamlIds)].filter((id) => !uniqueIds.includes(id));
check(
  'no documented id has been removed from the seed',
  stale.length === 0,
  stale.length ? stale.join(', ') : '',
);

// The §91 fixtures are named in the spec, so they are checked by name.
for (const fixture of ['RECENT_TRAVELLER_60D', 'PREMIUM_USER', 'booking_success_offer']) {
  check(`the §91 fixture "${fixture}" is documented`, seedYaml.includes(fixture));
}
for (const identity of ['U123', 'U456']) {
  check(`the §95 known identity ${identity} is documented`, seedYaml.includes(identity));
}

// ---------------------------------------------------------------------------
console.log('\n4. The pack README points at files that exist');

const readme = read(path.join(pack, 'README.md'));
const links = [
  ...readme.matchAll(/\]\((\.\.?\/[^)#]+|[A-Za-z0-9_.-]+\.(?:md|yaml|sql|yml))\)/g),
].map((m) => m[1]);
const broken = [...new Set(links)].filter((rel) => !existsSync(path.resolve(pack, rel)));
check(
  'every link resolves',
  broken.length === 0,
  broken.length ? broken.join(', ') : `${new Set(links).size} links`,
);

// ---------------------------------------------------------------------------
console.log('\n5. The pack contains no secrets (§82)');

// A pack is the thing people copy. A real credential in it would be copied too.
const packFiles = readdirSync(pack).filter((f) => !f.startsWith('.'));
for (const file of packFiles) {
  const content = read(path.join(pack, file));
  const suspicious =
    /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/.test(content) ||
    /"d"\s*:\s*"[A-Za-z0-9_-]{20,}"/.test(content) ||
    /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/.test(content);
  check(`${file} carries no private key or live credential`, !suspicious);
}

// ---------------------------------------------------------------------------
console.log(
  failures === 0
    ? '\nImplementation pack verified: all checks passed.\n'
    : `\n${failures} check(s) FAILED.\n`,
);
process.exit(failures === 0 ? 0 : 1);
