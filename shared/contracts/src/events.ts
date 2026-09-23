/**
 * Domain event catalogue and queue envelope -- spec v5 §22, §55, §74.
 *
 * Transport is SQS Standard: at-least-once, unordered across unrelated
 * entities (§74). Every consumer must therefore be idempotent and must reject
 * stale updates using the aggregate version carried in the envelope.
 */
import { z } from 'zod';

// --------------------------------------------------------------------------
// §22.1 control events + §22.2 data/report events + §55 job triggers
// --------------------------------------------------------------------------
export const EVENT_TYPES = [
  // Control plane
  'PARTNER_REQUEST_SUBMITTED',
  'PARTNER_REQUEST_APPROVED',
  'PARTNER_REQUEST_CHANGE_REQUESTED',
  'PARTNER_REQUEST_REJECTED',
  'PARTNER_REQUEST_EXPIRED',
  'MANIFEST_SIGNED',
  'MANIFEST_PUBLISHED',
  'ACTIVATION_READY',
  'ACTIVATION_LIVE',
  'ACTIVATION_PAUSED',
  'ACTIVATION_ENDED',
  'ACTIVATION_FAILED',
  'ACTIVATION_END_REQUESTED',
  'CHANNEL_ELIGIBILITY_FAILED',
  // Data / reporting
  'DELIVERY_BATCH_ACCEPTED',
  'LEAD_RECEIVED',
  'LEAD_QUALIFIED',
  'CONVERSION_RECORDED',
  'PARTNER_PAYOUT_CALCULATED',
  'CHANNEL_AUDIENCE_SYNC_REQUESTED',
  'CHANNEL_AUDIENCE_SYNCED',
  // Scheduled / operational
  'PAYOUT_CALCULATION_DUE',
  'CONNECTION_EXPIRY_CHECK',
  'NETWORK_INVITATION',
  'CAMPAIGN_ENDING_SOON',
  'KILL_SWITCH_ACTIVATED',
  'CONSENT_WITHDRAWAL_CLEANUP_REQUESTED',
] as const;

export type EventType = (typeof EVENT_TYPES)[number];
export const EventTypeSchema = z.enum(EVENT_TYPES);

// --------------------------------------------------------------------------
// §74 canonical envelope
// --------------------------------------------------------------------------

/**
 * ISO-8601 UTC. Defined by refinement rather than a zod version-specific
 * datetime helper so the contract does not move when zod does (§53: UTC
 * ISO-8601 over the API).
 */
export const IsoDateTimeSchema = z
  .string()
  .refine((v) => !Number.isNaN(Date.parse(v)), { message: 'must be an ISO-8601 date-time' });

export const EventEnvelopeSchema = z.object({
  id: z.string().min(1),
  event_type: EventTypeSchema,
  event_version: z.number().int().positive(),
  occurred_at: IsoDateTimeSchema,
  correlation_id: z.string().min(1),
  source: z.string().min(1),
  aggregate: z.object({
    type: z.string().min(1),
    id: z.string().min(1),
    version: z.number().int().nonnegative(),
  }),
  data: z.record(z.string(), z.unknown()),
  metadata: z
    .object({ attempt: z.number().int().nonnegative().default(0) })
    .catchall(z.unknown())
    .default({ attempt: 0 }),
});

export type EventEnvelope = z.infer<typeof EventEnvelopeSchema>;

// --------------------------------------------------------------------------
// §74 retry policy
// --------------------------------------------------------------------------

/** Backoff ladder in milliseconds: 1s, 5s, 30s, 2m, 10m. */
export const RETRY_BACKOFF_MS: readonly number[] = [1_000, 5_000, 30_000, 120_000, 600_000];

/** §74: max receive attempts before the message goes to the DLQ. */
export const MAX_RECEIVE_ATTEMPTS = 5;

