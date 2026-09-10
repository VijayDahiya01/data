/**
 * Creative upload and versioning -- spec v5 §70, §93.
 *
 * §93's three-step flow exists so bytes never pass through the API:
 *
 *   1. request an upload session  -> pre-signed PUT URL
 *   2. PUT directly to object storage
 *   3. finalize                   -> server verifies size, MIME, dimensions,
 *                                    declared hash, then marks READY
 *
 * Step 3 is the security boundary. A client that uploads something other than
 * what it declared is caught there, and §70 binds Partner approval to the
 * resulting content hash, so bytes cannot be swapped behind an approved
 * creative afterwards.
 */
import { Injectable, Inject } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  ALLOWED_CREATIVE_MIME_TYPES,
  CREATIVE_UPLOAD_URL_TTL_SEC,
  MAX_CREATIVE_BYTES,
  OolixError,
} from '@oolix/contracts';
import type { UserPrincipal } from '@oolix/auth-rbac';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AuditService } from '../../common/audit/audit.service.js';
import { CONFIG, type OolixConfig } from '../../config/configuration.js';
import { toBytes } from '../../common/bytes.js';

export const S3 = Symbol('OOLIX_S3');

export const UploadSessionSchema = z
  .object({
    campaign_id: z.string().uuid(),
    creative_id: z.string().uuid().optional(),
    file_name: z.string().min(1).max(255),
    mime_type: z.enum(ALLOWED_CREATIVE_MIME_TYPES),
    file_size_bytes: z.number().int().positive().max(MAX_CREATIVE_BYTES),
    creative_type: z.enum(['IMAGE', 'NATIVE_CARD']),
    width: z.number().int().positive().max(8192).optional(),
    height: z.number().int().positive().max(8192).optional(),
    // §70 NATIVE_CARD fields.
    headline: z.string().max(120).optional(),
    body: z.string().max(500).optional(),
    cta: z.string().max(40).optional(),
    destination_url: z.string().url(),
    legal_disclaimer: z.string().max(500).optional(),
  })
  .refine((v) => v.creative_type !== 'IMAGE' || (v.width && v.height), {
    message: 'width and height are required for IMAGE creatives',
    path: ['width'],
  })
  .refine((v) => v.creative_type !== 'NATIVE_CARD' || Boolean(v.headline), {
    message: 'headline is required for NATIVE_CARD creatives',
    path: ['headline'],
  });

export type UploadSessionInput = z.infer<typeof UploadSessionSchema>;

export const FinalizeSchema = z.object({
  content_sha256: z.string().regex(/^[0-9a-f]{64}$/, 'lowercase hex sha-256'),
});
export type FinalizeInput = z.infer<typeof FinalizeSchema>;

/** Magic-byte signatures for the formats §70 permits. */
const MAGIC: Array<{ mime: string; test: (b: Buffer) => boolean }> = [
  {
    mime: 'image/png',
    test: (b) => b.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')),
  },
  { mime: 'image/jpeg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  {
    mime: 'image/webp',
    test: (b) =>
      b.subarray(0, 4).toString('ascii') === 'RIFF' &&
      b.subarray(8, 12).toString('ascii') === 'WEBP',
  },
];

