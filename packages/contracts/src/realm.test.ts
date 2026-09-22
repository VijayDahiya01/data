/**
 * The Keycloak realm file is imported into PRODUCTION -- spec §17, §65.1.
 *
 * That is the whole reason this test exists. The same file serves local
 * development and a real deployment, so anything written as a literal is a
 * literal in production too. It used to carry `"secret": "local-only-secret"`,
 * which meant the repository published the production client secret; an
 * operator who set a strong one in `.env.prod` instead simply broke sign-in,
 * because Keycloak's copy still said otherwise. Neither failure announces
 * itself.
 *
 * Every setting that must differ between development and production is now a
 * `${env.NAME}` placeholder substituted at render time. This test is what stops
 * one drifting back to a literal.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const REALM = path.resolve(here, '../../../infra/keycloak/oolix-realm.json');

const raw = readFileSync(REALM, 'utf8');

/** The file with placeholders filled in, so it can be parsed as JSON. */
function rendered(values: Record<string, string>): Record<string, unknown> {
  let out = raw;
  for (const [k, v] of Object.entries(values)) {
    out = out.split(`\${env.${k}}`).join(v);
  }
  return JSON.parse(out) as Record<string, unknown>;
}

const PROD = {
  WEB_PUBLIC_URL: 'https://app.example.com',
  KEYCLOAK_PUBLIC_URL: 'https://auth.example.com',
  OIDC_CLIENT_SECRET: 'a-strong-generated-secret',
  KC_SSL_REQUIRED: 'external',
  KC_PASSWORD_POLICY: 'length(12)',
  KC_DIRECT_GRANTS: 'false',
};

interface RealmClient {
  clientId: string;
  secret?: string;
  publicClient?: boolean;
  directAccessGrantsEnabled?: boolean;
  redirectUris?: string[];
  webOrigins?: string[];
}

