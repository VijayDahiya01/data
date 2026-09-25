#!/usr/bin/env node
/**
 * Point the local stack at this machine's LAN address so other people on the
 * same network can use it — and put it back afterwards.
 *
 * Two settings follow the address:
 *
 *   1. `WEB_PUBLIC_URL`  the portal's own address. The links in sign-up,
 *                        invitation and password-reset emails are built from
 *                        it, so left on localhost they open on the READER's
 *                        machine, where nothing is running.
 *   2. `API_PUBLIC_URL`  the API's own address, which it also names as the
 *                        issuer of every sign-in token. Changing it signs
 *                        everybody out once; that is expected.
 *
 * Sign-in itself needs nothing else: the portal talks to the API server-side,
 * and the session cookie belongs to whichever address the browser used.
 *
 * A toggle rather than an edit, because the localhost values are what the
 * verification suites and e2e tests use — sharing is a temporary state.
 *
 * Usage:
 *   node scripts/share-on-lan.mjs --on [--ip 192.168.1.20]
 *   node scripts/share-on-lan.mjs --off
 *   node scripts/share-on-lan.mjs --status
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const ENV = path.join(ROOT, '.env');

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

/* --- commands ------------------------------------------------------------- */

function turnOn(ip) {
  const origin = `http://${ip}:3000`;
  let text = readEnv();

  text = setEnvValue(text, 'WEB_PUBLIC_URL', origin);
  text = setEnvValue(text, 'API_PUBLIC_URL', `http://${ip}:4000`);
  writeFileSync(ENV, text);
  console.log(`.env  → ${origin}`);

  console.log(`\nShare this:  ${origin}/login`);
  console.log('\nOne command still needs an ADMINISTRATOR PowerShell, to let the other');
  console.log('machines through the Windows firewall (portal 3000, API 4000):\n');
  console.log(
    '  New-NetFirewallRule -DisplayName "Oolix LAN" -Direction Inbound -Protocol TCP -LocalPort 3000,4000 -Action Allow -Profile Private',
  );
  console.log('\nThen restart the portal and API so they pick up the new .env.');
}

function turnOff() {
  let text = readEnv();

  text = setEnvValue(text, 'WEB_PUBLIC_URL', 'http://localhost:3000');
  text = setEnvValue(text, 'API_PUBLIC_URL', 'http://localhost:4000');
  writeFileSync(ENV, text);
  console.log('.env  → http://localhost:3000');

  console.log('\nBack on localhost. Restart the portal and API.');
  console.log('To drop the firewall rule (administrator PowerShell):\n');
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
  turnOff();
} else if (has('--on')) {
  if (!ip) {
    console.error('No routable LAN address found. Pass one explicitly with --ip.');
    process.exit(1);
  }
  turnOn(ip);
} else {
  console.log('Usage: node scripts/share-on-lan.mjs --on [--ip x.x.x.x] | --off | --status');
  process.exit(1);
}
