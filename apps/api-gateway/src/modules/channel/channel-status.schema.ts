/**
 * What a Partner Agent may report about an external audience -- §47.11, §48.9.
 *
 * §47.11 draws the line this schema enforces: "Channel adapter records audience
 * resource ID and sync status centrally; raw matching payload is not stored in
 * Oolix DB."
 *
 * So the accepted shape is deliberately narrow. Counts and a resource id are
 * operationally necessary -- an activation that uploaded 12 members out of
 * 40,000 is broken and somebody needs to see that. Anything richer starts to
 * describe the audience itself, and this endpoint is exactly where a
 * well-meaning "sample of failed rows" would arrive.
 */
import { z } from 'zod';

export const ChannelSyncStatusSchema = z.enum([
  'NOT_STARTED',
  'PREPARING',
  'UPLOADING',
  'PROCESSING',
  'READY',
  'FAILED',
  'REMOVING',
  'REMOVED',
]);

export const ReportChannelSyncSchema = z
  .object({
    activation_id: z.string().uuid(),
    provider: z.enum(['META', 'GOOGLE']),
    /** The platform's own id for the audience. Opaque to Oolix. */
    resource_id: z.string().max(200).optional().nullable(),
    external_campaign_id: z.string().max(200).optional().nullable(),
    status: ChannelSyncStatusSchema,
    /** How many members the platform accepted. */
    accepted: z.number().int().min(0).max(1_000_000_000).default(0),
    /**
     * How many were dropped for having no usable identifier.
     *
     * The most useful number on this endpoint. A high skip count is the
     * difference between "the campaign under-delivered" and knowing that the
     * Partner's field mapping is wrong.
     */
    skipped: z.number().int().min(0).max(1_000_000_000).default(0),
    /**
     * Why it failed, in the platform's words.
     *
     * Bounded, and it must not carry row content. The Agent is written not to
     * send any; the length cap is what stops a future version quietly
     * shipping a batch of rejected records through this field.
     */
    error_detail: z.string().max(500).optional().nullable(),
  })
  // Unknown keys rejected rather than ignored: this is the boundary where
  // extra data would arrive, and silently dropping it would mean nobody
  // noticed an Agent trying to send more than it should.
  .strict();

export type ReportChannelSyncInput = z.infer<typeof ReportChannelSyncSchema>;