describe('the Keycloak realm import', () => {
  it('carries no literal secret', () => {
    // Anything that looks like a credential must be a placeholder, because the
    // file is checked in and imported into production unchanged.
    const literals = /"secret"\s*:\s*"(?!\$\{env\.)([^"]+)"/g;
    const found = [...raw.matchAll(literals)].map((m) => m[1]);
    expect(found).toEqual([]);
  });

  it('never ships the old published secret, under any key', () => {
    expect(raw).not.toContain('local-only-secret');
  });

  it('makes every environment-dependent security setting a placeholder', () => {
    // A literal here is a production value that nobody chose.
    for (const key of ['sslRequired', 'passwordPolicy', 'directAccessGrantsEnabled']) {
      const m = new RegExp(`"${key}"\\s*:\\s*("?)([^,\\n]+)`).exec(raw);
      expect(m).not.toBeNull();
      expect(m?.[0]).toContain('${env.');
    }
  });

  it('renders to valid JSON with production values', () => {
    const doc = rendered(PROD);
    expect(doc.realm).toBe('oolix');
    expect(doc.sslRequired).toBe('external');
  });

  it('is valid JSON as a template, before anything is substituted', () => {
    // Kept parseable on purpose: every editor, linter and test can read it,
    // and a template only a shell script understands is one nobody checks.
    expect(() => JSON.parse(raw.replace(/\$\{env\.[A-Z_]+\}/g, 'x'))).not.toThrow();
  });

  it('the renderer turns the quoted boolean into a real one', () => {
    // The placeholder must sit inside quotes for the template to stay valid
    // JSON, so the renderer coerces it. Keycloak given the STRING "false"
    // does not complain -- it enables the password grant, because a non-empty
    // string is truthy. This runs the real renderer rather than a copy of it.
    const dir = mkdtempSync(path.join(tmpdir(), 'realm-'));
    const out = path.join(dir, 'realm.json');
    const script = path.resolve(here, '../../../infra/keycloak/render-realm.mjs');

    const res = spawnSync(process.execPath, [script], {
      env: {
        ...process.env,
        REALM_SRC: REALM,
        REALM_OUT: out,
        WEB_PUBLIC_URL: PROD.WEB_PUBLIC_URL,
        KEYCLOAK_PUBLIC_URL: PROD.KEYCLOAK_PUBLIC_URL,
        OIDC_CLIENT_SECRET: PROD.OIDC_CLIENT_SECRET,
        KC_SSL_REQUIRED: 'external',
        KC_DIRECT_GRANTS: 'false',
        KC_SEED_USERS: 'false',
      },
      encoding: 'utf8',
    });
    expect(res.status).toBe(0);

    const doc = JSON.parse(readFileSync(out, 'utf8')) as { clients: RealmClient[]; users: [] };
    const web = doc.clients.find((c) => c.clientId === 'oolix-web');
    expect(typeof web?.directAccessGrantsEnabled).toBe('boolean');
    expect(web?.directAccessGrantsEnabled).toBe(false);
    expect(doc.users).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  it('the renderer refuses to seed identities into a TLS realm', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'realm-'));
    const script = path.resolve(here, '../../../infra/keycloak/render-realm.mjs');

    const res = spawnSync(process.execPath, [script], {
      env: {
        ...process.env,
        REALM_SRC: REALM,
        REALM_DEV_USERS: path.resolve(here, '../../../infra/keycloak/dev-users.json'),
        REALM_OUT: path.join(dir, 'realm.json'),
        WEB_PUBLIC_URL: PROD.WEB_PUBLIC_URL,
        KEYCLOAK_PUBLIC_URL: PROD.KEYCLOAK_PUBLIC_URL,
        OIDC_CLIENT_SECRET: PROD.OIDC_CLIENT_SECRET,
        KC_SSL_REQUIRED: 'external',
        KC_SEED_USERS: 'true',
      },
      encoding: 'utf8',
    });
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain('refusing to seed');
    rmSync(dir, { recursive: true, force: true });
  });

  it('keeps the portal a confidential client', () => {
    // A public client needs no secret at all, which would quietly undo the
    // point of having one.
    const doc = rendered(PROD) as { clients: RealmClient[] };
    const web = doc.clients.find((c) => c.clientId === 'oolix-web');
    expect(web?.publicClient).toBe(false);
    expect(web?.secret).toBe(PROD.OIDC_CLIENT_SECRET);
  });

  it('scopes redirect URIs and origins to the configured portal', () => {
    // §35: an open redirect here is an account takeover, because the
    // authorization code is delivered to whatever URI is accepted.
    const doc = rendered(PROD) as { clients: RealmClient[] };
    const web = doc.clients.find((c) => c.clientId === 'oolix-web');
    for (const uri of web?.redirectUris ?? []) {
      expect(uri.startsWith(PROD.WEB_PUBLIC_URL)).toBe(true);
    }
    expect(web?.webOrigins).toEqual([PROD.WEB_PUBLIC_URL]);
    // A wildcard origin would let any site read a signed-in response.
    expect(web?.webOrigins).not.toContain('*');
  });

  it('ships NO users in the realm itself', () => {
    // The realm used to carry thirteen development identities with the
    // password `password`, one of which (demo@example.test) holds OOLIX_ADMIN
    // plus every Partner role -- and this file is imported into production
    // unchanged. They now live in dev-users.json and are merged in only when
    // seeding is explicitly requested, so forgetting a flag leaves a
    // deployment with no accounts rather than with thirteen known ones.
    const doc = rendered(PROD) as { users?: unknown[] };
    expect(doc.users).toEqual([]);
  });

  it('keeps the development identities out of the realm file entirely', () => {
    // Not merely empty: absent. A future edit that adds one back to this file
    // would put it into production.
    expect(raw).not.toContain('@example.test');
    expect(raw).not.toContain('"password"');
  });

  it('does not let anyone register themselves an account', () => {
    const doc = rendered(PROD) as { registrationAllowed?: boolean };
    expect(doc.registrationAllowed).toBe(false);
  });

  it('keeps brute-force protection on', () => {
    const doc = rendered(PROD) as { bruteForceProtected?: boolean };
    expect(doc.bruteForceProtected).toBe(true);
  });
});

/**
 * Multi-factor authentication -- §4.2, §82.
 *
 * `auth.guard.ts` refuses PARTNER_ADMIN, PARTNER_SECURITY_ADMIN,
 * PARTNER_CAMPAIGN_APPROVER, FINANCE, BUYER_ADMIN and OOLIX_ADMIN unless the
 * access token says MFA happened -- but ONLY when APP_ENV is production. Every
 * test and every verification run uses a lower APP_ENV, so the branch never
 * executed and nothing ever checked that a real token could satisfy it.
 *
 * It could not. Keycloak 26 emits no `amr` claim at all, and `acr` is the
 * Level of Authentication, which is "1" unless the realm both maps a name to a
 * level AND has a browser flow that records reaching it. The realm had
 * neither, so a production deployment locked six of the nine roles out of the
 * product with AUTH_001 -- a failure that reads like a permissions bug.
 *
 * These tests pin the three things that have to agree. Any one of them drifting
 * puts it back, silently, because a login still succeeds either way.
 */
