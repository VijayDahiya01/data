/**
 * Partner approval contracts -- spec v5 §41, §67.4, §101.
 *
 * §41 gives the Partner four decisions and no fifth. Each one is recorded with
 * the actor, the request version, the policy version and the creative version
 * it bound to (§83), because an approval that cannot be reconstructed later is
 * not an approval a Partner can rely on in a dispute.
 */
import { z } from 'zod';
import { ChannelSchema } from '@oolix/contracts';

/**
 * §67.4 approve.
 *
 * `decision_version` is the idempotency anchor from §22.3
 * (`partner approval: request_id + decision_version`): a retried approval with
 * the same version is the same decision, not a second one.
 */
export const ApproveSchema = z.object({
  decision_version: z.number().int().positive().default(1),
  /** §41: the Partner may approve a SUBSET of what was requested. */
  approved_channels: z.array(ChannelSchema).min(1),
  approved_placement_ids: z.array(z.string().uuid()).default([]),
  approved_budget_minor: z.number().int().positive().optional(),
  partner_payout: z
    .object({
      model: z.enum(['CPM', 'CPC', 'CPL', 'CPQL', 'FIXED', 'HYBRID']),
      unit_price_minor: z.number().int().nonnegative(),
    })
    .optional(),
  /** §41: expansion stays off unless the Partner explicitly grants it. */
  audience_expansion_allowed: z.boolean().default(false),
  /** §70: the Partner approves specific creative VERSIONS, not a creative. */
  approved_creative_version_ids: z.array(z.string().uuid()).min(1),
  approval_note: z.string().max(1000).optional(),
});
export type ApproveInput = z.infer<typeof ApproveSchema>;

/** §41 REQUEST_CHANGE: the Partner names the fields and the reason. */
export const RequestChangeSchema = z.object({
  decision_version: z.number().int().positive().default(1),
  fields: z.array(z.string().max(120)).min(1),
  reason: z.string().min(3).max(1000),
});
export type RequestChangeInput = z.infer<typeof RequestChangeSchema>;

export const RejectSchema = z.object({
  decision_version: z.number().int().positive().default(1),
  reason: z.string().min(3).max(1000),
});
export type RejectInput = z.infer<typeof RejectSchema>;

/**
 * §41 REVOKE: stop an already-approved or live activation.
 *
 * §57: "Partner revokes approval -> immediately stop local serving; queue
 * external cleanup." A reason is mandatory because revocation ends a
 * commercial arrangement and §83 requires the dispute trail.
 */
export const RevokeSchema = z.object({
  reason: z.string().min(3).max(1000),
});
export type RevokeInput = z.infer<typeof RevokeSchema>;

/** §101: one extension of up to 7 days, with a mandatory reason. */
export const ExtendSchema = z.object({
  additional_days: z.number().int().min(1).max(7),
  reason: z.string().min(3).max(500),
});
export type ExtendInput = z.infer<typeof ExtendSchema>;
