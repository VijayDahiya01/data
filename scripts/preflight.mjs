#!/usr/bin/env node
/**
 * The check to run before a real Partner's data is involved.
 *
 * Everything here is a mistake that a deployment does not notice. A stack with
 * placeholder alert webhooks is healthy, green, and silent. A stack whose
 * email sender Brevo has not verified accepts every sign-up and never delivers
 * one confirmation -- sign-up answers the same either way, by design. A stack
 * on `IMAGE_TAG=latest` cannot be rolled back, and nobody discovers that until
 * the moment they need to.
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
  // Matched on the trailing SEGMENT, not as a substring. `MANIFEST_SIGNING_KEY_ID`
  // contains "KEY" and is not a secret; treating names like it as secrets
  // produced a confident, wrong failure the first time this ran.
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
    if (!seen.has(v)) seen.set(v, k);
    else reused.push(`${seen.get(v)} and ${k}`);
  }
  if (reused.length > 0) fail('each secret is distinct', reused.join('; '));
  else pass('each secret is distinct');
}

// ---------------------------------------------------------------------------
console.log('\n2. Sign-in and email');

if (env) {
  // APP_ENV is not a label. Content-Security-Policy and HSTS (bootstrap.ts)
  // are switched on by the exact string "production" and by nothing else.
  // `staging` therefore serves a public deployment without either while every
  // other check on this page passes -- the most expensive way to be wrong
  // here, because nothing about the running stack looks any different.
  if (env.APP_ENV === 'production') {
    pass('APP_ENV enables the production protections', 'CSP and HSTS');
  } else {
    fail(
      'APP_ENV enables the production protections',
      `APP_ENV=${env.APP_ENV ?? '(unset)'} leaves Content-Security-Policy and HSTS off. ` +
        'Only the exact string "production" turns them on.',
    );
  }

  // Sign-up, invitations and password resets all arrive by email. The API
  // refuses to start without a real provider, but finding out here is cheaper
  // than finding out from a crash-looping container.
  const provider = env.EMAIL_PROVIDER || 'brevo';
  if (provider === 'brevo') pass('email is really delivered', 'Brevo');
  else {
    fail(
      'email is really delivered',
      `EMAIL_PROVIDER=${provider} never delivers anything, so nobody could confirm an ` +
        'address, accept an invitation or reset a password. Use brevo.',
    );
  }

  // Brevo issues two kinds of key from the same page. An SMTP key is refused
  // by the HTTP API with a 401, and every email fails -- after sign-up has
  // already told the person to go and check their inbox.
  const brevoKey = env.BREVO_API_KEY ?? '';
  if (brevoKey.startsWith('xsmtpsib-')) {
    fail(
      'BREVO_API_KEY is an API key',
      'that is an SMTP key (xsmtpsib-...). In Brevo: SMTP & API -> API Keys -> Generate a new API key.',
    );
  } else if (brevoKey && !brevoKey.startsWith('xkeysib-')) {
    warn('BREVO_API_KEY looks like a Brevo API key', 'Brevo API keys start with xkeysib-.');
  } else if (brevoKey) {
    pass('BREVO_API_KEY is an API key');
  }

  // Brevo refuses to send from an address it has not verified.
  const from = env.EMAIL_FROM ?? '';
  const fromAddress = (/<\s*([^>]+?)\s*>/.exec(from)?.[1] ?? from).trim().toLowerCase();
  const fromDomain = fromAddress.split('@')[1] ?? '';
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(fromAddress)) {
    fail(
      'EMAIL_FROM is a sender address',
      `"${from}" -- write it as  Oolix <no-reply@yourdomain.com>`,
    );
  } else if (/(^|\.)(localhost|example\.(com|org|net|test)|invalid|test)$/.test(fromDomain)) {
    fail('EMAIL_FROM is a real sender', `${fromAddress} is a placeholder; Brevo will refuse it.`);
  } else if (
    /^(gmail|googlemail|yahoo|ymail|outlook|hotmail|live|msn|icloud|aol|proton|protonmail|rediffmail)\./.test(
      fromDomain,
    )
  ) {
    // Mail "from" a free-mail domain, sent by Brevo's servers, fails that
    // domain's DMARC check -- so it lands in spam, or is not delivered at all.
    warn(
      'EMAIL_FROM is on a domain you control',
      `${fromDomain} publishes DMARC that Brevo cannot pass, so these emails will land in spam. ` +
        'Verify your own domain in Brevo and send from an address on it.',
    );
  } else {
    pass('EMAIL_FROM is a real sender', fromAddress);
  }

  if (env.PASSWORD_BREACH_CHECK === 'false') {
    warn(
      'new passwords are checked against known breaches',
      'PASSWORD_BREACH_CHECK=false lets people choose a password that is already on attack lists.',
    );
  } else {
    pass('new passwords are checked against known breaches');
  }

  // Nothing reads these any more. Left in the file, they suggest a service
  // that is not there and a secret that still matters.
  const leftovers = Object.keys(env).filter((k) => /^(KEYCLOAK_|OIDC_|KC_)|^AUTH_HOST$/.test(k));
  if (leftovers.length > 0) {
    warn(
      'no settings are left over from Keycloak',
      `${leftovers.join(', ')} -- nothing reads them since sign-in moved into Oolix. Delete them.`,
    );
  }
}

// ---------------------------------------------------------------------------
console.log('\n3. Public addresses and TLS');

if (env) {
  const urls = ['API_PUBLIC_URL', 'WEB_PUBLIC_URL'];
  const notHttps = urls.filter((k) => env[k] && !env[k].startsWith('https://'));
  if (notHttps.length > 0) fail('every public URL is https', notHttps.join(', '));
  else pass('every public URL is https');

  const localhost = urls.filter((k) => env[k] && /localhost|127\.0\.0\.1/.test(env[k]));
  if (localhost.length > 0) {
    fail('no public URL points at localhost', localhost.join(', '));
  } else {
    pass('no public URL points at localhost');
  }

  // Caddy answers on the *_HOST names; the API signs tokens as, and emails
  // links to, the *_PUBLIC_URL ones. If they differ, every link in every email
  // leads somewhere Caddy does not serve.
  const hostOf = (u) => {
    try {
      return new URL(u).host;
    } catch {
      return null;
    }
  };
  const mismatched = [
    ['API_PUBLIC_URL', 'API_HOST'],
    ['WEB_PUBLIC_URL', 'APP_HOST'],
  ].filter(([url, host]) => env[url] && env[host] && hostOf(env[url]) !== env[host]);
  if (mismatched.length > 0) {
    fail(
      'each public URL names the host Caddy serves',
      mismatched.map(([url, host]) => `${url}=${env[url]} but ${host}=${env[host]}`).join('; '),
    );
  } else {
    pass('each public URL names the host Caddy serves');
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
  // What a Partner's `docker compose up` pulls for Partner Connect. Unset, the
  // bundle names the local development image, which no Partner can pull.
  const agentImage = env.PARTNER_AGENT_IMAGE;
  if (!agentImage || agentImage.endsWith(':dev') || agentImage.endsWith(':latest')) {
    warn(
      'PARTNER_AGENT_IMAGE names a released Agent image',
      'Partner Connect bundles would run `' +
        (agentImage || 'oolix/partner-agent:dev') +
        '`. Set ghcr.io/<owner>/<repo>/partner-agent:<sha>.',
    );
  } else {
    pass('PARTNER_AGENT_IMAGE names a released Agent image', agentImage);
  }

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

// The URLs now live in .env.prod and are substituted at deploy time, so this
// checks the values an operator actually set, rather than a file they were
// supposed to remember to edit.
if (env) {
  const hooks = [
    ['ALERT_WEBHOOK_DEFAULT', 'ticket-severity alerts'],
    ['ALERT_WEBHOOK_ONCALL', 'the on-call page'],
  ];
  const bad = [];
  for (const [name, what] of hooks) {
    const v = (env[name] ?? '').trim();
    if (!v) bad.push(`${name} is not set (${what})`);
    else if (!/^https?:\/\//.test(v)) bad.push(`${name} is not an http(s) URL`);
    else if (/example\.(invalid|com|org|net)|REPLACE|CHANGE_?ME|TODO/i.test(v))
      bad.push(`${name} is still a placeholder`);
    else if (/^https?:\/\/(localhost|127\.0\.0\.1)/.test(v))
      // Inside a container this is Alertmanager itself, not the operator's box.
      bad.push(`${name} points at localhost, which inside a container is Alertmanager itself`);
  }
  if (bad.length > 0) {
    fail(
      'alert webhooks are real',
      `${bad.join('; ')} -- every alert would fire into nothing while the dashboard stays green.`,
    );
  } else {
    pass('alert webhooks are real');
  }
}

// The routing file itself must stay a template: a literal URL here is one that
// bypasses the environment entirely.
const amPath = path.resolve(root, 'oolix/infra/monitoring/alertmanager.yml');
if (!existsSync(amPath)) {
  warn('alert routing file exists', amPath);
} else {
  const am = readFileSync(amPath, 'utf8');
  const literals = [...am.matchAll(/url:\s*(\S+)/g)]
    .map((m) => m[1])
    .filter((u) => !u.startsWith('${env.'));
  if (literals.length > 0) {
    fail('alert routing takes its URLs from the environment', `hard-coded: ${literals.join(', ')}`);
  } else {
    pass('alert routing takes its URLs from the environment');
  }
}

// ---------------------------------------------------------------------------
console.log('\n6. Backups');

const backupScript = path.resolve(root, 'oolix/infra/backup/backup.sh');
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