describe('the realm can actually satisfy the API MFA check', () => {
  interface Execution {
    authenticator?: string;
    authenticatorConfig?: string;
    flowAlias?: string;
    requirement?: string;
  }
  interface Flow {
    alias: string;
    topLevel?: boolean;
    authenticationExecutions: Execution[];
  }
  interface RealmDoc {
    browserFlow?: string;
    attributes?: Record<string, string>;
    authenticationFlows?: Flow[];
    authenticatorConfig?: { alias: string; config: Record<string, string> }[];
    requiredActions?: { alias: string; enabled?: boolean; defaultAction?: boolean }[];
    clients: (RealmClient & { attributes?: Record<string, string> })[];
  }

  const doc = rendered(PROD) as unknown as RealmDoc;
  const flows = doc.authenticationFlows ?? [];
  const flow = (alias: string) => flows.find((f) => f.alias === alias);

  it('does not use the built-in browser flow, which cannot record a level', () => {
    // Keycloak's own `browser` flow authenticates perfectly well and reports
    // acr "1" forever. Binding to it is the failure this whole block guards.
    expect(doc.browserFlow).toBeDefined();
    expect(doc.browserFlow).not.toBe('browser');
    expect(flow(doc.browserFlow!)?.topLevel).toBe(true);
  });

  it('maps the acr value the API accepts to a level', () => {
    // mfaSatisfied() accepts acr in {mfa, aal2, aal3}. The map is what turns a
    // reached level back into one of those names in the token.
    const map = JSON.parse(doc.attributes?.['acr.loa.map'] ?? '{}') as Record<string, number>;
    expect(Object.keys(map)).toContain('mfa');
    expect(map.mfa).toBeGreaterThan(1);
  });

  it('runs the OTP step at exactly the level the map calls mfa', () => {
    // The subtle one. If the map says mfa=2 and the conditional subflow is
    // configured for level 3, the OTP step never runs, the login still
    // succeeds, and the token comes back acr "1".
    const map = JSON.parse(doc.attributes?.['acr.loa.map'] ?? '{}') as Record<string, number>;
    const configs = doc.authenticatorConfig ?? [];

    const otpSubflow = flows.find((f) =>
      f.authenticationExecutions.some((e) => e.authenticator === 'auth-otp-form'),
    );
    expect(otpSubflow, 'no subflow runs auth-otp-form').toBeDefined();

    const condition = otpSubflow!.authenticationExecutions.find(
      (e) => e.authenticator === 'conditional-level-of-authentication',
    );
    expect(condition, 'the OTP subflow has no level condition').toBeDefined();

    const level = configs.find((c) => c.alias === condition!.authenticatorConfig)?.config[
      'loa-condition-level'
    ];
    expect(Number(level)).toBe(map.mfa);
  });

  it('sends an account with no authenticator to enrol rather than past', () => {
    const totp = doc.requiredActions?.find((a) => a.alias === 'CONFIGURE_TOTP');
    expect(totp?.enabled).toBe(true);
    expect(totp?.defaultAction).toBe(true);
  });

  it('still registers the required actions it does not mean to change', () => {
    // Declaring `requiredActions` REPLACES the list. Declaring only
    // CONFIGURE_TOTP unregisters UPDATE_PASSWORD -- which is how an operator
    // hands out a temporary password when creating the first accounts on a
    // fresh deployment, the exact situation this realm is for.
    const aliases = (doc.requiredActions ?? []).map((a) => a.alias);
    expect(aliases).toContain('UPDATE_PASSWORD');
    expect(aliases).toContain('VERIFY_EMAIL');
    expect(aliases).toContain('UPDATE_PROFILE');
  });

  it('gives the portal client the same mapping the realm uses', () => {
    // Keycloak validates a client's ACR settings against the client's own
    // view of the map; a client without it cannot ask for the level.
    const web = doc.clients.find((c) => c.clientId === 'oolix-web');
    const clientMap = JSON.parse(web?.attributes?.['acr.loa.map'] ?? '{}') as Record<
      string,
      number
    >;
    const realmMap = JSON.parse(doc.attributes?.['acr.loa.map'] ?? '{}') as Record<string, number>;
    expect(clientMap).toEqual(realmMap);
  });

  it('asks for the level from the portal, which is the half a realm cannot do', () => {
    // Keycloak records a level only when the login REQUESTS it. The realm can
    // be perfect and every privileged role still locked out if the
    // authorization request omits acr_values.
    const oidc = readFileSync(
      path.resolve(here, '../../../apps/web-portal/src/lib/oidc.ts'),
      'utf8',
    );
    expect(oidc).toMatch(/acr_values:\s*'mfa'/);
  });
});