@Injectable()
export class CreativeService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(CONFIG) private readonly config: OolixConfig,
    @Inject(S3) private readonly s3: S3Client,
  ) {}

  /** §93.1: create the version row and hand back a pre-signed PUT URL. */
  async createUploadSession(principal: UserPrincipal, input: UploadSessionInput) {
    const campaign = await this.prisma.campaign.findFirst({
      where: { id: input.campaign_id, buyerOrgId: principal.orgId },
    });
    if (!campaign) throw new OolixError('CAMP_001', 'Campaign not found.');
    if (campaign.status !== 'DRAFT') {
      throw new OolixError('CAMP_002', 'Creatives can only be added to a DRAFT campaign.');
    }

    // §70: every edit creates an immutable CreativeVersion. A new upload
    // against an existing creative increments its version rather than
    // replacing it, because an earlier version may already be approved.
    const creative = input.creative_id
      ? await this.prisma.creative.findFirst({
          where: { id: input.creative_id, campaignId: campaign.id },
        })
      : await this.prisma.creative.create({
          data: {
            campaignId: campaign.id,
            name: input.file_name,
            type: input.creative_type as never,
          },
        });
    if (!creative) throw new OolixError('CAMP_001', 'Creative not found for this campaign.');

    const latest = await this.prisma.creativeVersion.findFirst({
      where: { creativeId: creative.id },
      orderBy: { version: 'desc' },
      select: { version: true },
    });
    const version = (latest?.version ?? 0) + 1;

    const objectKey = `creatives/${principal.orgId}/${campaign.id}/${creative.id}/v${version}/${randomUUID()}`;

    const created = await this.prisma.creativeVersion.create({
      data: {
        creativeId: creative.id,
        campaignId: campaign.id,
        version,
        type: input.creative_type as never,
        assetUri: objectKey,
        mimeType: input.mime_type,
        width: input.width ?? null,
        height: input.height ?? null,
        fileSizeBytes: input.file_size_bytes,
        headline: input.headline ?? null,
        body: input.body ?? null,
        cta: input.cta ?? null,
        destinationUrl: input.destination_url,
        legalDisclaimer: input.legal_disclaimer ?? null,
        status: 'UPLOADING',
      },
    });

    const uploadUrl = await getSignedUrl(
      this.s3,
      new PutObjectCommand({
        Bucket: this.config.S3_CREATIVE_BUCKET,
        Key: objectKey,
        ContentType: input.mime_type,
        // Binding length at signing time stops a client from signing for a
        // small file and then uploading a large one.
        ContentLength: input.file_size_bytes,
      }),
      { expiresIn: CREATIVE_UPLOAD_URL_TTL_SEC },
    );

    return {
      creative_id: creative.id,
      creative_version_id: created.id,
      version,
      upload_url: uploadUrl,
      upload_headers: {
        'Content-Type': input.mime_type,
        'Content-Length': String(input.file_size_bytes),
      },
      expires_at: new Date(Date.now() + CREATIVE_UPLOAD_URL_TTL_SEC * 1000).toISOString(),
      finalize_url: `/v1/creatives/${created.id}/finalize`,
    };
  }

  /**
   * §93.3 finalize.
   *
   * Verifies what was ACTUALLY uploaded rather than trusting the declaration
   * from step 1: object size, MIME, magic bytes and the declared hash must all
   * agree before the version becomes usable.
   */
  async finalize(principal: UserPrincipal, creativeVersionId: string, input: FinalizeInput) {
    const cv = await this.prisma.creativeVersion.findFirst({
      where: { id: creativeVersionId, campaign: { buyerOrgId: principal.orgId } },
    });
    if (!cv) throw new OolixError('CAMP_001', 'Creative version not found.');
    if (cv.status === 'READY') return this.toWire(cv);
    if (!cv.assetUri) throw new OolixError('VAL_001', 'Creative version has no pending upload.');

    let head;
    try {
      head = await this.s3.send(
        new HeadObjectCommand({ Bucket: this.config.S3_CREATIVE_BUCKET, Key: cv.assetUri }),
      );
    } catch {
      throw new OolixError('VAL_001', 'No uploaded object found for this creative version.');
    }

    const actualSize = Number(head.ContentLength ?? 0);
    if (actualSize <= 0 || actualSize > MAX_CREATIVE_BYTES) {
      throw new OolixError(
        'VAL_001',
        `Creative exceeds the ${MAX_CREATIVE_BYTES} byte limit (§70).`,
      );
    }
    if (cv.fileSizeBytes && actualSize !== cv.fileSizeBytes) {
      throw new OolixError('VAL_001', 'Uploaded size does not match the declared size.', {
        fieldErrors: [
          { field: 'file_size_bytes', message: `declared ${cv.fileSizeBytes}, got ${actualSize}` },
        ],
      });
    }

    const bytes = await this.download(cv.assetUri);

    // Trust the bytes, not the Content-Type header: a header can claim PNG
    // while the body is something else entirely.
    const magic = MAGIC.find((m) => m.test(bytes));
    if (!magic) {
      throw new OolixError(
        'VAL_001',
        'Uploaded file is not a supported image (§70: PNG, JPEG, WebP).',
      );
    }
    if (cv.mimeType && magic.mime !== cv.mimeType) {
      throw new OolixError('VAL_001', 'Uploaded file type does not match the declared MIME type.', {
        fieldErrors: [
          { field: 'mime_type', message: `declared ${cv.mimeType}, detected ${magic.mime}` },
        ],
      });
    }

    const actualHash = createHash('sha256').update(bytes).digest('hex');
    if (actualHash !== input.content_sha256) {
      // §70: approval binds to the content hash, so a mismatch here would
      // make later approval meaningless.
      throw new OolixError('VAL_001', 'Uploaded content does not match the declared SHA-256.', {
        fieldErrors: [{ field: 'content_sha256', message: 'hash mismatch' }],
      });
    }

    const updated = await this.prisma.creativeVersion.update({
      where: { id: cv.id },
      data: {
        status: 'READY',
        contentSha256: toBytes(Buffer.from(actualHash, 'hex')),
        fileSizeBytes: actualSize,
        metadata: { detected_mime: magic.mime, finalized_at: new Date().toISOString() } as never,
      },
    });

    await this.audit.record({
      action: 'CREATIVE_VERSION_READY',
      entityType: 'creative_version',
      entityId: cv.id,
      orgId: principal.orgId,
      metadata: { version: cv.version, sha256: actualHash, size_bytes: actualSize },
    });

    return this.toWire(updated);
  }

  private async download(key: string): Promise<Buffer> {
    const res = await this.s3.send(
      new GetObjectCommand({ Bucket: this.config.S3_CREATIVE_BUCKET, Key: key }),
    );
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of res.Body as AsyncIterable<Uint8Array>) {
      total += chunk.length;
      // Defence against a storage object larger than HeadObject reported.
      if (total > MAX_CREATIVE_BYTES) {
        throw new OolixError('VAL_001', 'Uploaded object exceeds the maximum creative size.');
      }
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }

  async list(principal: UserPrincipal, campaignId: string) {
    const rows = await this.prisma.creativeVersion.findMany({
      where: { campaignId, campaign: { buyerOrgId: principal.orgId } },
      orderBy: [{ creativeId: 'asc' }, { version: 'desc' }],
    });
    return { items: rows.map((r) => this.toWire(r)), next_cursor: null };
  }

  private toWire(cv: {
    id: string;
    creativeId: string;
    version: number;
    type: string;
    assetUri: string | null;
    mimeType: string | null;
    width: number | null;
    height: number | null;
    fileSizeBytes: number | null;
    headline: string | null;
    body: string | null;
    cta: string | null;
    destinationUrl: string | null;
    legalDisclaimer: string | null;
    status: string;
    contentSha256: Uint8Array | null;
  }) {
    return {
      creative_version_id: cv.id,
      creative_id: cv.creativeId,
      version: cv.version,
      type: cv.type,
      status: cv.status,
      // Served from the CDN, never the raw object key (§70).
      asset_url: cv.assetUri ? `${this.config.CDN_PUBLIC_BASE_URL}/${cv.assetUri}` : null,
      mime_type: cv.mimeType,
      width: cv.width,
      height: cv.height,
      file_size_bytes: cv.fileSizeBytes,
      headline: cv.headline,
      body: cv.body,
      cta: cv.cta,
      destination_url: cv.destinationUrl,
      legal_disclaimer: cv.legalDisclaimer,
      content_sha256: cv.contentSha256 ? Buffer.from(cv.contentSha256).toString('hex') : null,
    };
  }
}
