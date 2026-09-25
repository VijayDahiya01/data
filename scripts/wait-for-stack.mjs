#!/usr/bin/env node
/**
 * Wait until every local dependency in docker-compose.yml is actually usable.
 *
 * `docker compose ps` reporting "healthy" is not the same as "ready to serve":
 * LocalStack reports healthy before its ready.d hooks finish creating the
 * queues the worker needs. This probes the real endpoints.
 *
 * Usage: node scripts/wait-for-stack.mjs [--timeout 180]
 */
import net from 'node:net';

const args = process.argv.slice(2);
const timeoutSec = Number(args[args.indexOf('--timeout') + 1]) || 180;
const deadline = Date.now() + timeoutSec * 1000;

const checks = [
  { name: 'postgres        (5432)', fn: () => tcp(5432) },
  { name: 'redis           (6379)', fn: () => tcp(6379) },
  { name: 'partner-postgres(5433)', fn: () => tcp(5433) },
  { name: 'partner-redis   (6380)', fn: () => tcp(6380) },
  { name: 'localstack s3+sqs     ', fn: localstackReady },
];

function tcp(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const s = net.connect({ port, host });
    const done = (ok) => {
      s.destroy();
      resolve(ok);
    };
    s.setTimeout(2000);
    s.once('connect', () => done(true));
    s.once('timeout', () => done(false));
    s.once('error', () => done(false));
  });
}

async function localstackReady() {
  try {
    const res = await fetch('http://localhost:4566/_localstack/health', {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return false;
    const body = await res.json();
    // Both services must be running, not merely "available" (= not yet started).
    const s3 = body.services?.s3;
    const sqs = body.services?.sqs;
    return ['running', 'available'].includes(s3) && ['running', 'available'].includes(sqs);
  } catch {
    return false;
  }
}

const pending = new Map(checks.map((c) => [c.name, c.fn]));
const ready = new Set();

process.stdout.write(`Waiting for the Oolix local stack (timeout ${timeoutSec}s)\n`);

while (pending.size > 0) {
  for (const [name, fn] of [...pending]) {
    if (await fn()) {
      ready.add(name);
      pending.delete(name);
      process.stdout.write(`  ok      ${name}\n`);
    }
  }
  if (pending.size === 0) break;

  if (Date.now() > deadline) {
    process.stdout.write('\nTimed out waiting for:\n');
    for (const name of pending.keys()) process.stdout.write(`  MISSING ${name}\n`);
    process.stdout.write('\nTry:  docker compose ps    and    docker compose logs <service>\n');
    process.exit(1);
  }
  await new Promise((r) => setTimeout(r, 2000));
}

process.stdout.write('\nAll dependencies are ready.\n');
