/**
 * Sign-up, sign-in and account recovery -- spec v5 §35.1, §82, §86.
 *
 * Oolix checks passwords itself now; docs/SECURITY-REVIEW.md records the
 * decision to leave the external identity provider, and the controls that
 * compensate for having no second factor.
 *
 * Three rules run through every method here:
 *
 *   Nothing reveals whether an email has an account. Sign-up and
 *   forgot-password answer identically either way (the owner of an existing
 *   account is told by email instead), sign-in failures share one message,
 *   and an unknown email still spends the time of a real password check.
 *
 *   A password is checked before anything is spent. A reset whose new
 *   password is refused leaves the link usable; the person just tries again.
 *
 *   Changing or resetting a password signs out every existing session.
 */
import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { OolixError } from '@oolix/contracts';
import {
  hashPassword,
  passwordProblems,
  verifyAgainstDecoy,
  verifyPassword,
  PASSWORD_MAX_LENGTH,
} from '@oolix/auth-rbac';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AuditService } from '../../common/audit/audit.service.js';
import { CONFIG, type OolixConfig } from '../../config/configuration.js';
import { AuthTokensService } from './auth-tokens.service.js';
import { SessionsService, type TokenPair } from './sessions.service.js';
import { PasswordBreachService } from './password-breach.service.js';
import { EmailService } from './email/email.service.js';
import {
  accountExistsMessage,
  accountLockedMessage,
  invitationMessage,
  passwordChangedMessage,
  passwordResetMessage,
  verifyEmailMessage,
} from './email/email.templates.js';

/** Consecutive failures before sign-in pauses, and for how long. */
export const LOCKOUT_THRESHOLD = 10;
export const LOCKOUT_MS = 15 * 60_000;

const email = z.string().trim().toLowerCase().email().max(254);
// The policy's own limit is 128 characters; this bound only stops a request
// from sending megabytes into a memory-hard hash.
const password = z
  .string()
  .min(1)
  .max(PASSWORD_MAX_LENGTH * 4);
const token = z.string().min(20).max(200);

export const SignupSchema = z.object({
  email,
  name: z.string().trim().min(2).max(100),
  password,
  country: z
    .string()
    .length(2)
    .transform((c) => c.toUpperCase()),
  /** §35.1: terms must be accepted, and the version accepted is kept. */
  accept_terms: z.literal(true),
  terms_version: z.string().min(1).max(40),
});
export type SignupInput = z.infer<typeof SignupSchema>;

export const LoginSchema = z.object({ email, password });
export type LoginInput = z.infer<typeof LoginSchema>;

export const EmailOnlySchema = z.object({ email });
export const TokenOnlySchema = z.object({ token });
export const ResetPasswordSchema = z.object({ token, password });
export const AcceptInviteSchema = z.object({
  token,
  password: password.optional(),
  name: z.string().trim().min(2).max(100).optional(),
});
export const RefreshSchema = z.object({ refresh_token: token });
export const ChangePasswordSchema = z.object({
  current_password: password,
  new_password: password,
});

const incorrect = () => new OolixError('AUTH_001', 'Email or password is incorrect.');

