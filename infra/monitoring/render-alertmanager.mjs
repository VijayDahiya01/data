#!/usr/bin/env node
/**
 * Render the Alertmanager config for one deployment -- spec §78.2.
 *
 * # Why this exists
 *
 * The routing file used to carry two `http://example.invalid` placeholders and
 * a comment asking somebody to replace them. That is the most forgettable kind
 * of deployment step there is: every other setting in this system comes from
 * `.env.prod`, so the one that lives in a YAML file is the one that gets
 * missed.
 *
 * And it fails silently in the worst possible direction. Every alert rule
 * still evaluates, every alert still fires, and all of them go to a hostname
 * that does not resolve. The stack is healthy, green, and nobody is told
 * anything. You find out during the incident the alerting was meant to catch.
 *
 * So the URLs come from the environment, and this refuses to render a
 * placeholder rather than letting one reach production.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const SRC = process.env.ALERTMANAGER_SRC ?? '/src/alertmanager.yml';
const OUT = process.env.ALERTMANAGER_OUT ?? '/out/alertmanager.yml';

const REQUIRED = [
  { name: 'ALERT_WEBHOOK_DEFAULT', what: 'ticket-severity alerts' },
  { name: 'ALERT_WEBHOOK_ONCALL', what: 'the on-call page' },
];

/**
 * A URL that would silently swallow every alert.
 *
 * `localhost` is on the list because inside a container it means the
 * Alertmanager container itself, not the operator's machine -- an easy and
 * very quiet mistake.
 */
function unusable(url) {
  if (!/^https?:\/\//.test(url)) return 'must start with http:// or https://';
  if (/example\.(invalid|com|org|net)/.test(url)) return 'is an example placeholder';
  if (/REPLACE|CHANGE_?ME|TODO|xxx/i.test(url)) return 'still contains a placeholder marker';
  if (/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])/.test(url)) {
    return 'points at localhost, which inside a container is Alertmanager itself';
  }
  return null;
}

let config = readFileSync(SRC, 'utf8');
const problems = [];

for (const { name, what } of REQUIRED) {
  const value = (process.env[name] ?? '').trim();
  if (!value) {
    problems.push(`${name} is not set (${what})`);
    continue;
  }
  const why = unusable(value);
  if (why) {
    problems.push(`${name} ${why}`);
    continue;
  }
  config = config.split(`\${env.${name}}`).join(value);
}

if (problems.length > 0) {
  console.error('alertmanager render: refusing to render, because these alerts would go nowhere:');
  for (const p of problems) console.error(`  - ${p}`);
  console.error('Set them in .env.prod. An unrouted alert is worse than no alert,');
  console.error('because the dashboard stays green while nobody is told.');
  process.exit(1);
}

const leftover = /\$\{env\.([A-Z_]+)\}/.exec(config);
if (leftover) {
  console.error(`alertmanager render: \${env.${leftover[1]}} was never substituted`);
  process.exit(1);
}

writeFileSync(OUT, config);
// The URLs frequently embed a token, so only the host is logged.
const hosts = REQUIRED.map(({ name }) => {
  try {
    return `${name}=${new URL(process.env[name]).host}`;
  } catch {
    return `${name}=?`;
  }
}).join(' ');
console.log(`alertmanager render: routing configured (${hosts})`);
