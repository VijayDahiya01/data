/**
 * Sign-up, sign-in and recovery, end to end (§35, §82, §86).
 *
 * Oolix checks passwords and issues tokens itself now, so these drive the
 * real routes through the real guards against the real database, and read
 * the emails the capture transport keeps -- the one place the one-time links
 * exist outside the database's hashes.
 */
import { randomUUID } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import Redis from 'ioredis';
import { createTestApp } from './app.factory.js';
import { EmailService } from '../src/modules/auth/email/email.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { hashToken } from '../src/modules/auth/auth-tokens.service.js';

const PASSWORD = 'tangerine-orbit-47-lantern';
const NEW_PASSWORD = 'harbour-lights-19-compass';

// Password hashing is deliberately slow -- tens of milliseconds per hash is
// the point of scrypt -- and the lockout test alone performs a dozen.
jest.setTimeout(30_000);

describe('Oolix sign-in (§35, §82)', () => {
  let app: NestFastifyApplication;
  let mail: EmailService;
  let prisma: PrismaService;
  let redis: Redis;

  beforeAll(async () => {
    ({ app } = await createTestApp());
    mail = app.get(EmailService);
    prisma = app.get(PrismaService);
    redis = new Redis(process.env.REDIS_URL!);
  });

  afterAll(async () => {
    await app?.close();
    await redis?.quit();
  });

  // Every test speaks from its own address, so the per-IP sign-in budgets of
  // one test can never throttle another.
  let caller: string;
  let n = 0;
  beforeEach(async () => {
    n += 1;
    caller = `198.51.101.${n}`;
    const keys = await redis.keys('rate_limit:*');
    if (keys.length) await redis.del(...keys);
  });

  async function call(
    method: 'GET' | 'POST',
    url: string,
    payload?: object,
    opts: { token?: string; ip?: string; orgId?: string } = {},
  ) {
    const res = await app.inject({
      method,
      url,
      ...(payload ? { payload } : {}),
      headers: {
        'x-forwarded-for': opts.ip ?? caller,
        ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
        ...(opts.orgId ? { 'x-org-id': opts.orgId } : {}),
      },
    });
    return { status: res.statusCode, body: res.body ? res.json() : undefined };
  }

  /** The token in the newest email of this kind to this address. */
  function linkToken(to: string, template: string): string {
    const message = [...mail.captured()]
      .reverse()
      .find((m) => m.to === to && m.template === template);
    if (!message) throw new Error(`no ${template} email to ${to}`);
    const token = /[?&]token=([A-Za-z0-9_-]+)/.exec(message.text)?.[1];
    if (!token) throw new Error(`no link in the ${template} email`);
    return token;
  }

  const address = () => `auth-${randomUUID()}@example.test`;

  async function signUp(email: string, password = PASSWORD) {
    return call('POST', '/v1/auth/signup', {
      email,
      name: 'Priya Tester',
      password,
      country: 'in',
      accept_terms: true,
      terms_version: 'T-1',
    });
  }

  /** A verified account, signed in. */
  async function account() {
    const email = address();
    expect((await signUp(email)).status).toBe(202);
    expect(
      (await call('POST', '/v1/auth/verify-email', { token: linkToken(email, 'verify_email') }))
        .status,
    ).toBe(200);
    const login = await call('POST', '/v1/auth/login', { email, password: PASSWORD });
    expect(login.status).toBe(200);
    return { email, tokens: login.body as { access_token: string; refresh_token: string } };
  }

  describe('sign-up and organization setup (§35.1, §35.2)', () => {
    it('refuses sign-in until the email is confirmed, then lets the person create their organization', async () => {
      const email = address();
      const signup = await signUp(email);
      expect(signup).toEqual({ status: 202, body: { status: 'verification_sent' } });

      const early = await call('POST', '/v1/auth/login', { email, password: PASSWORD });
      expect(early.status).toBe(403);
      expect(early.body.error.code).toBe('AUTH_002');

      const token = linkToken(email, 'verify_email');
      expect((await call('POST', '/v1/auth/verify-email', { token })).status).toBe(200);
      // Single use.
      expect((await call('POST', '/v1/auth/verify-email', { token })).status).toBe(400);

      const login = await call('POST', '/v1/auth/login', { email, password: PASSWORD });
      expect(login.status).toBe(200);
      const access = login.body.access_token as string;

      // Signed in, no organization yet: who am I works, everything else waits.
      const before = await call('GET', '/v1/me/context', undefined, { token: access });
      expect(before.status).toBe(200);
      expect(before.body.active_organization).toBeNull();
      expect(before.body.organizations).toEqual([]);
      const members = await call('GET', '/v1/organizations/members', undefined, { token: access });
      expect(members.status).toBe(403);

      const created = await call(
        'POST',
        '/v1/organizations',
        {
          name: 'Tangerine Travel',
          domain: `t${randomUUID().slice(0, 8)}.example`,
          type: 'BUYER',
          country: 'IN',
        },
        { token: access },
      );
      expect(created.status).toBe(201);

      const after = await call('GET', '/v1/me/context', undefined, { token: access });
      expect(after.body.active_organization.name).toBe('Tangerine Travel');
      expect(after.body.active_organization.verification_status).toBe(
        'BUSINESS_VERIFICATION_PENDING',
      );
      expect(after.body.permissions).toContain('campaign:draft');
    });

    it('answers a repeated sign-up exactly like a new one, and tells the owner by email', async () => {
      const { email } = await account();
      const again = await signUp(email, 'someone-elses-9-password');
      expect(again).toEqual({ status: 202, body: { status: 'verification_sent' } });
      expect(mail.lastTo(email)?.template).toBe('account_exists');

      // The existing password still works; the attempted one does not.
      expect((await call('POST', '/v1/auth/login', { email, password: PASSWORD })).status).toBe(
        200,
      );
      expect(
        (await call('POST', '/v1/auth/login', { email, password: 'someone-elses-9-password' }))
          .status,
      ).toBe(401);
    });

    it('refuses a weak password with a reason a person can act on', async () => {
      const res = await signUp(address(), 'qwerty123456');
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VAL_001');
      expect(res.body.error.field_errors[0].field).toBe('password');
      expect(res.body.error.message).toMatch(/most commonly used/);
    });
  });

  describe('sign-in protections', () => {
    it('gives one answer for an unknown email and for a wrong password', async () => {
      const { email } = await account();
      const unknown = await call('POST', '/v1/auth/login', {
        email: address(),
        password: PASSWORD,
      });
      const wrong = await call('POST', '/v1/auth/login', { email, password: 'not-the-password-7' });
      expect(unknown.status).toBe(401);
      expect(wrong.status).toBe(401);
      expect(unknown.body.error.message).toBe(wrong.body.error.message);
    });

    it('pauses sign-in after 10 failures -- even for the right password -- and emails the owner', async () => {
      const { email } = await account();
      // The guesses get an address of their own: account() already signed in
      // once from `caller`, and the tenth guess must meet the account lock,
      // not the per-IP budget of 10 sign-ins a minute.
      for (let i = 0; i < 10; i += 1) {
        const res = await call(
          'POST',
          '/v1/auth/login',
          { email, password: `wrong-guess-${i}-xyz` },
          { ip: `198.51.103.${n}` },
        );
        expect(res.status).toBe(401);
      }
      // From another address, so the per-IP budget is not what stops it.
      const right = await call(
        'POST',
        '/v1/auth/login',
        { email, password: PASSWORD },
        { ip: `198.51.102.${n}` },
      );
      expect(right.status).toBe(401);
      expect(right.body.error.message).toBe('Email or password is incorrect.');
      expect(mail.lastTo(email)?.template).toBe('account_locked');
    });

    it('never lets a cache keep a response that carries tokens', async () => {
      const { email } = await account();
      const res = await app.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: { email, password: PASSWORD },
        headers: { 'x-forwarded-for': caller },
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
    });

    it('stops a disabled account at once, even holding a live token', async () => {
      const { email, tokens } = await account();
      await prisma.user.update({ where: { email }, data: { status: 'DISABLED' } });
      const res = await call('GET', '/v1/me/context', undefined, { token: tokens.access_token });
      expect(res.status).toBe(401);
    });
  });

  describe('sessions', () => {
    it('rotates the refresh token, and treats a copied old one as theft', async () => {
      const { tokens } = await account();
      const first = await call('POST', '/v1/auth/refresh', { refresh_token: tokens.refresh_token });
      expect(first.status).toBe(200);
      expect(first.body.refresh_token).not.toBe(tokens.refresh_token);

      // A second refresh with the same token moments later is one page making
      // parallel calls, not theft.
      expect(
        (await call('POST', '/v1/auth/refresh', { refresh_token: tokens.refresh_token })).status,
      ).toBe(200);

      // Long after it was spent, the same token is a copy: the family ends.
      await prisma.authSession.updateMany({
        where: { refreshTokenHash: hashToken(tokens.refresh_token) },
        data: { rotatedAt: new Date(Date.now() - 120_000) },
      });
      expect(
        (await call('POST', '/v1/auth/refresh', { refresh_token: tokens.refresh_token })).status,
      ).toBe(401);
      expect(
        (await call('POST', '/v1/auth/refresh', { refresh_token: first.body.refresh_token }))
          .status,
      ).toBe(401);
    });

    it('signs out: the refresh token and the access token both stop working', async () => {
      const { tokens } = await account();
      expect(
        (await call('GET', '/v1/me/context', undefined, { token: tokens.access_token })).status,
      ).toBe(200);
      expect(
        (await call('POST', '/v1/auth/logout', { refresh_token: tokens.refresh_token })).status,
      ).toBe(204);
      expect(
        (await call('POST', '/v1/auth/refresh', { refresh_token: tokens.refresh_token })).status,
      ).toBe(401);
      // Not left to expire in ten minutes: a copy lifted before sign-out dies with it.
      expect(
        (await call('GET', '/v1/me/context', undefined, { token: tokens.access_token })).status,
      ).toBe(401);
    });

    it('ends every token of a sign-in once its refresh token is replayed', async () => {
      const { tokens } = await account();
      const next = await call('POST', '/v1/auth/refresh', { refresh_token: tokens.refresh_token });
      expect(next.status).toBe(200);
      await prisma.authSession.updateMany({
        where: { refreshTokenHash: hashToken(tokens.refresh_token) },
        data: { rotatedAt: new Date(Date.now() - 120_000) },
      });
      expect(
        (await call('POST', '/v1/auth/refresh', { refresh_token: tokens.refresh_token })).status,
      ).toBe(401);
      expect(
        (await call('GET', '/v1/me/context', undefined, { token: next.body.access_token })).status,
      ).toBe(401);
    });
  });

  describe('recovery', () => {
    it('resets a password by emailed link, and every earlier session ends with the old password', async () => {
      const { email, tokens } = await account();
      // Tokens carry whole-second timestamps; move past the second they were issued in.
      await new Promise((r) => setTimeout(r, 1100));

      const known = await call('POST', '/v1/auth/forgot-password', { email });
      const unknown = await call('POST', '/v1/auth/forgot-password', { email: address() });
      expect(known).toEqual(unknown);
      expect(known.status).toBe(202);

      const token = linkToken(email, 'password_reset');
      // A refused password does not spend the link.
      expect(
        (await call('POST', '/v1/auth/reset-password', { token, password: 'short' })).status,
      ).toBe(400);
      expect(
        (await call('POST', '/v1/auth/reset-password', { token, password: NEW_PASSWORD })).status,
      ).toBe(200);
      expect(
        (await call('POST', '/v1/auth/reset-password', { token, password: NEW_PASSWORD })).status,
      ).toBe(400);

      expect(
        (await call('GET', '/v1/me/context', undefined, { token: tokens.access_token })).status,
      ).toBe(401);
      expect(
        (await call('POST', '/v1/auth/refresh', { refresh_token: tokens.refresh_token })).status,
      ).toBe(401);
      expect((await call('POST', '/v1/auth/login', { email, password: PASSWORD })).status).toBe(
        401,
      );
      expect((await call('POST', '/v1/auth/login', { email, password: NEW_PASSWORD })).status).toBe(
        200,
      );
    });
  });

  describe('invitations (§35.3)', () => {
    it('invites a newcomer, who chooses a password from the email and lands in the organization', async () => {
      const admin = await account();
      const org = await call(
        'POST',
        '/v1/organizations',
        {
          name: 'Harbour Insurance',
          domain: `h${randomUUID().slice(0, 8)}.example`,
          type: 'BUYER',
          country: 'IN',
        },
        { token: admin.tokens.access_token },
      );
      expect(org.status).toBe(201);
      const orgId = org.body.organization_id as string;

      const newcomer = address();
      const invite = await call(
        'POST',
        '/v1/organizations/members/invite',
        { email: newcomer, name: 'Omar Newcomer', role: 'BUYER_OPERATOR' },
        { token: admin.tokens.access_token, orgId },
      );
      expect(invite.status).toBe(201);
      expect(invite.body.status).toBe('INVITED');

      const token = linkToken(newcomer, 'invitation');
      expect((await call('POST', '/v1/auth/accept-invite', { token })).status).toBe(400);
      const accepted = await call('POST', '/v1/auth/accept-invite', { token, password: PASSWORD });
      expect(accepted.status).toBe(200);

      const ctx = await call('GET', '/v1/me/context', undefined, {
        token: accepted.body.access_token,
      });
      expect(ctx.status).toBe(200);
      expect(ctx.body.active_organization.id).toBe(orgId);
      expect(ctx.body.active_organization.roles).toEqual(['BUYER_OPERATOR']);
    });
  });
});
