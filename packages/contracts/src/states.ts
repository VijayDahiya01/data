/**
 * Canonical state machines -- spec v5 §76 (+ §101 EXPIRED).
 *
 * §42 rule, restated in §76: never collapse multi-Partner status into one
 * campaign field. The parent campaign is an aggregate VIEW; each Partner
 * request and each activation carries its own independent state and reason.
 */
import { z } from 'zod';

// --------------------------------------------------------------------------
// Parent campaign (aggregate view over its activations)
// --------------------------------------------------------------------------
export const CAMPAIGN_STATES = [
  'DRAFT',
  'SUBMITTED',
  'PARTIALLY_APPROVED',
  'READY',
  'PARTIALLY_LIVE',
  'LIVE',
  'PAUSED',
  'ENDED',
  'SETTLED',
] as const;
export type CampaignState = (typeof CAMPAIGN_STATES)[number];
export const CampaignStateSchema = z.enum(CAMPAIGN_STATES);

// --------------------------------------------------------------------------
// Partner request
// §76: PARTNER_REVIEW is canonical. Do NOT also create PENDING_APPROVAL.
// §101: EXPIRED is a real state; it is neither approval nor rejection.
// --------------------------------------------------------------------------
export const PARTNER_REQUEST_STATES = [
  'DRAFT',
  'PARTNER_REVIEW',
  'CHANGE_REQUESTED',
  'APPROVED',
  'REJECTED',
  'REVOKED',
  'EXPIRED',
] as const;
export type PartnerRequestState = (typeof PARTNER_REQUEST_STATES)[number];
export const PartnerRequestStateSchema = z.enum(PARTNER_REQUEST_STATES);

export const PARTNER_REQUEST_TRANSITIONS: Readonly<
  Record<PartnerRequestState, readonly PartnerRequestState[]>
> = Object.freeze({
  DRAFT: ['PARTNER_REVIEW'],
  PARTNER_REVIEW: ['APPROVED', 'REJECTED', 'CHANGE_REQUESTED', 'EXPIRED', 'REVOKED'],
  // Buyer edits and resubmits; that creates a new request_version (§41).
  CHANGE_REQUESTED: ['PARTNER_REVIEW', 'REVOKED', 'EXPIRED'],
  APPROVED: ['REVOKED'],
  // §76: REJECTED cannot become APPROVED without a new request version.
  REJECTED: [],
  REVOKED: [],
  // §101: expiry is not rejection; the Buyer clones into a NEW request.
  EXPIRED: [],
});

// --------------------------------------------------------------------------
// Activation (one per Partner x channel -- §13)
// --------------------------------------------------------------------------
export const ACTIVATION_STATES = [
  'PENDING_CHANNEL_CHECK',
  'READY',
  'SYNCING',
  'LIVE',
  'PAUSED',
  'FAILED',
  'ENDING',
  'ENDED',
] as const;
export type ActivationState = (typeof ACTIVATION_STATES)[number];
export const ActivationStateSchema = z.enum(ACTIVATION_STATES);

export const ACTIVATION_TRANSITIONS: Readonly<Record<ActivationState, readonly ActivationState[]>> =
  Object.freeze({
    PENDING_CHANNEL_CHECK: ['READY', 'FAILED', 'ENDING'],
    READY: ['SYNCING', 'LIVE', 'PAUSED', 'FAILED', 'ENDING'],
    SYNCING: ['LIVE', 'FAILED', 'ENDING'],
    LIVE: ['PAUSED', 'ENDING', 'FAILED'],
    // §76: PAUSED may go to LIVE or ENDING.
    PAUSED: ['LIVE', 'ENDING'],
    FAILED: ['ENDING', 'READY'],
    ENDING: ['ENDED'],
    ENDED: [],
  });

// --------------------------------------------------------------------------
// External audience sync (§76)
// --------------------------------------------------------------------------
export const EXTERNAL_SYNC_STATES = [
  'NOT_STARTED',
  'PREPARING',
  'UPLOADING',
  'PROCESSING',
  'READY',
  'FAILED',
  'REMOVING',
  'REMOVED',
] as const;
export type ExternalSyncState = (typeof EXTERNAL_SYNC_STATES)[number];
export const ExternalSyncStateSchema = z.enum(EXTERNAL_SYNC_STATES);

export const EXTERNAL_SYNC_TRANSITIONS: Readonly<
  Record<ExternalSyncState, readonly ExternalSyncState[]>
