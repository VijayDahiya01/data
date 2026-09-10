/**
 * Click, lead and conversion attribution -- spec v5 §14, §44, §71, §90.
 *
 * The chain this service completes:
 *
 *   Agent mints an opaque token  ->  browser carries it to the Buyer's
 *   landing page  ->  Buyer stores it with the lead  ->  Buyer CRM posts
 *   lead status back  ->  Oolix attributes the outcome to a Partner activation
 *
 * At no point does anyone learn who the person is. §14.1: the token itself
 * "contains no readable campaign or Partner metadata", and Oolix resolves it
 * only by SHA-256. The Buyer knows the person because THEY submitted a form on
 * the Buyer's own site; the Partner knows nothing about that; Oolix knows only
 * that activation X produced a qualified lead.
 */
import { Injectable, Inject } from '@nestjs/common';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { LEAD_TRANSITIONS, OolixError, canTransition, type LeadState } from '@oolix/contracts';
import { tokenHashPrefix } from '@oolix/observability';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AuditService } from '../../common/audit/audit.service.js';
import { toBytes } from '../../common/bytes.js';

/** §71 CRM callback payload. */
export const LeadEventSchema = z.object({
  /** The RAW opaque token the Buyer stored with the lead (§90). */
  click_token: z.string().min(20).max(200),
  /** §22.3 idempotency: buyer_org_id + crm_event_id. */
  crm_event_id: z.string().min(1).max(200),
  status: z.enum(['RECEIVED', 'VALID', 'QUALIFIED', 'CONVERTED', 'REJECTED']),
  event_time: z.string().refine((v) => !Number.isNaN(Date.parse(v)), 'ISO-8601 date-time'),
  /** The Buyer's own lead reference. Opaque to Oolix. */
  lead_reference: z.string().max(200).optional(),
  metadata: z
    .object({
      qualification_reason: z.string().max(500).optional(),
      rejection_reason: z.string().max(500).optional(),
    })
    .catchall(z.unknown())
    .default({}),
});
export type LeadEventInput = z.infer<typeof LeadEventSchema>;

export const LeadEventBatchSchema = z.object({
  events: z.array(LeadEventSchema).min(1).max(500),
});
export type LeadEventBatchInput = z.infer<typeof LeadEventBatchSchema>;

function sha256(value: string): Uint8Array<ArrayBuffer> {
  return toBytes(createHash('sha256').update(value).digest());
}

