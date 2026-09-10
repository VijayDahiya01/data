#!/usr/bin/env node
/**
 * Bring up the local dependency stack (spec v5 §65).
 *
 * Cross-platform. On Linux and macOS this is a thin wrapper around
 * `docker compose up -d`.
 *
 * On Windows it additionally handles a Docker-Engine-in-WSL2 setup, which is
 * how this repo was bootstrapped: WSL shuts the VM down when no client is
 * attached, which stops every container and drops open database connections
 * mid-session. So before starting the stack we (a) hold a WSL client open and
 * (b) make sure the daemon is actually running. If Docker Desktop is installed
 * instead, both steps detect that and no-op.
 */
import { spawn, spawnSync } from 'node:child_process';
import process from 'node:process';

const isWindows = process.platform === 'win32';

const SERVICES = [
  'postgres',
  'redis',
  'partner-postgres',
  'partner-redis',
  'localstack',
  'keycloak',
];

/**
 * Node 24 refuses to spawn .cmd/.bat without a shell (the CVE-2024-27980
 * mitigation). On Windows `docker` may be exactly that -- Docker Desktop ships
 * docker.exe, but a WSL-engine setup uses a docker.cmd shim -- so Windows
 * invocations go through `cmd /c`.
 */
function resolve(cmd, args) {
  if (isWindows && !/\.exe$/i.test(cmd)) return ['cmd', ['/c', cmd, ...args]];
  return [cmd, args];
}

function run(cmd, args, opts = {}) {
  const [c, a] = resolve(cmd, args);
  return spawnSync(c, a, { stdio: 'inherit', shell: false, ...opts });
}

function capture(cmd, args) {
  const [c, a] = resolve(cmd, args);
  const r = spawnSync(c, a, { encoding: 'utf8', shell: false });
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

/** True when a docker daemon is reachable right now. */
function daemonReachable() {
  return capture('docker', ['info', '--format', '{{.ServerVersion}}']).ok;
}

function usingWslEngine() {
  if (!isWindows) return false;
  // Docker Desktop puts its own binary on the System PATH; our WSL shim lives
  // in the user's bin directory. Ask where `docker` actually resolves.
  const where = capture('where', ['docker']);
  return where.ok && /\\bin\\docker\.cmd/i.test(where.out);
}

function ensureWslKeepalive() {
  const tasks = capture('tasklist', ['/v', '/fi', 'imagename eq wsl.exe']);
  if (tasks.ok && /wsl\.exe/i.test(tasks.out)) return; // something already holds it

  console.log('[oolix] holding the WSL2 distro open (keeps the Docker daemon alive)');
  const child = spawn('wsl.exe', ['-d', 'Ubuntu', '-u', 'root', '-e', 'sleep', 'infinity'], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
}

function ensureWslDocker() {
  console.log('[oolix] starting the Docker daemon inside WSL...');
  run('wsl.exe', ['-d', 'Ubuntu', '-u', 'root', '-e', 'systemctl', 'start', 'docker']);
}

if (usingWslEngine()) {
  ensureWslKeepalive();
  if (!daemonReachable()) ensureWslDocker();
}

if (!daemonReachable()) {
  console.error(
    '\n[oolix] No Docker daemon is reachable.\n' +
      '        Start Docker Desktop, or (WSL2 setup) run:\n' +
      '          wsl -d Ubuntu -u root -e systemctl start docker\n',
  );
  process.exit(1);
}

const up = run('docker', ['compose', 'up', '-d', '--quiet-pull', ...SERVICES]);
if (up.status !== 0) process.exit(up.status ?? 1);

console.log('\n[oolix] dependencies starting. Waiting for readiness...\n');
const wait = run(process.execPath, ['scripts/wait-for-stack.mjs']);
process.exit(wait.status ?? 0);
