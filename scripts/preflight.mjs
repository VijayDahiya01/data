#!/usr/bin/env node
/**
 * The check to run before a real Partner's data is involved.
 *
 * Everything here is a mistake that a deployment does not notice. A stack with
 * placeholder alert webhooks is healthy, green, and silent. A stack still
 * seeding development identities lets `demo@example.test` sign in with the
 * password `password`. A stack on `IMAGE_TAG=latest` cannot be rolled back,
 * and nobody discovers that until the moment they need to.
 *
 * None of these are caught by tests, because none of them are wrong in
 * development -- they are wrong only once the deployment is real. So they are
 * checked here, against the configuration a specific deployment will actually
 * use, at the one moment somebody is paying attention.
 *
 *   node scripts/preflight.mjs --env-file .env.prod
 *
 * Exits non-zero if anything would be unsafe. `--warnings-ok` downgrades the
 * advisory findings for a staging rehearsal; the failures never downgrade.
 */
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    'env-file': { type: 'string', default: '.env.prod' },
    'warnings-ok': { type: 'boolean', default: false },
  },
});

const root = process.cwd();
let failures = 0;
let warnings = 0;

function fail(label, detail) {
  console.log(`  FAIL  ${label}`);
  if (detail) console.log(`        ${detail}`);
  failures += 1;
}
function warn(label, detail) {
  console.log(`  WARN  ${label}`);
  if (detail) console.log(`        ${detail}`);
  warnings += 1;
}
function pass(label, detail = '') {
  console.log(`  PASS  ${label}${detail ? `  ${detail}` : ''}`);
}

/** Parse a dotenv file into a map, ignoring comments and blank lines. */
function readEnvFile(file) {
  if (!existsSync(file)) return null;
  const out = {};
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq < 0) continue;
    out[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
  }
  return out;
}

console.log(`\nGo-live preflight -- ${values['env-file']}\n`);

const env = readEnvFile(path.resolve(root, values['env-file']));

// ---------------------------------------------------------------------------
console.log('1. Secrets');

if (!env) {
  fail(
    `${values['env-file']} does not exist`,
    'Copy .env.prod.example and fill in every REQUIRED value.',
  );
} else {
  // Anything the example marks REQUIRED must actually carry a value.
  const exampleText = existsSync(path.resolve(root, '.env.prod.example'))
    ? readFileSync(path.resolve(root, '.env.prod.example'), 'utf8')
    : '';
  const required = [];
  let flagged = false;
  for (const line of exampleText.split('\n')) {
    if (line.includes('REQUIRED')) flagged = true;
    else if (/^[A-Z][A-Z0-9_]*=/.test(line.trim())) {
      if (flagged) required.push(line.trim().split('=')[0]);
      flagged = false;
    } else if (line.trim() === '') flagged = false;
  }

  const blank = required.filter((k) => !env[k]);
  if (blank.length > 0) {
    fail('every REQUIRED value is set', `missing: ${blank.join(', ')}`);
  } else {
    pass('every REQUIRED value is set', `${required.length} checked`);
  }

  // Values that betray a copied placeholder rather than a generated secret.
  // Matched on the trailing SEGMENT, not as a substring. `KEYCLOAK_PUBLIC_URL`
  // contains "KEY" and is not a secret; treating it as one produced a
  // confident, wrong failure the first time this ran.
  const isSecretName = (k) => /_(SECRET|PASSWORD|TOKEN|KEY|CREDENTIAL)$/.test(k);

  const weak = [];
  for (const [k, v] of Object.entries(env)) {
    if (!isSecretName(k)) continue;
    if (!v) continue;
    if (/local-only|changeme|change_me|example|placeholder|password|test|admin|secret$/i.test(v)) {
      weak.push(k);
    } else if (v.length < 16) {
      weak.push(`${k} (only ${v.length} chars)`);
    }
  }
  if (weak.length > 0) {
    fail('no secret is a placeholder or too short', weak.join(', '));
  } else {
    pass('no secret is a placeholder or too short');
  }

  // The same value reused across two different secrets means compromising one
  // compromises both.
  const seen = new Map();
  const reused = [];
  for (const [k, v] of Object.entries(env)) {
    if (!isSecretName(k) || !v) continue;
    if (seen.has(v)) reused.push(`${seen.get(v)} and ${k}`);
    else seen.set(v, k);
  }
  if (reused.length > 0) fail('each secret is distinct', reused.join('; '));
  else pass('each secret is distinct');
}

// ---------------------------------------------------------------------------
console.log('\n2. Identity');

if (env) {
  // The realm renderer refuses this too, but saying so here means an operator
  // finds out before the deploy rather than during it.
  if (env.KC_SEED_USERS === 'true') {
    fail(
      'development identities are NOT seeded',
      'KC_SEED_USERS=true would create demo@example.test with the password `password`, holding OOLIX_ADMIN.',
    );
  } else {
    pass('development identities are not seeded');
  }

  if (env.KC_DIRECT_GRANTS === 'true') {
    fail(
      'the password grant is disabled',
      'KC_DIRECT_GRANTS=true lets anyone with a username and password bypass the browser sign-in.',
    );
  } else {
    pass('the password grant is disabled');
  }

  if (env.KC_SSL_REQUIRED && env.KC_SSL_REQUIRED === 'none') {
    fail('Keycloak requires TLS', 'KC_SSL_REQUIRED=none accepts plain HTTP.');
  } else {
    pass('Keycloak requires TLS', env.KC_SSL_REQUIRED ?? 'external (default)');
  }
}

