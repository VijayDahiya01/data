#!/usr/bin/env node
/**
 * Point the local stack at this machine's LAN address so other people on the
 * same network can use it — and put it back afterwards.
 *
 * Three things have to agree or sign-in fails in a way that looks like a bug:
 *
 *   1. `WEB_PUBLIC_URL`   where the portal thinks it lives, used to build the
 *                         OIDC redirect back from Keycloak.
 *   2. `OIDC_ISSUER_URL`  Keycloak in dev mode derives a token's issuer from the
 *                         Host header it was called on, and the API validates
 *                         tokens against this value. Reach Keycloak on one
 *                         address while the API expects another and every
 *                         request is rejected as an invalid token.
 *   3. The `oolix-web` client's redirect URIs and web origins, which Keycloak
 *                         checks exactly. An unregistered redirect is refused
 *                         before a password is ever typed.
 *
 * A toggle rather than an edit, because the localhost values are what the
 * verification suites and e2e tests use — sharing is a temporary state.
 *
 * Usage:
 *   node scripts/share-on-lan.mjs --on [--ip 192.168.1.20]
 *   node scripts/share-on-lan.mjs --off
 *   node scripts/share-on-lan.mjs --status
 */
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const ENV = path.join(ROOT, '.env');

const KEYCLOAK_ADMIN = process.env.KEYCLOAK_ADMIN ?? 'admin';
const KEYCLOAK_PASSWORD = process.env.KEYCLOAK_ADMIN_PASSWORD ?? 'admin';
const REALM = 'oolix';

/**
 * Where to reach Keycloak's admin API from THIS machine.
 *
 * Usually localhost, but WSL's port forwarding drops that mapping often enough
 * that it cannot be assumed — the container is fine and `localhost` simply
 * stops resolving to it. `KEYCLOAK_URL` lets the caller point at the VM
 * address instead, which is what the admin API needs regardless of what the
 * browser will eventually use.
 */
const KEYCLOAK_URL = process.env.KEYCLOAK_URL ?? 'http://localhost:8081';
const CLIENT_ID = 'oolix-web';

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const valueOf = (f) => {
  const i = argv.indexOf(f);
  return i === -1 ? null : argv[i + 1];
};

/**
 * The address other machines can actually route to.
 *
 * Deliberately skips virtual adapters: WSL and Hyper-V switches (172.x on
 * `vEthernet`) are visible from this machine and from nowhere else, and are the
 * single most common thing to share by mistake.
 */
function lanAddress() {
  const candidates = [];
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      if (/vEthernet|WSL|Default Switch|Loopback|Bluetooth/i.test(name)) continue;
      if (a.address.startsWith('169.254.')) continue; // link-local, not routable
      candidates.push({ name, address: a.address });
    }
  }
  // Prefer a wireless or ethernet adapter with a private-range address.
  const preferred = candidates.find((c) => /Wi-?Fi|Wireless|Ethernet/i.test(c.name));
  return (preferred ?? candidates[0])?.address ?? null;
}

/**
 * The WSL VM's own address, which is where the container actually listens.
 *
 * Windows reaches it through a proxy that has proved unreliable; forwarding to
 * the VM directly does not depend on it. The address changes when WSL restarts,
 * so the port-proxy rule has to be re-added after a reboot.
 */
function wslIp() {
  try {
    const out = execSync('wsl.exe -d Ubuntu -u root -e hostname -I', { encoding: 'utf8' });
    return out.trim().split(/\s+/)[0] || '127.0.0.1';
  } catch {
    return '127.0.0.1';
  }
}

function readEnv() {
  return readFileSync(ENV, 'utf8');
}

function setEnvValue(text, key, value) {
  const line = new RegExp(`^${key}=.*$`, 'm');
  if (!line.test(text)) throw new Error(`${key} not found in .env`);
  return text.replace(line, `${key}=${value}`);
}

function currentHost(text) {
  const m = /^WEB_PUBLIC_URL=https?:\/\/([^:/]+)/m.exec(text);
  return m?.[1] ?? null;
}

/* --- Keycloak admin ------------------------------------------------------- */

