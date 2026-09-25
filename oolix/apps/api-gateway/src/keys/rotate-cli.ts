/**
 * Rotate and retire signing keys (§75, §92.3).
 *
 * The rotation logic already existed and nothing called it, which meant the
 * key that signs every activation manifest had never been changed and had no
 * documented way to change. A capability with no operator entry point is not a
 * capability.
 *
 *   pnpm keys:list
 *   pnpm keys:rotate manifest
 *   pnpm keys:retire manifest --after 24h
 *
 * Rotation is deliberately two steps, a day apart. §75 requires the new public
 * key to be published and accepted alongside the old one for 24 hours before
 * the old one goes away; doing both at once would invalidate every manifest an
 * Agent had already cached.
 */
import { loadFileSecrets } from '@oolix/runtime-config';
import { loadDotEnv } from '../config/load-env.js';
import { FileKeyStore } from './key-store.js';

loadDotEnv();
loadFileSecrets();

type Purpose = 'manifest' | 'agent-token' | 'user-session';

const PURPOSES: Purpose[] = ['manifest', 'agent-token', 'user-session'];

function storePath(purpose: Purpose): string {
  if (purpose === 'manifest') {
    // Must match the default in configuration.ts. A different default here
    // provisions a key file the service never opens.
    const jwks = process.env.MANIFEST_JWKS_PATH ?? './.keys/manifest-jwks-local.json';
    return jwks.replace(/\.json$/, '') + '.keyfile.json';
  }
  // Must match USER_SESSION_KEY_PATH in user-key.service.ts, for the same reason.
  if (purpose === 'user-session') return './.keys/user-session.keyfile.json';
  return './.keys/agent-token.keyfile.json';
}

/** Accepts `24h`, `30m`, `7d`, or a bare number of hours. */
function parseDuration(text: string): number {
  const m = /^(\d+)\s*([mhd])?$/.exec(text.trim());
  if (!m) throw new Error(`cannot read a duration from ${JSON.stringify(text)}; try 24h`);
  const n = Number(m[1]);
  const unit = m[2] ?? 'h';
  const ms = { m: 60_000, h: 3_600_000, d: 86_400_000 }[unit as 'm' | 'h' | 'd'];
  return n * ms;
}

function purposeArg(value: string | undefined): Purpose {
  if (PURPOSES.includes(value as Purpose)) return value as Purpose;
  throw new Error(`purpose must be one of ${PURPOSES.join(', ')}; got ${value ?? '(nothing)'}`);
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);

  if (command === 'init') {
    const purpose = purposeArg(rest[0]);
    const store = await FileKeyStore.load(storePath(purpose), purpose);
    console.log(`${purpose} key ready: ${store.activeKid()}`);
    console.log(`  ${store.filePath}`);
    return;
  }

  if (command === 'list') {
    for (const purpose of PURPOSES) {
      const store = await FileKeyStore.load(storePath(purpose), purpose);
      console.log(`\n${purpose}  (${storePath(purpose)})`);
      for (const k of store.inventory()) {
        const age = Math.floor((Date.now() - new Date(k.created_at).getTime()) / 3_600_000);
        console.log(`  ${k.active ? '*' : ' '} ${k.kid.padEnd(34)} ${age}h old`);
      }
    }
    console.log('\n* = currently signing\n');
    return;
  }

  if (command === 'rotate') {
    const purpose = purposeArg(rest[0]);
    const store = await FileKeyStore.load(storePath(purpose), purpose);
    const kid = await store.rotate(purpose);
    console.log(`New ${purpose} key is active: ${kid}`);
    console.log(
      'The previous key is still published and still accepted. Retire it no\n' +
        'sooner than 24 hours from now (§75), once every Agent has re-fetched\n' +
        `the JWKS:\n\n  pnpm keys:retire ${purpose} --after 24h\n`,
    );
    return;
  }

  if (command === 'retire') {
    const purpose = purposeArg(rest[0]);
    const idx = rest.indexOf('--after');
    const window = idx >= 0 ? parseDuration(rest[idx + 1] ?? '') : parseDuration('24h');
    const store = await FileKeyStore.load(storePath(purpose), purpose);
    const removed = await store.retire(window);
    if (removed.length === 0) {
      console.log(`Nothing to retire: no superseded ${purpose} key is older than the window.`);
      return;
    }
    console.log(`Retired ${removed.length} ${purpose} key(s): ${removed.join(', ')}`);
    console.log('They are gone from the JWKS. Anything still signed by them now fails.');
    return;
  }

  console.error(
    'usage:\n' +
      '  keys list\n' +
      '  keys rotate <manifest|agent-token>\n' +
      '  keys retire <manifest|agent-token> [--after 24h]\n',
  );
  process.exitCode = 1;
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
