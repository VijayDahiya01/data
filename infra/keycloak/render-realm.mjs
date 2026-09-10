#!/usr/bin/env node
/**
 * Render the Keycloak realm import for one deployment -- spec §17, §65.1.
 *
 * Keycloak does not substitute environment variables inside a realm import, so
 * a checked-in file can only ever describe one environment. Everything that
 * must differ is a `${env.NAME}` placeholder filled in here.
 *
 * # Why this is a script and not a sed line
 *
 * It used to be sed, and sed was fine for URLs. It is not fine for the thing
 * that matters most: the realm shipped THIRTEEN development identities with
 * the password `password`, one of which (`demo@example.test`) holds
 * OOLIX_ADMIN plus every Partner role. That file is imported into production
 * unchanged, so a public repository was publishing a full-access account for
 * every deployment.
 *
 * Users now live in `dev-users.json` and are merged in ONLY when seeding is
 * explicitly requested. Production is safe by construction rather than by
 * remembering: the realm file itself contains no users at all, so forgetting
 * to set a flag leaves you with none rather than with thirteen.
 *
 * It also validates the result. A realm that fails to parse takes Keycloak
 * down at start-up with an error that does not mention the substitution, and
 * an unsubstituted placeholder produces "Invalid client oolix-web: A redirect
 * URI is not a valid URI" -- true, and unhelpful.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const SRC = process.env.REALM_SRC ?? '/src/oolix-realm.json';
const USERS = process.env.REALM_DEV_USERS ?? '/src/dev-users.json';
const OUT = process.env.REALM_OUT ?? '/out/oolix-realm.json';

/**
 * Every placeholder, and whether a deployment may leave it unset.
 *
 * A required value with no default is the point: the client secret used to be
 * a literal, and defaulting it here would put the literal back.
 */
const SUBSTITUTIONS = [
  { name: 'WEB_PUBLIC_URL', required: true },
  { name: 'KEYCLOAK_PUBLIC_URL', required: true },
  { name: 'OIDC_CLIENT_SECRET', required: true, secret: true },
  { name: 'KC_SSL_REQUIRED', required: false, fallback: 'external' },
  { name: 'KC_PASSWORD_POLICY', required: false, fallback: '' },
  { name: 'KC_DIRECT_GRANTS', required: false, fallback: 'false' },
];

let realm = readFileSync(SRC, 'utf8');
const missing = [];

for (const { name, required, fallback } of SUBSTITUTIONS) {
  const value = process.env[name];
  if (value === undefined || value === '') {
    if (required) {
      missing.push(name);
      continue;
    }
    realm = realm.split(`\${env.${name}}`).join(fallback ?? '');
    continue;
  }
  realm = realm.split(`\${env.${name}}`).join(value);
}

if (missing.length > 0) {
  console.error(`realm render: these are required and were not set: ${missing.join(', ')}`);
  process.exit(1);
}

const leftover = /\$\{env\.([A-Z_]+)\}/.exec(realm);
if (leftover) {
  console.error(`realm render: placeholder \${env.${leftover[1]}} was never substituted`);
  process.exit(1);
}

let doc;
try {
  doc = JSON.parse(realm);
} catch (err) {
  console.error(`realm render: the rendered realm is not valid JSON: ${err.message}`);
  process.exit(1);
}

// --- types the realm import needs, which substitution cannot preserve --------
//
// The template stays valid JSON, so every editor and linter can read it, which
// means the placeholder has to sit inside quotes. Keycloak needs a real
// boolean: given the string "false" it does not complain, it enables the
// password grant -- a non-empty string being truthy. So the coercion happens
// here, explicitly, on the fields that are booleans.
for (const client of doc.clients ?? []) {
  for (const field of [
    'directAccessGrantsEnabled',
    'standardFlowEnabled',
    'implicitFlowEnabled',
    'serviceAccountsEnabled',
    'publicClient',
  ]) {
    const v = client[field];
    if (typeof v === 'string') {
      if (v !== 'true' && v !== 'false') {
        console.error(`realm render: ${client.clientId}.${field} is "${v}", not true or false`);
        process.exit(1);
      }
      client[field] = v === 'true';
    }
  }
}

// --- development identities --------------------------------------------------
//
// Off unless asked for, in as many words. `KC_SEED_USERS` has to be the exact
// string "true": a typo, an empty value, or an unset variable all mean no
// users, which is the only safe way for this to fail.
if (process.env.KC_SEED_USERS === 'true') {
  const users = JSON.parse(readFileSync(USERS, 'utf8'));
  doc.users = users;
  console.log(
    `realm render: SEEDED ${users.length} development identities -- never do this in production`,
  );
} else {
  doc.users = [];
}

// --- refuse to render something obviously unsafe -----------------------------
//
// Checked here rather than trusted from the caller, because this is the last
// point at which anything looks at the realm before Keycloak imports it.
const web = doc.clients?.find((c) => c.clientId === 'oolix-web');
if (!web) {
  console.error('realm render: the oolix-web client is missing');
  process.exit(1);
}
if (!web.secret || web.secret.length < 16) {
  console.error('realm render: the oolix-web client secret is missing or too short');
  process.exit(1);
}
if (doc.users.length > 0 && doc.sslRequired === 'external') {
  // Seeded identities carry a known password. If TLS is being enforced this is
  // not a laptop, and the two together are the shape of a mistake.
  console.error(
    'realm render: refusing to seed development identities into a realm that requires TLS',
  );
  process.exit(1);
}

writeFileSync(OUT, `${JSON.stringify(doc, null, 2)}\n`);
console.log(
  `realm render: ${doc.realm} for ${process.env.WEB_PUBLIC_URL} ` +
    `(sslRequired=${doc.sslRequired}, users=${doc.users.length})`,
);
