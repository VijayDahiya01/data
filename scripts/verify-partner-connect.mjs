#!/usr/bin/env node
/**
 * Partner Connect, end to end.
 *
 * Part A needs only the stack. It proves the Oolix side of the setup-page
 * path:
 *
 *   Bundle         GET /agent/v1/compose serves the pack's Compose file with
 *                  this deployment's address, and the setup page bound to
 *                  the Partner's own server
 *   Registration   the reply carries the Partner and the pinned manifest
 *                  values a managed Agent configures itself from
 *   Publishing     an Agent publishes its own capabilities, held to the
 *                  taxonomy like a person
 *   Readiness      published capabilities count as audience supply
 *   Withdrawal     attributes marked UNAVAILABLE stop counting
 *   Quality        an Agent reports how complete its copy is, as percentages
 *
 * Part B (--agent <binary>) runs a real managed Agent: it drives the setup
 * page over HTTP with CSVs of customers and their orders, lets the Agent copy,
 * sum up the orders and publish by itself, then checks the copy holds no raw
 * customer id and deletes it.
 *
 * Partner A's capabilities are restored at the end, so the other verify
 * scripts find the fixture as they left it.
 *
 * Requires: the stack up and seeded.
 *
 * Usage: node scripts/verify-partner-connect.mjs [--agent partner/agent/bin/oolix-agent]
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { onboardPartnerAgent, seedToken } from './lib/onboard-partner.mjs';

const API = (process.env.API_PUBLIC_URL ?? 'http://localhost:4000').replace(/\/+$/, '');
const PARTNER_A_ORG = '22222222-2222-4222-8222-222222222222';
const OOLIX_DB =
  process.env.DATABASE_URL ?? 'postgresql://oolix:oolix@localhost:5432/oolix?schema=public';

const agentFlag = process.argv.indexOf('--agent');
const AGENT_BIN = agentFlag > 0 ? process.argv[agentFlag + 1] : process.env.OOLIX_AGENT_BIN;

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
  if (!ok) failures += 1;
  return ok;
};

async function api(pathname, { method = 'GET', token, body, headers = {} } = {}) {
  const res = await fetch(`${API}${pathname}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      'X-Org-Id': PARTNER_A_ORG,
      ...headers,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  return { status: res.status, body: json, text, headers: res.headers };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(what, fn, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(1500);
  }
}

const readinessStep = async (token) => {
  const r = await api('/v1/partner/readiness', { token });
  return r.body?.checks?.find((c) => c.step === 'audience_published');
};

// ---------------------------------------------------------------------------
console.log('\nPartner Connect verification\n');

const partnerAdmin = await seedToken('partner.admin@example.test');
const security = await seedToken('partner.security@example.test');
const before = await api('/v1/partner/capabilities', { token: partnerAdmin });
const oolixDb = new pg.Client({ connectionString: OOLIX_DB });
await oolixDb.connect();
const hadQuality =
  (
    await oolixDb.query('SELECT 1 FROM partner_data_quality WHERE partner_org_id = $1', [
      PARTNER_A_ORG,
    ])
  ).rowCount > 0;
const agentsBefore = new Set(
  ((await api('/v1/partner/agents', { token: security })).body?.items ?? []).map((a) => a.agent_id),
);

try {
  // -------------------------------------------------------------------------
  console.log('A1. The bundle');
  const bundle = await fetch(`${API}/agent/v1/compose`);
  const compose = await bundle.text();
  check('GET /agent/v1/compose needs no sign-in', bundle.status === 200, `${bundle.status}`);
  check(
    'served as YAML to save as docker-compose.yml',
    (bundle.headers.get('content-type') ?? '').includes('yaml') &&
      (bundle.headers.get('content-disposition') ?? '').includes('docker-compose.yml'),
  );
  check('carries this deployment’s API address', compose.includes(`OOLIX_API_BASE_URL: ${API}`));
  check('no placeholder is left in it', !compose.includes('REPLACE_WITH'));
  check('the setup page is bound to the server itself', compose.includes("'127.0.0.1:8083:8083'"));
  check('the Agent runs in managed mode', compose.includes("command: ['-managed']"));

  // -------------------------------------------------------------------------
  console.log('\nA2. Registration tells a managed Agent who it is');
  const { bootstrap_token: code } = (
    await api('/v1/partner/agents/bootstrap-tokens', { method: 'POST', token: security })
  ).body;
  const { generateKeyPair, exportJWK } = await import('jose');
  const { publicKey } = await generateKeyPair('ES256', { extractable: true });
  const jwk = await exportJWK(publicKey);
  const reg = await api('/agent/v1/register', {
    method: 'POST',
    body: {
      bootstrap_token: code,
      agent_public_key_jwk: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y },
      agent_version: '0.1.0',
      capabilities: ['PARTNER_WEB'],
    },
  });
  check('registration succeeds', reg.status === 201, `${reg.status}`);
  check('names the Partner it acts for', reg.body?.partner_org_id === PARTNER_A_ORG);
  check(
    'names the pinned manifest issuer and audience',
    Boolean(reg.body?.manifest_issuer) && Boolean(reg.body?.manifest_audience),
  );
  // That identity's key was thrown away; revoke it so it does not linger.
  if (reg.body?.agent_id) {
    await api(`/v1/partner/agents/${reg.body.agent_id}/revoke`, {
      method: 'POST',
      token: security,
      body: { reason: 'verify-partner-connect: registration check only' },
    });
  }

  // -------------------------------------------------------------------------
  console.log('\nA3. An Agent publishes its own capabilities');
  const agent = await onboardPartnerAgent({
    api: API,
    securityToken: security,
    orgId: PARTNER_A_ORG,
  });
  const asAgent = { token: agent.accessToken, headers: { 'X-Agent-Id': agent.agentId } };
  const capabilities = {
    attributes: [
      { attribute_key: 'age', operators: ['BETWEEN'], status: 'AVAILABLE' },
      { attribute_key: 'city', operators: ['IN'], status: 'AVAILABLE' },
    ],
    geographies: ['IN'],
    channels: ['PARTNER_WEB'],
    mapping_version: 1,
  };
  const published = await api('/agent/v1/audience/capabilities', {
    method: 'POST',
    ...asAgent,
    body: capabilities,
  });
  check(
    'POST /agent/v1/audience/capabilities is accepted',
    published.status === 201,
    `${published.status} ${published.text.slice(0, 120)}`,
  );
  const seen = await api('/v1/partner/capabilities', { token: partnerAdmin });
  check(
    'the portal shows what the Agent published',
    seen.body?.capability_version === published.body?.capability_version &&
      seen.body?.attributes?.map((a) => a.attribute_key).join(',') === 'age,city',
  );
  const wrong = await api('/agent/v1/audience/capabilities', {
    method: 'POST',
    ...asAgent,
    body: { ...capabilities, attributes: [{ attribute_key: 'age', operators: ['IN'] }] },
  });
  check(
    'an operator the taxonomy does not define is refused',
    wrong.status === 400,
    `${wrong.status}`,
  );
  const noToken = await api('/agent/v1/audience/capabilities', {
    method: 'POST',
    body: capabilities,
  });
  check('an unauthenticated publish is refused', noToken.status === 401, `${noToken.status}`);

  // -------------------------------------------------------------------------
  console.log('\nA4. Readiness counts capabilities as audience supply');
  const step = await readinessStep(partnerAdmin);
  check(
    'the audience_published step is complete',
    step?.complete === true,
    step?.detail ?? 'missing',
  );
  check(
    'and says how many attributes are published',
    /2 attribute\(s\) published/.test(step?.detail ?? ''),
  );

  // -------------------------------------------------------------------------
  console.log('\nA5. Withdrawn attributes stop counting');
  await api('/agent/v1/audience/capabilities', {
    method: 'POST',
    ...asAgent,
    body: {
      ...capabilities,
      attributes: capabilities.attributes.map((a) => ({ ...a, status: 'UNAVAILABLE' })),
    },
  });
  const afterWithdraw = await readinessStep(partnerAdmin);
  check(
    'no attribute is counted once withdrawn',
    /0 attribute\(s\) published/.test(afterWithdraw?.detail ?? ''),
  );

  // -------------------------------------------------------------------------
  console.log('\nA6. An Agent reports how complete its copy is');
  const report = {
    synced_at: new Date().toISOString(),
    sync_mode: 'FULL',
    customers_bucket: '10K_50K',
    attributes: [{ attribute_key: 'age', coverage_pct: 92, unreadable_pct: 1 }],
  };
  const reported = await api('/agent/v1/audience/quality', {
    method: 'POST',
    ...asAgent,
    body: report,
  });
  check(
    'POST /agent/v1/audience/quality is accepted',
    reported.status === 201,
    `${reported.status}`,
  );
  const quality = await api('/v1/partner/capabilities/quality', { token: partnerAdmin });
  check(
    'the Partner sees it in the portal',
    quality.body?.customers_bucket === '10K_50K' &&
      quality.body?.attributes?.[0]?.coverage_pct === 92,
  );
  const counted = await api('/agent/v1/audience/quality', {
    method: 'POST',
    ...asAgent,
    body: { ...report, customers: 12345 },
  });
  check(
    'an exact count is not something it stores',
    counted.status === 201 &&
      !JSON.stringify(
        (await api('/v1/partner/capabilities/quality', { token: partnerAdmin })).body,
      ).includes('12345'),
  );
  const unknownKey = await api('/agent/v1/audience/quality', {
    method: 'POST',
    ...asAgent,
    body: {
      ...report,
      attributes: [{ attribute_key: 'income', coverage_pct: 5, unreadable_pct: 0 }],
    },
  });
  check(
    'an attribute outside the taxonomy is refused',
    unknownKey.status === 400,
    `${unknownKey.status}`,
  );

  // -------------------------------------------------------------------------
  if (AGENT_BIN) {
    await partB(security, partnerAdmin);
  } else {
    console.log('\nB.  Live managed Agent: skipped (run with --agent <path to oolix-agent>)');
  }
} catch (err) {
  check('verification ran to the end', false, err.message);
} finally {
  // Put Partner A's capabilities back as the other scripts expect them. The
  // seed writes them directly, with operators wider than the taxonomy allows,
  // so the API would rightly refuse to publish them again: the version this
  // run found is made the active one again instead.
  const version = before.body?.capability_version;
  if (version) {
    await oolixDb.query(
      `UPDATE partner_capabilities SET status = 'SUPERSEDED'
        WHERE partner_org_id = $1 AND capability_version > $2`,
      [PARTNER_A_ORG, version],
    );
    await oolixDb.query(
      `UPDATE partner_capabilities SET status = 'ACTIVE'
        WHERE partner_org_id = $1 AND capability_version = $2`,
      [PARTNER_A_ORG, version],
    );
    const now = await api('/v1/partner/capabilities', { token: partnerAdmin });
    check(
      'Partner A’s capabilities restored',
      now.body?.capability_version === version,
      `v${now.body?.capability_version}`,
    );
  }
  if (!hadQuality) {
    await oolixDb.query('DELETE FROM partner_data_quality WHERE partner_org_id = $1', [
      PARTNER_A_ORG,
    ]);
  }
  await oolixDb.end();
  // Revoke every Agent this run created.
  const agentsAfter = (await api('/v1/partner/agents', { token: security })).body?.items ?? [];
  for (const a of agentsAfter) {
    if (!agentsBefore.has(a.agent_id) && a.status === 'ACTIVE') {
      await api(`/v1/partner/agents/${a.agent_id}/revoke`, {
        method: 'POST',
        token: security,
        body: { reason: 'verify-partner-connect cleanup' },
      });
    }
  }
}

console.log(
  failures === 0
    ? '\nPartner Connect verified: all checks passed.\n'
    : `\n${failures} check(s) FAILED.\n`,
);
process.exit(failures === 0 ? 0 : 1);

// ---------------------------------------------------------------------------
// Part B: a real managed Agent, set up through its own page.

async function partB(security, partnerAdmin) {
  console.log('\nB.  A live managed Agent, set up through its page');
  const SETUP = 'http://127.0.0.1:18083';
  const DECIDE = 'http://127.0.0.1:18082';
  const PASSWORD = 'verify-partner-connect-password';
  const storeDb = 'oolix_agent_verify';

  // The local store: a database of its own on the stack's PostgreSQL.
  const admin = new pg.Client({ connectionString: OOLIX_DB });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${storeDb} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${storeDb}`);
  await admin.end();
  const storeUrl = new URL(OOLIX_DB);
  storeUrl.pathname = `/${storeDb}`;
  storeUrl.search = '?sslmode=disable';

  const work = mkdtempSync(path.join(tmpdir(), 'oolix-connect-'));
  const importDir = path.join(work, 'import');
  mkdirSync(importDir);
  writeFileSync(
    path.join(importDir, 'customers.csv'),
    [
      'customer_id,Full Name,DOB,sex,City,marketing_opt_in,unsubscribed_at',
      'C1,Asha Rao,14/04/1992,F,Bombay,yes,',
      'C2,Ravi Iyer,14-04-1993,M,bangalore,true,',
      'C3,Mira Das,1992-04-13T18:30:00Z,female,Mumbai,Y,',
      'C4,Kid Kumar,01/01/2015,M,Mumbai,yes,',
      'C5,No Consent,25/12/1985,M,Pune,no,',
      'C6,Withdrew,05/05/1985,F,Delhi,yes,2026-09-10',
    ].join('\n') + '\n',
  );
  // Dates relative to today, so the 90-day window holds whenever this runs.
  const daysAgo = (n) =>
    new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 19).replace('T', ' ');
  writeFileSync(
    path.join(importDir, 'orders.csv'),
    [
      'order_id,customer_id,order_date,category,pay_mode,channel',
      `O1,C1,${daysAgo(5)},Shoes,GPay,App`,
      `O2,C1,${daysAgo(40)},Sneakers,UPI,Web`,
      `O3,C2,${daysAgo(200)},Groceries,COD,Store`,
      `O4,C3,${daysAgo(10)},Electronics,Credit Card,App`,
    ].join('\n') + '\n',
  );

  const child = spawn(AGENT_BIN, ['-managed'], {
    env: {
      ...process.env,
      OOLIX_API_BASE_URL: API,
      OOLIX_LOCAL_STORE_URL: storeUrl.toString(),
      OOLIX_STATE_DIR: path.join(work, 'state'),
      OOLIX_IMPORT_FOLDER: importDir,
      OOLIX_SETUP_LISTEN_ADDR: '127.0.0.1:18083',
      OOLIX_LISTEN_ADDR: '127.0.0.1:18082',
      OOLIX_SETUP_PASSWORD: PASSWORD,
      OOLIX_LOG_FORMAT: 'text',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));

  let cookie = '';
  const page = async (pathname, form) => {
    const res = await fetch(`${SETUP}${pathname}`, {
      method: form ? 'POST' : 'GET',
      redirect: 'manual',
      headers: {
        ...(cookie ? { Cookie: cookie } : {}),
        ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
      },
      ...(form ? { body: new URLSearchParams(form).toString() } : {}),
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: res.status, location: res.headers.get('location'), body: await res.text() };
  };

  try {
    await until('the setup page', async () => {
      try {
        return (await page('/login')).status === 200;
      } catch {
        return false;
      }
    });
    check('the setup page comes up before the Agent is registered', true);
    check('the log never prints a password that was provided', !log.includes(PASSWORD));

    const login = await page('/login', { password: PASSWORD });
    check('signs in with the setup password', login.status === 303 && login.location === '/');
    const csrf = /name="csrf" value="([0-9a-f]+)"/.exec((await page('/register')).body)?.[1];
    check('forms carry a CSRF token', Boolean(csrf));

    const { bootstrap_token: code } = (
      await api('/v1/partner/agents/bootstrap-tokens', { method: 'POST', token: security })
    ).body;
    const reg = await page('/register', { csrf, code });
    check(
      'registers with a one-time code from the portal',
      reg.location === '/?notice=registered',
      reg.location ?? `${reg.status}`,
    );

    const src = await page('/source', { csrf, kind: 'file', location: 'Asia/Kolkata' });
    check(
      'reads CSV exports from the import folder',
      src.location === '/table?notice=connected',
      src.location ?? `${src.status}`,
    );
    const table = await page('/table', { csrf, table: 'customers.csv' });
    check('takes the customer file', table.location === '/review');
    const review = await page('/review');
    check(
      'suggests the customer id and shows the cleaning',
      review.body.includes('<option value="customer_id" selected>') &&
        review.body.includes('14 Apr 1992 (age 34)'),
    );

    const saved = await page('/review', {
      csrf,
      id_column: 'customer_id',
      col_age: 'DOB',
      order_age: 'day',
      publish_age: 'on',
      col_gender: 'sex',
      publish_gender: 'on',
      col_city: 'City',
      publish_city: 'on',
      action: 'next',
    });
    check('the matches are saved, and the orders step is next', saved.location === '/activity');

    const chose = await page('/activity', { csrf, orders_table: 'orders.csv', action: 'check' });
    check('takes the orders file', chose.location === '/activity?notice=saved');
    const orders = await page('/activity');
    check(
      'suggests the orders table\u2019s columns',
      orders.body.includes('<option value="order_date" selected>') &&
        orders.body.includes('<option value="pay_mode" selected>'),
    );
    const ordersForm = {
      csrf,
      orders_table: 'orders.csv',
      orders_customer: 'customer_id',
      orders_date: 'order_date',
      orders_purchase_category: 'category',
      orders_payment_method: 'pay_mode',
      orders_order_channel: 'channel',
      action: 'next',
    };
    for (const key of [
      'purchase_recency_days',
      'purchase_frequency',
      'purchase_category',
      'payment_method',
      'online_shopper',
    ]) {
      ordersForm[`orders_shown_${key}`] = '1';
      ordersForm[`orders_offer_${key}`] = 'on';
    }
    const ordersSaved = await page('/activity', ordersForm);
    check('the orders step is saved', ordersSaved.location === '/consent');
    const publish = await page('/consent', {
      csrf,
      consent_column: 'marketing_opt_in',
      withdrawal_column: 'unsubscribed_at',
      web: 'on',
      sync_hour: '3',
      action: 'publish',
    });
    check('publishes', publish.location === '/?notice=publishing');

    // The Agent copies the file and publishes by itself.
    const caps = await until('the Agent to publish', async () => {
      const r = await api('/v1/partner/capabilities', { token: partnerAdmin });
      const keys = (r.body?.attributes ?? [])
        .map((a) => a.attribute_key)
        .sort()
        .join(',');
      return keys ===
        'age,city,gender,online_shopper,payment_method,purchase_category,purchase_frequency,purchase_recency_days'
        ? r.body
        : null;
    });
    check(
      'Oolix sees the attributes the Agent can answer, orders included',
      Boolean(caps),
      'age, city, gender and five from orders',
    );
    const reportedQuality = await until('the quality report', async () => {
      const r = await api('/v1/partner/capabilities/quality', { token: partnerAdmin });
      return r.body?.attributes?.some((a) => a.attribute_key === 'purchase_frequency')
        ? r.body
        : null;
    });
    check(
      'and reports how complete the copy is, in percentages',
      reportedQuality?.customers_bucket === 'UNDER_10K',
    );

    const store = new pg.Client({ connectionString: storeUrl.toString() });
    await store.connect();
    const { rows } = await store.query(
      `SELECT partner_user_id, city FROM oolix_audience_attributes ORDER BY partner_user_id`,
    );
    await store.end();
    check('only adults who agreed are copied', rows.length === 3, `${rows.length} rows`);
    check(
      'no raw customer id is stored',
      rows.every((r) => !/^C\d$/.test(r.partner_user_id) && r.partner_user_id.length === 64),
    );
    check('Bombay is stored as MUMBAI', rows.filter((r) => r.city === 'MUMBAI').length === 2);

    const decision = await fetch(`${DECIDE}/private/v1/ad-decision`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ partner_user_id: 'C1', placement_id: 'no-such-placement' }),
    });
    check(
      'the ad-decision API answers from the local copy',
      decision.status === 200,
      `${decision.status}`,
    );

    const deleted = await page('/delete', { csrf, confirm: 'DELETE', forget: 'on' });
    check('Delete all copied data', deleted.location === '/?notice=forgotten');
    const withdrawn = await api('/v1/partner/capabilities', { token: partnerAdmin });
    check(
      'and the attributes are withdrawn from Oolix',
      (withdrawn.body?.attributes ?? []).every((a) => a.status === 'UNAVAILABLE'),
    );
  } catch (err) {
    check('the managed Agent ran to the end', false, err.message);
    console.log('\n--- Agent log ---\n' + log.slice(-4000));
  } finally {
    child.kill();
    rmSync(work, { recursive: true, force: true });
  }
}