export function backoffForAttempt(attempt: number): number {
  const idx = Math.min(Math.max(attempt, 0), RETRY_BACKOFF_MS.length - 1);
  return RETRY_BACKOFF_MS[idx] ?? RETRY_BACKOFF_MS[RETRY_BACKOFF_MS.length - 1]!;
}

/**
 * §74: poison messages go to the DLQ and alert. There is no infinite retry.
 */
export function shouldDeadLetter(attempt: number): boolean {
  return attempt >= MAX_RECEIVE_ATTEMPTS;
}

// --------------------------------------------------------------------------
// §22.3 idempotency key construction
//
// Centralised so producer and consumer cannot drift on key shape -- a drift
// here silently duplicates business outcomes (double payout, double lead).
// --------------------------------------------------------------------------
export const IdempotencyKeys = {
  campaignSubmission: (buyerOrgId: string, clientRequestId: string) =>
    `campaign_submit:${buyerOrgId}:${clientRequestId}`,
  partnerApproval: (requestId: string, decisionVersion: number) =>
    `partner_approval:${requestId}:${decisionVersion}`,
  reportBatch: (partnerOrgId: string, batchId: string) => `report_batch:${partnerOrgId}:${batchId}`,
  externalSync: (activationId: string, audienceVersion: number) =>
    `external_sync:${activationId}:${audienceVersion}`,
  leadUpdate: (buyerOrgId: string, crmEventId: string) => `lead_event:${buyerOrgId}:${crmEventId}`,
} as const;

/** §99: idempotency records default to 24h retention for write APIs. */
export const IDEMPOTENCY_RETENTION_HOURS = 24;

/** Longer retention for financial / external sync operations (§99). */
export const IDEMPOTENCY_RETENTION_HOURS_FINANCIAL = 24 * 30;

// --------------------------------------------------------------------------
// Logical queues (§74)
// --------------------------------------------------------------------------
export const QUEUES = ['domain-events', 'reporting', 'channel-sync'] as const;
export type QueueName = (typeof QUEUES)[number];

/** Which queue each event type is published to. */
export const EVENT_QUEUE: Readonly<Record<EventType, QueueName>> = Object.freeze({
  PARTNER_REQUEST_SUBMITTED: 'domain-events',
  PARTNER_REQUEST_APPROVED: 'domain-events',
  PARTNER_REQUEST_CHANGE_REQUESTED: 'domain-events',
  PARTNER_REQUEST_REJECTED: 'domain-events',
  PARTNER_REQUEST_EXPIRED: 'domain-events',
  MANIFEST_SIGNED: 'domain-events',
  MANIFEST_PUBLISHED: 'domain-events',
  ACTIVATION_READY: 'domain-events',
  ACTIVATION_LIVE: 'domain-events',
  ACTIVATION_PAUSED: 'domain-events',
  ACTIVATION_ENDED: 'domain-events',
  ACTIVATION_FAILED: 'domain-events',
  ACTIVATION_END_REQUESTED: 'domain-events',
  CHANNEL_ELIGIBILITY_FAILED: 'domain-events',
  NETWORK_INVITATION: 'domain-events',
  CAMPAIGN_ENDING_SOON: 'domain-events',
  KILL_SWITCH_ACTIVATED: 'domain-events',
  PAYOUT_CALCULATION_DUE: 'domain-events',
  CONNECTION_EXPIRY_CHECK: 'domain-events',
  PARTNER_PAYOUT_CALCULATED: 'domain-events',
  DELIVERY_BATCH_ACCEPTED: 'reporting',
  LEAD_RECEIVED: 'reporting',
  LEAD_QUALIFIED: 'reporting',
  CONVERSION_RECORDED: 'reporting',
  CHANNEL_AUDIENCE_SYNC_REQUESTED: 'channel-sync',
  CHANNEL_AUDIENCE_SYNCED: 'channel-sync',
  CONSENT_WITHDRAWAL_CLEANUP_REQUESTED: 'channel-sync',
});