> = Object.freeze({
  NOT_STARTED: ['PREPARING', 'REMOVED'],
  PREPARING: ['UPLOADING', 'FAILED'],
  UPLOADING: ['PROCESSING', 'FAILED'],
  PROCESSING: ['READY', 'FAILED'],
  READY: ['REMOVING', 'UPLOADING', 'FAILED'],
  FAILED: ['PREPARING', 'REMOVING', 'REMOVED'],
  REMOVING: ['REMOVED', 'FAILED'],
  REMOVED: [],
});

// --------------------------------------------------------------------------
// Payout (§76, §83.1)
// --------------------------------------------------------------------------
export const PAYOUT_STATES = [
  'PENDING',
  'CALCULATED',
  'REVIEWED',
  'APPROVED',
  'PAID',
  'DISPUTED',
  'ADJUSTED',
  'REJECTED_DISPUTE',
] as const;
export type PayoutState = (typeof PAYOUT_STATES)[number];
export const PayoutStateSchema = z.enum(PAYOUT_STATES);

export const PAYOUT_TRANSITIONS: Readonly<Record<PayoutState, readonly PayoutState[]>> =
  Object.freeze({
    PENDING: ['CALCULATED'],
    CALCULATED: ['REVIEWED', 'DISPUTED'],
    REVIEWED: ['APPROVED', 'DISPUTED'],
    APPROVED: ['PAID', 'DISPUTED'],
    PAID: ['DISPUTED'],
    // §83.1: DISPUTED -> ADJUSTED -> APPROVED, or -> REJECTED_DISPUTE -> APPROVED.
    DISPUTED: ['ADJUSTED', 'REJECTED_DISPUTE'],
    ADJUSTED: ['APPROVED'],
    REJECTED_DISPUTE: ['APPROVED'],
  });

// --------------------------------------------------------------------------
// Lead state (§71)
// --------------------------------------------------------------------------
export const LEAD_STATES = [
  'UNREDEEMED',
  'RECEIVED',
  'VALID',
  'QUALIFIED',
  'CONVERTED',
  'REJECTED',
] as const;
export type LeadState = (typeof LEAD_STATES)[number];
export const LeadStateSchema = z.enum(LEAD_STATES);

/**
 * §71: a click token maps to ONE logical lead. CRM callbacks move that lead
 * forward through valid transitions; they never create unlimited leads and
 * never move backward outside the privileged correction workflow.
 */
export const LEAD_TRANSITIONS: Readonly<Record<LeadState, readonly LeadState[]>> = Object.freeze({
  UNREDEEMED: ['RECEIVED'],
  RECEIVED: ['VALID', 'REJECTED'],
  VALID: ['QUALIFIED', 'REJECTED'],
  QUALIFIED: ['CONVERTED', 'REJECTED'],
  CONVERTED: [],
  REJECTED: [],
});

// --------------------------------------------------------------------------
// Generic guard
// --------------------------------------------------------------------------
export function canTransition<S extends string>(
  table: Readonly<Record<S, readonly S[]>>,
  from: S,
  to: S,
): boolean {
  return (table[from] ?? []).includes(to);
}

/**
 * Derive the parent campaign's aggregate state from its activations (§42).
 * The parent is a projection -- it is never the source of truth for any
 * individual Partner or channel.
 */
export function deriveCampaignState(
  activationStates: readonly ActivationState[],
  opts: { submitted: boolean; allRequestsResolved: boolean },
): CampaignState {
  if (!opts.submitted) return 'DRAFT';
  if (activationStates.length === 0) return 'SUBMITTED';

  const total = activationStates.length;
  const live = activationStates.filter((s) => s === 'LIVE').length;
  const ended = activationStates.filter((s) => s === 'ENDED').length;
  const ready = activationStates.filter((s) => s === 'READY' || s === 'SYNCING').length;
  const paused = activationStates.filter((s) => s === 'PAUSED').length;

  if (ended === total) return 'ENDED';
  if (live === total) return 'LIVE';
  if (live > 0) return 'PARTIALLY_LIVE';
  if (paused > 0 && paused + ended === total) return 'PAUSED';
  if (ready > 0 && opts.allRequestsResolved) return 'READY';
  if (ready > 0) return 'PARTIALLY_APPROVED';
  return 'SUBMITTED';
}