// ---------------------------------------------------------------------------
console.log('\n3. Public addresses and TLS');

if (env) {
  const urls = ['API_PUBLIC_URL', 'WEB_PUBLIC_URL', 'KEYCLOAK_PUBLIC_URL'];
  const notHttps = urls.filter((k) => env[k] && !env[k].startsWith('https://'));
  if (notHttps.length > 0) fail('every public URL is https', notHttps.join(', '));
  else pass('every public URL is https');

  const localhost = urls.filter((k) => env[k] && /localhost|127\.0\.0\.1/.test(env[k]));
  if (localhost.length > 0) {
    fail('no public URL points at localhost', localhost.join(', '));
  } else {
    pass('no public URL points at localhost');
  }

  if (env.TLS_MODE === 'internal') {
    fail(
      'TLS uses a real certificate authority',
      'TLS_MODE=internal issues from a local CA; browsers will warn and Agents will refuse.',
    );
  } else if (!env.TLS_MODE) {
    warn('TLS_MODE is set', 'unset means the compose default applies');
  } else {
    pass('TLS uses a real certificate authority', env.TLS_MODE);
  }
}

// ---------------------------------------------------------------------------
console.log('\n4. Rollback');

if (env) {
  const tag = env.IMAGE_TAG;
  if (!tag) {
    warn('IMAGE_TAG is pinned', 'unset means the compose default, probably `dev`');
  } else if (['latest', 'dev', 'main'].includes(tag)) {
    fail(
      'IMAGE_TAG is an immutable tag',
      `"${tag}" moves, so rolling back to it rolls back to nothing. Use a commit SHA.`,
    );
  } else {
    pass('IMAGE_TAG is an immutable tag', tag);
  }
}

// ---------------------------------------------------------------------------
console.log('\n5. Alerting');

const amPath = path.resolve(root, 'infra/monitoring/alertmanager.yml');
if (!existsSync(amPath)) {
  warn('alertmanager configuration exists', amPath);
} else {
  const am = readFileSync(amPath, 'utf8');
  // The failure this catches is total silence: every rule fires correctly,
  // into nothing.
  const placeholders = [...am.matchAll(/url:\s*(\S+)/g)]
    .map((m) => m[1])
    .filter((u) => /example\.invalid|example\.com|REPLACE|localhost/.test(u));
  if (placeholders.length > 0) {
    fail(
      'alert webhooks are real',
      `still placeholder: ${placeholders.join(', ')} -- every alert would fire into nothing.`,
    );
  } else {
    pass('alert webhooks are real');
  }

  if (/REPLACE/.test(am)) {
    fail('no REPLACE markers remain in the alert routing');
  } else {
    pass('no REPLACE markers remain in the alert routing');
  }
}

// ---------------------------------------------------------------------------
console.log('\n6. Backups');

const backupScript = path.resolve(root, 'infra/backup/backup.sh');
if (!existsSync(backupScript)) {
  fail('a backup script exists', backupScript);
} else {
  pass('a backup script exists');

  // The stack now schedules backups itself, so the remaining question is where
  // they land. A backup on the same disk as the database survives only the
  // failures that do not matter.
  const dest = env?.BACKUP_DEST;
  if (!dest) {
    fail(
      'BACKUP_DEST points off this host',
      'unset means backups are written to ./backups on the deployment host itself.',
    );
  } else if (/^\.\/|^\.\.\/|^\/(tmp|home|root|var\/tmp)/.test(dest)) {
    fail(
      'BACKUP_DEST points off this host',
      `"${dest}" is local storage. Use an NFS mount, an object-storage gateway, or anything that is not this disk.`,
    );
  } else {
    pass('BACKUP_DEST points off this host', dest);
  }

  // Whether a restore has ever been rehearsed cannot be read from a file.
  warn(
    'one restore has been rehearsed from a real backup',
    'A backup nobody has restored is a hypothesis. See docs/BACKUP-AND-ROLLBACK.md.',
  );
}

// ---------------------------------------------------------------------------
console.log('\n7. External channels');

if (env) {
  const meta = env.FEATURE_META_ENABLED === 'true';
  const google = env.FEATURE_GOOGLE_ENABLED === 'true';
  if (!meta && !google) {
    pass('external channels are off', 'owned media only');
  } else {
    // Enabling these is a decision with a legal dimension, not a config change.
    warn(
      `external channels are ON (${[meta && 'META', google && 'GOOGLE'].filter(Boolean).join(', ')})`,
      'Confirm platform App Review / API access is granted, the account topology is ' +
        'documented, and privacy sign-off covers customer data leaving the Partner boundary.',
    );
  }
}

// ---------------------------------------------------------------------------
console.log(`\n${'-'.repeat(70)}`);
if (failures > 0) {
  console.log(`${failures} BLOCKING issue(s), ${warnings} warning(s).`);
  console.log('Do not put a real Partner behind this deployment yet.\n');
  process.exit(1);
}
if (warnings > 0 && !values['warnings-ok']) {
  console.log(`No blocking issues. ${warnings} warning(s) need a human answer.`);
  console.log('Re-run with --warnings-ok once each has been confirmed.\n');
  process.exit(2);
}
console.log('Preflight passed.\n');
