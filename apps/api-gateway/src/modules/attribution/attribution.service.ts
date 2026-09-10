/**
 * Attribution token registry -- spec v5 §14, §71, §90.
 *
 * §90 fixes the shape of this data and the reason for it:
 *
 *   "The click token is opaque. It does not contain activation_id,
 *    partner_id, placement_id, creative_id, timestamps or a nonce. Those
 *    values exist only in Oolix's server-side attribution_tokens row keyed by
 *    token_hash."
 *
 * The Partner Agent mints the raw token, hands it to the browser, and uploads
 * ONLY its SHA-256 here. Oolix therefore learns which activation produced a
 * click without ever holding a value that could be replayed as one.
 */
import { Injectable, Inject } from '@nestjs/common';
import { z } from 'zod';
import { OolixError } from '@oolix/contracts';
import { PrismaService } from '../../prisma/prisma.service.js';
import { CONFIG, type OolixConfig } from '../../config/configuration.js';
import { toBytes } from '../../common/bytes.js';

export const RegisterTokensSchema = z.object({
  tokens: z
    .array(
      z.object({
        /** SHA-256 of the raw token, lowercase hex (§90). */
        token_hash: z.string().regex(/^[0-9a-f]{64}$/, 'lowercase hex sha-256'),
        activation_id: z.string().uuid(),
        creative_version_id: z.string().uuid().optional(),
        placement_key: z.string().max(120).optional(),
        issued_at: z.string().refine((v) => !Number.isNaN(Date.parse(v)), 'ISO-8601 date-time'),
      }),
    )
    .min(1)
    // §86 batches reporting rather than one request per impression.
    .max(1000),
});
export type RegisterTokensInput = z.infer<typeof RegisterTokensSchema>;

@Injectable()
export class AttributionService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(CONFIG) private readonly config: OolixConfig,
  ) {}

  /**
   * Register a batch of token hashes uploaded by a Partner Agent.
   *
   * Scoped by the Agent's own partner id: an Agent can only register tokens
   * against activations belonging to ITS Partner (§92.4). Without that check
   * one Partner's Agent could manufacture attributable clicks against
   * another's activation and be paid for them.
   */
  async registerTokens(partnerOrgId: string, input: RegisterTokensInput) {
    const activationIds = [...new Set(input.tokens.map((t) => t.activation_id))];

    const owned = await this.prisma.activation.findMany({
      where: { id: { in: activationIds }, request: { partnerOrgId } },
      select: { id: true, placementId: true },
    });
    const ownedIds = new Set(owned.map((a) => a.id));

    const foreign = activationIds.filter((id) => !ownedIds.has(id));
    if (foreign.length > 0) {
      throw new OolixError('PERM_002', 'One or more activations do not belong to this Partner.');
    }

    const placementByActivation = new Map(owned.map((a) => [a.id, a.placementId]));
    const ttlMs = this.config.CLICK_TOKEN_TTL_DAYS * 86_400_000;

    const rows = input.tokens.map((t) => {
      const issuedAt = new Date(t.issued_at);
      return {
        tokenHash: toBytes(Buffer.from(t.token_hash, 'hex')),
        activationId: t.activation_id,
        partnerOrgId,
        placementId: placementByActivation.get(t.activation_id) ?? null,
        creativeVersionId: t.creative_version_id ?? null,
        issuedAt,
        // §71: default 7 days; a campaign may configure a shorter window.
        expiresAt: new Date(issuedAt.getTime() + ttlMs),
        leadState: 'UNREDEEMED' as const,
      };
    });

    // §74: the Agent retries a failed batch with the same contents, so a
    // duplicate hash is expected and must not fail the whole upload.
    const result = await this.prisma.attributionToken.createMany({
      data: rows,
      skipDuplicates: true,
    });

    return { accepted: result.count, submitted: input.tokens.length };
  }
}
