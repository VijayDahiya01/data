/**
 * Signed-in sessions: a short access token plus a rotating refresh token.
 *
 * Each sign-in starts a FAMILY of refresh tokens with a fixed absolute end
 * (USER_SESSION_TTL_HOURS). Refreshing spends the presented token and issues
 * a new one in the same family; the family's end never moves.
 *
 * Presenting a token that was already spent means two parties hold it -- the
 * portal and whoever copied it -- so the whole family is revoked and both are
 * signed out. The exception is a short grace window: one page render can make
 * several API calls in parallel, each finding the access token expired and
 * refreshing with the same token. Treating that as theft would sign people out
 * at random, so a token spent within the last 30 seconds may be spent again.
 * Past the window it is a copy.
 *
 * Revocation is immediate for access tokens too: every token names its family
 * (`sid`), and the auth guard refuses one whose family is revoked or past its
 * end, inside the user lookup it makes on every call anyway.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { OolixError } from '@oolix/contracts';
import { issueUserAccessToken } from '@oolix/auth-rbac';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AuditService } from '../../common/audit/audit.service.js';
import { CONFIG, type OolixConfig } from '../../config/configuration.js';
import { UserKeyService } from '../../keys/user-key.service.js';
import { hashToken } from './auth-tokens.service.js';

const REUSE_GRACE_MS = 30_000;

export interface TokenPair {
  access_token: string;
  token_type: 'Bearer';
  /** Seconds. */
  expires_in: number;
  refresh_token: string;
  /** When the whole sign-in ends, however often it is refreshed. */
  session_expires_at: string;
}

const signedOut = () => new OolixError('AUTH_001', 'Your session has ended. Please sign in again.');

@Injectable()
export class SessionsService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(CONFIG) private readonly config: OolixConfig,
    @Inject(UserKeyService) private readonly keys: UserKeyService,
  ) {}

  async start(user: { id: string; email: string }): Promise<TokenPair> {
    const familyId = randomUUID();
    const refreshToken = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + this.config.USER_SESSION_TTL_HOURS * 3_600_000);
    await this.prisma.authSession.create({
      data: { userId: user.id, familyId, refreshTokenHash: hashToken(refreshToken), expiresAt },
    });
    return this.pair(user, familyId, refreshToken, expiresAt);
  }

  async refresh(refreshToken: string): Promise<TokenPair> {
    const row = await this.prisma.authSession.findUnique({
      where: { refreshTokenHash: hashToken(refreshToken) },
      include: { user: { select: { id: true, email: true, status: true } } },
    });
    const now = new Date();
    if (!row || row.revokedAt || row.expiresAt <= now) throw signedOut();

    if (row.user.status !== 'ACTIVE') {
      await this.revokeFamily(row.familyId);
      throw signedOut();
    }

    // Claim the rotation. Exactly one request flips rotated_at from null.
    const { count } = await this.prisma.authSession.updateMany({
      where: { id: row.id, rotatedAt: null },
      data: { rotatedAt: now },
    });
    if (count === 0) {
      const spent = await this.prisma.authSession.findUnique({
        where: { id: row.id },
        select: { rotatedAt: true },
      });
      const spentAt = spent?.rotatedAt ?? row.rotatedAt;
      if (!spentAt || now.getTime() - spentAt.getTime() > REUSE_GRACE_MS) {
        await this.revokeFamily(row.familyId);
        await this.audit.record({
          action: 'SESSION_REFRESH_REUSED',
          entityType: 'user',
          entityId: row.userId,
          actor: row.userId,
          actorType: 'USER',
          metadata: { family_id: row.familyId },
        });
        throw signedOut();
      }
    }

    const next = randomBytes(32).toString('base64url');
    await this.prisma.authSession.create({
      data: {
        userId: row.userId,
        familyId: row.familyId,
        refreshTokenHash: hashToken(next),
        expiresAt: row.expiresAt,
      },
    });
    return this.pair(row.user, row.familyId, next, row.expiresAt);
  }

  /** Sign out: the whole family, so no sibling token outlives it. Idempotent. */
  async end(refreshToken: string): Promise<void> {
    const row = await this.prisma.authSession.findUnique({
      where: { refreshTokenHash: hashToken(refreshToken) },
      select: { familyId: true },
    });
    if (row) await this.revokeFamily(row.familyId);
  }

  async revokeFamily(familyId: string): Promise<void> {
    await this.prisma.authSession.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  /** Every session the user has -- after a password change or reset. */
  async revokeAllForUser(
    userId: string,
    client: Pick<PrismaService, 'authSession'> = this.prisma,
  ): Promise<void> {
    await client.authSession.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  private async pair(
    user: { id: string; email: string },
    familyId: string,
    refreshToken: string,
    expiresAt: Date,
  ): Promise<TokenPair> {
    const { access_token, expires_in } = await issueUserAccessToken(
      { sub: user.id, email: user.email, sid: familyId },
      this.keys.signer(),
      this.keys.kid(),
      { issuer: this.config.API_PUBLIC_URL, ttlSeconds: this.config.USER_ACCESS_TOKEN_TTL_SEC },
    );
    return {
      access_token,
      token_type: 'Bearer',
      expires_in,
      refresh_token: refreshToken,
      session_expires_at: expiresAt.toISOString(),
    };
  }
}
