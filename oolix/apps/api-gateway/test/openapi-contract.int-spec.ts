/**
 * §86: "OpenAPI 3.1 file in the implementation pack is canonical for HTTP
 * shapes. CI validates generated server/client types against it."
 *
 * A canonical contract that drifts from the server is worse than no contract:
 * a Partner or Buyer integrating against it gets a 404 and no explanation.
 * This test is the thing that keeps the two honest -- adding a route without
 * documenting it fails here.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './app.factory.js';

// The contract ships in the Partner's integration pack, which is why it lives
// on the partner/ side even though it describes the Oolix API: it is the file a
// Partner engineer reads before writing a line against us.
const SPEC_PATH = path.resolve(__dirname, '../../../../partner/pack/openapi.yaml');

interface OpenApiDoc {
  paths: Record<string, Record<string, unknown>>;
}

describe('OpenAPI contract matches the mapped routes (§86)', () => {
  let app: NestFastifyApplication;
  let routes: Set<string>;
  let documented: Set<string>;

  beforeAll(async () => {
    ({ app, routes } = await createTestApp());

    const doc = parse(readFileSync(SPEC_PATH, 'utf8')) as OpenApiDoc;
    documented = new Set<string>();
    for (const [p, item] of Object.entries(doc.paths)) {
      for (const method of Object.keys(item)) {
        if (method === 'parameters') continue;
        // OpenAPI writes `{id}`; Fastify writes `:id`.
        documented.add(`${method} ${p.replace(/\{(\w+)\}/g, ':$1')}`);
      }
    }
  });

  afterAll(async () => {
    await app?.close();
  });

  it('documents every route the server serves', () => {
    const undocumented = [...routes].filter((r) => !documented.has(r)).sort();
    expect(undocumented).toEqual([]);
  });

  it('does not promise routes the server does not serve', () => {
    const missing = [...documented].filter((r) => !routes.has(r)).sort();
    expect(missing).toEqual([]);
  });

  it('separates the user API from the Agent API (§67)', () => {
    // §67 keeps the two surfaces apart so an Agent credential can never reach a
    // user endpoint. If a route ever appears under neither prefix, that
    // separation has been broken somewhere.
    const stray = [...routes].filter(
      (r) =>
        !r.includes(' /v1/') &&
        !r.includes(' /agent/v1/') &&
        !r.endsWith('/healthz') &&
        !r.endsWith('/readyz') &&
        // The scrape endpoint belongs to neither surface for the same reason
        // the probes do not: a collector is not a Buyer and not an Agent. It
        // is not reachable from outside at all -- the TLS terminator returns
        // 404 for it -- so it cannot be a route an Agent credential reaches.
        !r.endsWith('/metrics') &&
        !r.includes('.well-known'),
    );
    expect(stray).toEqual([]);
  });
});