@Injectable()
export class AuthService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(AuthTokensService) private readonly tokens: AuthTokensService,
    @Inject(SessionsService) private readonly sessions: SessionsService,
    @Inject(PasswordBreachService) private readonly breach: PasswordBreachService,
    @Inject(EmailService) private readonly email: EmailService,
    @Inject(CONFIG) private readonly config: OolixConfig,
  ) {}

  // --- §35.1 sign-up ---------------------------------------------------------

  async signup(input: SignupInput): Promise<{ status: 'verification_sent' }> {
    await this.assertAcceptable(input.password, input.email, 'password');

    // Hashed before the lookup, so an existing address costs the same time as
    // a new one and the response time says nothing about who is registered.
    const passwordHash = await hashPassword(input.password);
    const existing = await this.prisma.user.findUnique({ where: { email: input.email } });

    if (existing) {
      await this.nudgeExistingAccount(existing);
      return { status: 'verification_sent' };
    }

    const id = randomUUID();
    const now = new Date();
    await this.prisma.user.create({
      data: {
        id,
        authSubject: `local:${id}`,
        email: input.email,
        name: input.name,
        country: input.country,
        termsVersion: input.terms_version,
        acceptedAt: now,
        status: 'PENDING_EMAIL_VERIFICATION',
        passwordHash,
        passwordChangedAt: now,
      },
    });
    await this.audit.record({
      action: 'USER_SIGNED_UP',
      entityType: 'user',
      entityId: id,
      actor: id,
      actorType: 'USER',
      metadata: { country: input.country, terms_version: input.terms_version },
    });
    await this.sendVerification({ id, name: input.name, email: input.email });
    return { status: 'verification_sent' };
  }

  /** Someone signed up with an address that already has an account. */
  private async nudgeExistingAccount(user: {
    id: string;
    name: string;
    email: string;
    status: string;
    passwordHash: string | null;
  }): Promise<void> {
    if (user.status === 'DISABLED') return;
    if (user.passwordHash === null) {
      // Invited, never accepted: a fresh invitation is the way in.
      const t = await this.tokens.issue(user.id, 'INVITATION');
      await this.email.send(
        'invitation',
        user.email,
        invitationMessage(user.name, null, this.link('/invite', t)),
      );
      return;
    }
    if (user.status === 'PENDING_EMAIL_VERIFICATION') {
      await this.sendVerification(user);
      return;
    }
    await this.email.send(
      'account_exists',
      user.email,
      accountExistsMessage(user.name, this.link('/login'), this.link('/forgot-password')),
    );
  }

  async verifyEmail(tokenValue: string): Promise<{ status: 'verified' }> {
    const t = await this.tokens.find(tokenValue, 'EMAIL_VERIFICATION');
    await this.prisma.$transaction(async (tx) => {
      await this.tokens.consume(t.id, tx);
      await tx.user.updateMany({
        where: { id: t.userId, status: 'PENDING_EMAIL_VERIFICATION' },
        data: { status: 'ACTIVE', emailVerifiedAt: new Date() },
      });
      await this.audit.recordTx(tx, {
        action: 'USER_EMAIL_VERIFIED',
        entityType: 'user',
        entityId: t.userId,
        actor: t.userId,
        actorType: 'USER',
      });
    });
    return { status: 'verified' };
  }

  async resendVerification(address: string): Promise<{ status: 'verification_sent' }> {
    const user = await this.prisma.user.findUnique({ where: { email: address } });
    if (user?.status === 'PENDING_EMAIL_VERIFICATION' && user.passwordHash) {
      await this.sendVerification(user);
    }
    return { status: 'verification_sent' };
  }

  // --- sign-in ---------------------------------------------------------------

  async login(input: LoginInput): Promise<TokenPair> {
    const user = await this.prisma.user.findUnique({ where: { email: input.email } });

    if (!user?.passwordHash) {
      await verifyAgainstDecoy(input.password);
      throw incorrect();
    }

    // Paused: refuse without checking the password at all. Checking it and
    // answering differently when it is right would turn the pause into an
    // oracle -- the one response that differs is the correct guess.
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      await verifyAgainstDecoy(input.password);
      throw incorrect();
    }

    const check = await verifyPassword(input.password, user.passwordHash);
    if (!check.ok) {
      await this.recordFailure(user);
      throw incorrect();
    }

    // Past this point the caller has proved they know the password, so it is
    // safe to be specific about why they still cannot come in.
    if (user.status === 'DISABLED') {
      throw new OolixError('AUTH_001', 'This account is disabled.');
    }
    if (user.status === 'PENDING_EMAIL_VERIFICATION') {
      throw new OolixError('AUTH_002', 'Confirm your email address before signing in.');
    }

    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        failedLoginCount: 0,
        lockedUntil: null,
        ...(check.needsRehash ? { passwordHash: await hashPassword(input.password) } : {}),
      },
    });
    await this.audit.record({
      action: 'USER_SIGNED_IN',
      entityType: 'user',
      entityId: user.id,
      actor: user.id,
      actorType: 'USER',
    });
    return this.sessions.start(user);
  }

  private async recordFailure(user: { id: string; name: string; email: string }): Promise<void> {
    const { failedLoginCount } = await this.prisma.user.update({
      where: { id: user.id },
      data: { failedLoginCount: { increment: 1 } },
      select: { failedLoginCount: true },
    });
    await this.audit.record({
      action: 'USER_SIGN_IN_FAILED',
      entityType: 'user',
      entityId: user.id,
      actorType: 'SYSTEM',
      metadata: { consecutive: failedLoginCount },
    });
    if (failedLoginCount >= LOCKOUT_THRESHOLD) {
      await this.prisma.user.update({
        where: { id: user.id },
        data: { failedLoginCount: 0, lockedUntil: new Date(Date.now() + LOCKOUT_MS) },
      });
      await this.audit.record({
        action: 'USER_SIGN_IN_PAUSED',
        entityType: 'user',
        entityId: user.id,
        actorType: 'SYSTEM',
        metadata: { minutes: LOCKOUT_MS / 60_000 },
      });
      // The owner learns of it by email; the sign-in form says nothing, so a
      // pause cannot be used to discover that an address has an account.
      await this.email.send(
        'account_locked',
        user.email,
        accountLockedMessage(user.name, this.link('/forgot-password')),
      );
    }
  }

  refresh(refreshToken: string): Promise<TokenPair> {
    return this.sessions.refresh(refreshToken);
  }

  logout(refreshToken: string): Promise<void> {
    return this.sessions.end(refreshToken);
  }

  // --- recovery --------------------------------------------------------------

  async forgotPassword(address: string): Promise<{ status: 'reset_sent' }> {
    const user = await this.prisma.user.findUnique({ where: { email: address } });
    if (user && user.status !== 'DISABLED') {
      const t = await this.tokens.issue(user.id, 'PASSWORD_RESET');
      await this.email.send(
        'password_reset',
        user.email,
        passwordResetMessage(user.name, this.link('/reset-password', t)),
      );
    }
    return { status: 'reset_sent' };
  }

  async resetPassword(
    tokenValue: string,
    newPassword: string,
  ): Promise<{ status: 'password_reset' }> {
    const t = await this.tokens.find(tokenValue, 'PASSWORD_RESET');
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: t.userId } });
    if (user.status === 'DISABLED') {
      throw new OolixError('VAL_001', 'This link is invalid or has expired.');
    }
    await this.assertAcceptable(newPassword, user.email, 'password');
    const passwordHash = await hashPassword(newPassword);
    const now = new Date();

    await this.prisma.$transaction(async (tx) => {
      await this.tokens.consume(t.id, tx);
      await tx.user.update({
        where: { id: user.id },
        data: {
          passwordHash,
          passwordChangedAt: now,
          failedLoginCount: 0,
          lockedUntil: null,
          // The link reached this inbox, which is proof enough of the address.
          // Accounts from before sign-in moved in-house are ACTIVE with no
          // record of that proof; this is where they get one.
          emailVerifiedAt: user.emailVerifiedAt ?? now,
          ...(user.status === 'PENDING_EMAIL_VERIFICATION' ? { status: 'ACTIVE' as const } : {}),
        },
      });
      // Someone invited who never chose a password has used the reset link
      // instead of the invitation. Same inbox, same proof: let them in.
      if (user.passwordHash === null) {
        await tx.organizationMember.updateMany({
          where: { userId: user.id, status: 'INVITED' },
          data: { status: 'ACTIVE' },
        });
      }
      await this.sessions.revokeAllForUser(user.id, tx);
      await this.audit.recordTx(tx, {
        action: 'USER_PASSWORD_RESET',
        entityType: 'user',
        entityId: user.id,
        actor: user.id,
        actorType: 'USER',
      });
    });

    await this.email.send(
      'password_changed',
      user.email,
      passwordChangedMessage(user.name, this.link('/forgot-password')),
    );
    return { status: 'password_reset' };
  }

  // --- §35.3 invitations -----------------------------------------------------

  async acceptInvitation(input: {
    token: string;
    password?: string;
    name?: string;
  }): Promise<{ status: 'accepted' } & Partial<TokenPair>> {
    const t = await this.tokens.find(input.token, 'INVITATION');
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: t.userId } });
    if (user.status === 'DISABLED') {
      throw new OolixError('VAL_001', 'This link is invalid or has expired.');
    }

    // Someone who already has an account just joins; someone new chooses a
    // password here, and the link itself proves the address.
    const isNew = user.passwordHash === null;
    let passwordHash: string | undefined;
    if (isNew) {
      if (!input.password) {
        throw new OolixError('VAL_001', 'Choose a password.', {
          fieldErrors: [{ field: 'password', message: 'required' }],
        });
      }
      await this.assertAcceptable(input.password, user.email, 'password');
      passwordHash = await hashPassword(input.password);
    }
    const now = new Date();

    await this.prisma.$transaction(async (tx) => {
      await this.tokens.consume(t.id, tx);
      await tx.user.update({
        where: { id: user.id },
        data: {
          status: 'ACTIVE',
          emailVerifiedAt: user.emailVerifiedAt ?? now,
          ...(passwordHash ? { passwordHash, passwordChangedAt: now } : {}),
          ...(isNew && input.name ? { name: input.name } : {}),
        },
      });
      await tx.organizationMember.updateMany({
        where: { userId: user.id, status: 'INVITED' },
        data: { status: 'ACTIVE' },
      });
      await this.audit.recordTx(tx, {
        action: 'MEMBER_INVITATION_ACCEPTED',
        entityType: 'user',
        entityId: user.id,
        actor: user.id,
        actorType: 'USER',
      });
    });

    // A newcomer is signed straight in; an existing account signs in the
    // usual way, so an emailed link never stands in for a known password.
    return isNew
      ? { status: 'accepted', ...(await this.sessions.start(user)) }
      : { status: 'accepted' };
  }

  /** Create or refresh an invitation link and email it. False if delivery failed. */
  async sendInvitation(userId: string, orgName: string): Promise<boolean> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const t = await this.tokens.issue(user.id, 'INVITATION');
    return this.email.send(
      'invitation',
      user.email,
      invitationMessage(user.name, orgName, this.link('/invite', t)),
    );
  }

  // --- signed-in -------------------------------------------------------------

  async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<TokenPair> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const check = user.passwordHash
      ? await verifyPassword(currentPassword, user.passwordHash)
      : { ok: false };
    if (!check.ok) {
      // A stolen session must not become an unlimited password oracle.
      await this.recordFailure(user);
      throw new OolixError('VAL_001', 'Your current password is incorrect.', {
        fieldErrors: [{ field: 'current_password', message: 'incorrect' }],
      });
    }
    if (currentPassword === newPassword) {
      throw new OolixError('VAL_001', 'Choose a password you are not already using.', {
        fieldErrors: [{ field: 'new_password', message: 'unchanged' }],
      });
    }
    await this.assertAcceptable(newPassword, user.email, 'new_password');
    const passwordHash = await hashPassword(newPassword);

    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: user.id },
        data: {
          passwordHash,
          passwordChangedAt: new Date(),
          failedLoginCount: 0,
          lockedUntil: null,
        },
      });
      await this.sessions.revokeAllForUser(user.id, tx);
      await this.audit.recordTx(tx, {
        action: 'USER_PASSWORD_CHANGED',
        entityType: 'user',
        entityId: user.id,
        actor: user.id,
        actorType: 'USER',
      });
    });

    await this.email.send(
      'password_changed',
      user.email,
      passwordChangedMessage(user.name, this.link('/forgot-password')),
    );
    // Every other session is gone; this one continues on a fresh sign-in.
    return this.sessions.start(user);
  }

  // --- helpers ---------------------------------------------------------------

  private async sendVerification(user: { id: string; name: string; email: string }): Promise<void> {
    const t = await this.tokens.issue(user.id, 'EMAIL_VERIFICATION');
    await this.email.send(
      'verify_email',
      user.email,
      verifyEmailMessage(user.name, this.link('/verify-email', t)),
    );
  }

  private async assertAcceptable(candidate: string, address: string, field: string): Promise<void> {
    const problems = passwordProblems(candidate, address);
    if (problems.length === 0 && (await this.breach.isBreached(candidate))) {
      problems.push('This password has appeared in a data breach. Choose another.');
    }
    if (problems.length > 0) {
      throw new OolixError('VAL_001', problems[0], {
        fieldErrors: problems.map((message) => ({ field, message })),
      });
    }
  }

  /** A portal address, with the one-time token as a query parameter. */
  private link(path: string, tokenValue?: string): string {
    const url = new URL(path, this.config.WEB_PUBLIC_URL);
    if (tokenValue) url.searchParams.set('token', tokenValue);
    return url.toString();
  }
}