@Injectable()
export class LeadService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  // -------------------------------------------------------------------------
  // §71 CRM authentication
  // -------------------------------------------------------------------------

  /**
   * Issue a CRM API key for a Buyer.
   *
   * §71: "API keys are hashed at rest and can be rotated." The plaintext is
   * returned exactly once; only its hash is stored, so a database read yields
   * nothing that can post lead events.
   */
  async issueCrmKey(buyerOrgId: string) {
    const key = `oolix_crm_${randomBytes(32).toString('base64url')}`;

    await this.prisma.buyerProfile.upsert({
      where: { orgId: buyerOrgId },
      create: { orgId: buyerOrgId, crmApiKeyHash: sha256(key) },
      update: { crmApiKeyHash: sha256(key) },
    });

    await this.audit.record({
      action: 'CRM_API_KEY_ISSUED',
      entityType: 'buyer_profile',
      entityId: buyerOrgId,
      orgId: buyerOrgId,
      // The key itself is never audited (§78.1).
      metadata: { rotated: true },
    });

    return {
      api_key: key,
      warning: 'This key is shown once. Store it in your secret manager and rotate as needed.',
    };
  }

  /**
   * Resolve a CRM API key to its Buyer organization.
   *
   * The lookup is by hash, and the comparison is constant-time: a timing
   * difference would let an attacker discover a valid key byte by byte.
   */
  async authenticateCrm(apiKey: string): Promise<string> {
    const hash = sha256(apiKey);

    const profiles = await this.prisma.buyerProfile.findMany({
      where: { crmApiKeyHash: { not: null } },
      select: { orgId: true, crmApiKeyHash: true },
    });

    for (const p of profiles) {
      if (!p.crmApiKeyHash) continue;
      const stored = Buffer.from(p.crmApiKeyHash);
      const candidate = Buffer.from(hash);
      if (stored.length === candidate.length && timingSafeEqual(stored, candidate)) {
        return p.orgId;
      }
    }

    throw new OolixError('AUTH_001', 'Invalid CRM API key.');
  }

  // -------------------------------------------------------------------------
  // §14 / §44 step 15: the click
  // -------------------------------------------------------------------------

  /**
   * Record the first click for a token.
   *
   * §71 stores `first_clicked_at` rather than counting clicks: a token maps to
   * one logical lead, so a user returning to the landing page is not a second
   * outcome. §50 also forbids paying a Partner from unverified client-side
   * clicks, so this timestamp is delivery evidence, never a settlement input.
   */
  async recordClick(rawToken: string) {
    const hash = sha256(rawToken);

    const token = await this.prisma.attributionToken.findUnique({
      where: { tokenHash: hash },
      include: { activation: true },
    });

    // A token Oolix has never seen, or that has expired, is simply not
    // attributable. The response is deliberately identical either way so a
    // caller cannot probe for valid tokens.
    if (!token || token.revokedAt || token.expiresAt.getTime() <= Date.now()) {
      return { attributed: false };
    }

    if (!token.firstClickedAt) {
      await this.prisma.attributionToken.update({
        where: { tokenHash: hash },
        data: { firstClickedAt: new Date() },
      });
    }

    return { attributed: true, activation_id: token.activationId };
  }

  // -------------------------------------------------------------------------
  // §71 lead events
  // -------------------------------------------------------------------------

  /**
   * Ingest a batch of CRM lead events.
   *
   * Each event is independent: one bad event does not reject the batch, because
   * a CRM retrying the whole batch after a single validation failure would
   * stall every other lead in it.
   */
  async ingestEvents(buyerOrgId: string, input: LeadEventBatchInput) {
    const results = [];
    for (const event of input.events) {
      try {
        results.push(await this.ingestOne(buyerOrgId, event));
      } catch (err) {
        results.push({
          crm_event_id: event.crm_event_id,
          accepted: false,
          error: err instanceof OolixError ? err.code : 'SYS_002',
          message: err instanceof Error ? err.message : 'unknown error',
        });
      }
    }

    return {
      accepted: results.filter((r) => r.accepted).length,
      rejected: results.filter((r) => !r.accepted).length,
      results,
    };
  }

  private async ingestOne(buyerOrgId: string, event: LeadEventInput) {
    const hash = sha256(event.click_token);

    // §22.3 / §71: idempotency on (buyer_org_id, crm_event_id). A CRM retry
    // storm must not inflate the lead count -- and therefore the payout.
    const existing = await this.prisma.leadEvent.findUnique({
      where: { buyerOrgId_crmEventId: { buyerOrgId, crmEventId: event.crm_event_id } },
    });
    if (existing) {
      return {
        crm_event_id: event.crm_event_id,
        accepted: true,
        duplicate: true,
        status: existing.status,
      };
    }

    const token = await this.prisma.attributionToken.findUnique({
      where: { tokenHash: hash },
      include: { activation: { include: { request: { include: { campaign: true } } } } },
    });

    if (!token) {
      throw new OolixError('PART_001', 'Unknown attribution token.');
    }

    // Scope check: a Buyer may only report outcomes for ITS OWN campaigns.
    // Without this, one Buyer's CRM key could manufacture qualified leads
    // against another Buyer's activation and distort a Partner's payout.
    if (token.activation.request.campaign.buyerOrgId !== buyerOrgId) {
      throw new OolixError('PERM_002', 'This token does not belong to your organization.');
    }

    if (token.revokedAt) {
      throw new OolixError('CAMP_002', 'This attribution token has been revoked.');
    }

    // §71 state machine: forward transitions only.
    const from = token.leadState as LeadState;
    const to = event.status as LeadState;

    if (from === to) {
      // Re-asserting the current state is harmless and idempotent.
      await this.recordEventRow(buyerOrgId, hash, event, from);
      return { crm_event_id: event.crm_event_id, accepted: true, status: to, unchanged: true };
    }

    if (!canTransition(LEAD_TRANSITIONS, from, to)) {
      // §71: "Reject contradictory or backward transitions unless privileged
      // correction workflow is used." A CRM that reports QUALIFIED and then
      // RECEIVED is describing a different lead, or is confused; either way
      // silently accepting it would corrupt the settlement basis.
      throw new OolixError(
        'CAMP_002',
        `Invalid lead transition ${from} -> ${to} (spec §71). ` +
          'Corrections require the privileged correction workflow.',
      );
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.leadEvent.create({
        data: {
          tokenHash: hash,
          buyerOrgId,
          crmEventId: event.crm_event_id,
          status: to as never,
          previousStatus: from as never,
          eventTime: new Date(event.event_time),
          leadReference: event.lead_reference ?? null,
          // §78.1: the Buyer's own qualification notes are retained; anything
          // identifying a person is the Buyer's to hold, not ours.
          metadata: event.metadata as never,
        },
      });

      await tx.attributionToken.update({
        where: { tokenHash: hash },
        data: { leadState: to as never },
      });
    });

    await this.audit.record({
      action: `LEAD_${to}`,
      entityType: 'activation',
      entityId: token.activationId,
      orgId: buyerOrgId,
      actorType: 'SYSTEM',
      metadata: {
        // §71: "Log only token_hash prefix, never the raw token."
        token_hash_prefix: tokenHashPrefix(token.tokenHash),
        from,
        to,
        crm_event_id: event.crm_event_id,
      },
    });

    return {
      crm_event_id: event.crm_event_id,
      accepted: true,
      status: to,
      activation_id: token.activationId,
    };
  }

  private async recordEventRow(
    buyerOrgId: string,
    hash: Uint8Array<ArrayBuffer>,
    event: LeadEventInput,
    status: LeadState,
  ) {
    await this.prisma.leadEvent.create({
      data: {
        tokenHash: hash,
        buyerOrgId,
        crmEventId: event.crm_event_id,
        status: status as never,
        previousStatus: status as never,
        eventTime: new Date(event.event_time),
        leadReference: event.lead_reference ?? null,
        metadata: event.metadata as never,
      },
    });
  }

  /**
   * §44 step 17 / §49: outcome counts for one activation.
   *
   * Counted from the CURRENT lead state of each token, not from the event log:
   * a lead that went RECEIVED -> VALID -> QUALIFIED is ONE qualified lead, not
   * three outcomes. §102 settles on "the verified CRM-linked QUALIFIED state
   * count".
   */
  async outcomesForActivation(activationId: string) {
    const rows = await this.prisma.attributionToken.groupBy({
      by: ['leadState'],
      where: { activationId },
      _count: { _all: true },
    });

    const byState = Object.fromEntries(rows.map((r) => [r.leadState, r._count._all]));

    return {
      unredeemed: byState.UNREDEEMED ?? 0,
      received: byState.RECEIVED ?? 0,
      valid: byState.VALID ?? 0,
      qualified: byState.QUALIFIED ?? 0,
      converted: byState.CONVERTED ?? 0,
      rejected: byState.REJECTED ?? 0,
    };
  }
}