async function adminToken(base) {
  const res = await fetch(`${base}/realms/master/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: 'admin-cli',
      grant_type: 'password',
      username: KEYCLOAK_ADMIN,
      password: KEYCLOAK_PASSWORD,
    }),
  });
  const body = await res.json();
  if (!body.access_token) throw new Error(`Keycloak admin login failed: ${JSON.stringify(body)}`);
  return body.access_token;
}

/** Add or remove one origin from the portal client, leaving the rest alone. */
async function updateClient(base, origin, { add }) {
  const token = await adminToken(base);
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  const found = await fetch(
    `${base}/admin/realms/${REALM}/clients?clientId=${encodeURIComponent(CLIENT_ID)}`,
    { headers },
  ).then((r) => r.json());

  const client = found?.[0];
  if (!client) throw new Error(`client ${CLIENT_ID} not found in realm ${REALM}`);

  const redirect = `${origin}/*`;
  const redirects = new Set(client.redirectUris ?? []);
  const origins = new Set(client.webOrigins ?? []);

  if (add) {
    redirects.add(redirect);
    origins.add(origin);
  } else {
    redirects.delete(redirect);
    origins.delete(origin);
  }

  const res = await fetch(`${base}/admin/realms/${REALM}/clients/${client.id}`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({ ...client, redirectUris: [...redirects], webOrigins: [...origins] }),
  });
  if (!res.ok) throw new Error(`updating client failed: ${res.status} ${await res.text()}`);

  return { redirectUris: [...redirects], webOrigins: [...origins] };
}

/* --- commands ------------------------------------------------------------- */

async function turnOn(ip) {
  const origin = `http://${ip}:3000`;
  let text = readEnv();

  text = setEnvValue(text, 'WEB_PUBLIC_URL', origin);
  text = setEnvValue(text, 'OIDC_ISSUER_URL', `http://${ip}:8081/realms/${REALM}`);
  text = setEnvValue(text, 'API_PUBLIC_URL', `http://${ip}:4000`);
  writeFileSync(ENV, text);
  console.log(`.env      → ${origin}`);

  // Keycloak is still reached on localhost from THIS machine while we edit it.
  const result = await updateClient(KEYCLOAK_URL, origin, { add: true });
  console.log(`keycloak  → redirect ${origin}/*`);
  console.log(`            origins  ${result.webOrigins.join(', ')}`);

  console.log(`\nShare this:  ${origin}/login`);
  console.log('\nTwo commands still need an ADMINISTRATOR PowerShell. Keycloak runs in');
  console.log('Docker inside WSL, so Windows only proxies it to loopback — and that');
  console.log('mapping drops on its own. Forwarding to the VM directly fixes both:\n');
  console.log(
    `  netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=8081 connectaddress=${wslIp()} connectport=8081`,
  );
  console.log(
    `  New-NetFirewallRule -DisplayName "Oolix LAN" -Direction Inbound -Protocol TCP -LocalPort 3000,4000,8081 -Action Allow -Profile Private`,
  );
  console.log('\nThen restart the portal and API so they pick up the new .env.');
}

async function turnOff() {
  let text = readEnv();
  const host = currentHost(text);

  text = setEnvValue(text, 'WEB_PUBLIC_URL', 'http://localhost:3000');
  text = setEnvValue(text, 'OIDC_ISSUER_URL', `http://localhost:8081/realms/${REALM}`);
  text = setEnvValue(text, 'API_PUBLIC_URL', 'http://localhost:4000');
  writeFileSync(ENV, text);
  console.log('.env      → http://localhost:3000');

  if (host && host !== 'localhost') {
    await updateClient(KEYCLOAK_URL, `http://${host}:3000`, { add: false });
    console.log(`keycloak  → removed http://${host}:3000`);
  }

  console.log('\nBack on localhost. Restart the portal and API.');
  console.log('To drop the Windows rules (administrator PowerShell):\n');
  console.log('  netsh interface portproxy delete v4tov4 listenaddress=0.0.0.0 listenport=8081');
  console.log('  Remove-NetFirewallRule -DisplayName "Oolix LAN"');
}

function status() {
  const text = readEnv();
  const host = currentHost(text);
  console.log(`portal host : ${host}`);
  console.log(`detected LAN: ${lanAddress() ?? 'none found'}`);
  console.log(host === 'localhost' ? '\nLocal only.' : `\nShared: http://${host}:3000/login`);
}

const ip = valueOf('--ip') ?? lanAddress();

if (has('--status')) {
  status();
} else if (has('--off')) {
  await turnOff();
} else if (has('--on')) {
  if (!ip) {
    console.error('No routable LAN address found. Pass one explicitly with --ip.');
    process.exit(1);
  }
  await turnOn(ip);
} else {
  console.log('Usage: node scripts/share-on-lan.mjs --on [--ip x.x.x.x] | --off | --status');
  process.exit(1);
}
