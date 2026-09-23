/**
 * No demo account, password or fixture address may reach a real environment.
 *
 * The login page used to print the seeded accounts and their shared password
 * as unconditional JSX. Against a seeded database that is a convenience;
 * against a real one it is a disclosure, and it would have shipped because
 * nothing failed when it did.
 *
 * These assertions read the SOURCE rather than rendering the page, because the
 * guarantee is about what can be built at all — a rendering test only proves
 * the environment it was run in.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = readFileSync(path.join(here, 'page.tsx'), 'utf8');

describe('the login page in a real environment', () => {
  it('does not print demo credentials unconditionally', () => {
    // Every mention of a fixture address must sit inside the environment gate.
    const gate = source.indexOf('DEMO_ENVIRONMENTS.has(appEnv)');
    expect(gate, 'the environment gate is missing entirely').toBeGreaterThan(-1);

    const firstMention = source.indexOf('@example.test');
    expect(firstMention, 'no fixture address found — did the block move?').toBeGreaterThan(-1);
    expect(
      firstMention,
      'a demo address appears before the environment gate, so it renders everywhere',
    ).toBeGreaterThan(gate);
  });

  it('gates on local and test only', () => {
    const declaration = /DEMO_ENVIRONMENTS = new Set\(\[([^\]]*)\]\)/.exec(source);
    expect(declaration, 'DEMO_ENVIRONMENTS is not declared as a literal set').not.toBeNull();

    const allowed = (declaration?.[1] ?? '')
      .split(',')
      .map((s) => s.trim().replace(/['"]/g, ''))
      .filter(Boolean)
      .sort();

    // Anything beyond these two is an environment §95 will not seed, so the
    // credentials would be a disclosure AND wrong.
    expect(allowed).toEqual(['local', 'test']);
  });

  it('never hard-codes the shared seed password outside the gate', () => {
    const gate = source.indexOf('DEMO_ENVIRONMENTS.has(appEnv)');
    const before = source.slice(0, gate);
    expect(before).not.toMatch(/<code>password<\/code>/);
  });
});
