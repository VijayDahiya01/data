/**
 * One-time links sent by email: verify an address, reset a password, accept
 * an invitation.
 *
 * A token is 256 random bits. Only its SHA-256 is stored -- the token itself
 * exists in the email alone, so reading the database yields no usable link.
 * Each is bound to one purpose, expires, and is spent exactly once: `consume`
 * is a conditional update, so two requests racing on one link cannot both win.
 * Issuing a new link of a purpose retires the previous unused one, so only the
 * most recent email ever works.
 */
import { createHash, randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { OolixError } from '@oolix/contracts';
import { PrismaService } from '../../prisma/prisma.service.js';

export type AuthTokenPurpose = 'EMAIL_VERIFICATION' | 'PASSWORD_RESET' | 'INVITATION';

const LIFETIME_MS: Record<AuthTokenPurpose, number> = {
  EMAIL_VERIFICATION: 24 * 3_600_000,
  // Short: a reset link is a password-change credential for as long as it lives.
  PASSWORD_RESET: 30 * 60_000,
  INVITATION: 7 * 24 * 3_600_000,
};

/** SHA-256, hex. Tokens are random, so no salt is needed to defeat lookup tables. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

const invalidLink = () => new OolixError('VAL_001', 'This link is invalid or has expired.');

type Client = Pick<PrismaService, 'authToken'>;

@Injectable()
export class AuthTokensService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async issue(userId: string, purpose: AuthTokenPurpose): Promise<string> {
    const token = randomBytes(32).toString('base64url');
    await this.prisma.$transaction([
      this.prisma.authToken.deleteMany({ where: { userId, purpose, usedAt: null } }),
      this.prisma.authToken.create({
        data: {
          userId,
          purpose,
          tokenHash: hashToken(token),
          expiresAt: new Date(Date.now() + LIFETIME_MS[purpose]),
        },
      }),
    ]);
    return token;
  }

  /** The live token behind a link, without spending it. */
  async find(token: string, purpose: AuthTokenPurpose): Promise<{ id: string; userId: string }> {
    const row = await this.prisma.authToken.findUnique({ where: { tokenHash: hashToken(token) } });
    if (!row || row.purpose !== purpose || row.usedAt || row.expiresAt <= new Date()) {
      throw invalidLink();
    }
    return { id: row.id, userId: row.userId };
  }

  /** Spend it. Exactly one caller succeeds; everyone else is told the link is spent. */
  async consume(id: string, client: Client = this.prisma): Promise<void> {
    const { count } = await client.authToken.updateMany({
      where: { id, usedAt: null },
      data: { usedAt: new Date() },
    });
    if (count !== 1) throw invalidLink();
  }
}
