#!/usr/bin/env node
/**
 * Run every phase verification in order.
 *
 * Phase 1 deliberately REVOKES Partner A's Agents -- that is the §69.3
 * revocation path under test. Doing so orphans any Agent process already
 * running with the old identity, which is correct behaviour and exactly what
 * an operator would see during incident response.
 *
 * So this runner re-provisions and restarts the Agent between the phases that
 * revoke it and the phases that need it live. Each verify-phaseN script stays
 * independently runnable.
 *
 * Usage: node scripts/verify-all.mjs
 */
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { agentUrl } from './lib/agent-port.mjs';

const isWindows = process.platform === 'win32';
const agentBin = path.join('partner-agent', 'bin', isWindows ? 'oolix-agent.exe' : 'oolix-agent');

let agentProc = null;

function run(cmd, args, opts = {}) {
  const [c, a] = isWindows && !/\.(exe)$/i.test(cmd) ? ['cmd', ['/c', cmd, ...args]] : [cmd, args];
  return spawnSync(c, a, { stdio: 'inherit', ...opts });
}

async function waitFor(url, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

/**
 * Whoever is holding the Agent's port, whatever the process is called.
 *
 * `pnpm agent:run` is `go run ./cmd/agent`, which compiles to a temp binary
 * with a generated name, so killing `oolix-agent.exe` by name misses it
 * entirely. The provisioning script tells you to start the Agent exactly that
 * way, so an Agent this runner cannot see is the normal case, not an exotic
 * one -- and leaving it running is worse than not restarting at all: phase 1
 * revokes it, it keeps the port, and phases 4, 5 and v6-serving then fail
 * against a revoked Agent with errors that read like product bugs.
 */
function pidsOnAgentPort() {
  const port = new URL(agentUrl()).port || '8080';

  const out = isWindows
    ? spawnSync('netstat', ['-ano'], { encoding: 'utf8' }).stdout
    : spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' }).stdout;
  if (!out) return [];

  const pids = new Set();
  for (const line of out.split('\n')) {
    if (isWindows) {
      // "  TCP    0.0.0.0:8082    0.0.0.0:0    LISTENING    13240"
      const m = /\s(?:\d+\.\d+\.\d+\.\d+|\[[^\]]+\]):(\d+)\s+\S+\s+LISTENING\s+(\d+)/.exec(line);
      if (m && m[1] === port) pids.add(m[2]);
    } else {
      const m = /^\S+\s+(\d+)/.exec(line);
      if (m && !line.startsWith('COMMAND')) pids.add(m[1]);
    }
  }
  return [...pids].filter((p) => p !== String(process.pid));
}

function stopAgent() {
  if (agentProc) {
    agentProc.kill();
    agentProc = null;
  } else if (isWindows) {
    spawnSync('taskkill', ['/IM', 'oolix-agent.exe', '/F'], { stdio: 'ignore' });
  } else {
    spawnSync('pkill', ['-f', 'oolix-agent'], { stdio: 'ignore' });
  }

  // Then clear the port regardless of what the process is called.
  for (const pid of pidsOnAgentPort()) {
    console.log(`--- stopping an Agent already on the port (pid ${pid}) ---`);
    if (isWindows) spawnSync('taskkill', ['/PID', pid, '/F'], { stdio: 'ignore' });
    else spawnSync('kill', ['-9', pid], { stdio: 'ignore' });
  }
}

/** Provision a fresh Agent identity and start the binary. */
async function restartAgent() {
  stopAgent();
  await new Promise((r) => setTimeout(r, 1500));

  console.log('\n--- re-provisioning the Partner Agent (§92) ---');
  const prov = run(process.execPath, ['scripts/provision-agent.mjs', '--partner', 'A']);
  if (prov.status !== 0) throw new Error('agent provisioning failed');

  // ALWAYS rebuild. Building only when the binary is missing means a stale
  // Agent from a previous change silently passes the whole suite -- the one
  // failure mode a regression runner must not have.
  console.log('--- building the Agent ---');
  const build = run(
    'go',
    ['build', '-o', path.join('bin', path.basename(agentBin)), './cmd/agent'],
    {
      cwd: 'partner-agent',
    },
  );
  if (build.status !== 0) throw new Error('agent build failed');

  agentProc = spawn(path.resolve(agentBin), ['--config', './config.local.yaml'], {
    cwd: 'partner-agent',
    stdio: 'ignore',
    detached: false,
  });

  // §69.2 draws the distinction this runner needs: /healthz says the process is
  // alive and checks NO dependencies, while /readyz reports whether the
  // connector pool is warm, the control sync has landed and the identity is
  // still valid.
  //
  // Waiting on /healthz plus a fixed sleep was a race, and it lost: a cold
  // connector pool made the first ad decision fail closed with
  // SEGMENT_SOURCE_ERROR, which reads like a broken connector rather than one
  // that had simply not finished starting.
  const ready = await waitFor(`${agentUrl()}/readyz`, 60_000);
  if (!ready) throw new Error('agent did not become ready (see /readyz)');
  console.log('--- Agent is ready ---\n');
}

const phases = [1, 2, 3, 4, 5, 6, 7];
const results = [];

try {
  for (const n of phases) {
    // Phases 4 and 5 need a live Agent, and phase 1 revoked whatever was
    // running. Phase 5 reuses the Agent phase 4 started.
    if (n === 4) await restartAgent();

    console.log(`\n${'='.repeat(70)}\nPHASE ${n}\n${'='.repeat(70)}`);
    const r = run(process.execPath, [`scripts/verify-phase${n}.mjs`]);
    results.push({ phase: n, ok: r.status === 0 });
  }

  // v6 runs after the phases rather than as one of them. It is a CHANGE to the
  // v5 product, so running it here confirms both things at once: the audience
  // flow works, and nothing it changed broke the seven exit criteria above.
  for (const [label, script] of [
    ['v6 control plane', 'scripts/verify-v6.mjs'],
    ['v6 serving', 'scripts/verify-v6-serving.mjs'],
    // External channels last: it is the only phase whose behaviour depends on
    // a feature flag, and it adapts -- with the flag off it verifies §84's
    // refusal, with it on the whole eligibility gate.
    ['external channels', 'scripts/verify-channels.mjs'],
  ]) {
    console.log(`\n${'='.repeat(70)}\n${label.toUpperCase()}\n${'='.repeat(70)}`);
    const r = run(process.execPath, [script]);
    results.push({ phase: label, ok: r.status === 0 });
  }
} finally {
  stopAgent();
}

console.log(`\n${'='.repeat(70)}\nSUMMARY\n${'='.repeat(70)}`);
for (const { phase, ok } of results) {
  console.log(`  phase ${phase}: ${ok ? 'PASS' : 'FAIL'}`);
}

const failed = results.filter((r) => !r.ok);
console.log(
  failed.length === 0
    ? '\nAll phase verifications passed.\n'
    : `\n${failed.length} phase(s) failed.\n`,
);
process.exit(failed.length === 0 ? 0 : 1);
