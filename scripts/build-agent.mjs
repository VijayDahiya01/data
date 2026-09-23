#!/usr/bin/env node
/**
 * Build the Partner Agent to the platform's expected binary name.
 *
 * `go build -o bin/oolix-agent` produces an extension-less file on Windows,
 * while everything that RUNS the Agent looks for `oolix-agent.exe`. The two
 * names diverging is worse than it sounds: the verification runner would find
 * a stale `.exe` from an earlier change, run it, and report the whole suite as
 * passing against Agent code nobody had built.
 *
 * Usage: node scripts/build-agent.mjs
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

const binary = process.platform === 'win32' ? 'oolix-agent.exe' : 'oolix-agent';
const output = path.join('bin', binary);

// `go.exe` rather than `shell: true`: spawning through a shell on Windows
// concatenates arguments instead of escaping them, and naming the executable
// directly lets Node resolve it on PATH without one.
const go = process.platform === 'win32' ? 'go.exe' : 'go';

const build = spawnSync(go, ['build', '-o', output, './cmd/agent'], {
  cwd: 'partner/agent',
  stdio: 'inherit',
});

if (build.status !== 0) {
  console.error('agent build failed');
  process.exit(build.status ?? 1);
}

console.log(`built partner/agent/${output}`);
