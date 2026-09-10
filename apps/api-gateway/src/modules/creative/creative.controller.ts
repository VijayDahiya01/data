/**
 * Creative upload endpoints -- spec v5 §93.
 */
import { Body, Controller, Get, Inject, Param, Post, Query } from '@nestjs/common';
import { OolixError } from '@oolix/contracts';
import type { UserPrincipal } from '@oolix/auth-rbac';
import { RequirePermissions } from '../../common/auth/auth.guard.js';
import { Principal } from '../../common/auth/principal.decorator.js';
import { ZodValidationPipe } from '../../common/validation/zod.pipe.js';
import {
  CreativeService,
  FinalizeSchema,
  UploadSessionSchema,
  type FinalizeInput,
  type UploadSessionInput,
} from './creative.service.js';

@Controller('v1/creatives')
export class CreativeController {
  constructor(@Inject(CreativeService) private readonly creatives: CreativeService) {}

  /**
   * §93.1: bytes go straight from the browser to object storage, so the API
   * never proxies a 5 MiB upload and never becomes the bottleneck.
   */
  @Post('upload-session')
  @RequirePermissions('creative:upload')
  async createUploadSession(
    @Principal() p: UserPrincipal,
    @Body(new ZodValidationPipe(UploadSessionSchema)) body: UploadSessionInput,
  ) {
    return this.creatives.createUploadSession(p, body);
  }

  /** §93.3: verify what was actually uploaded, then mark it READY. */
  @Post(':id/finalize')
  @RequirePermissions('creative:upload')
  async finalize(
    @Principal() p: UserPrincipal,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(FinalizeSchema)) body: FinalizeInput,
  ) {
    return this.creatives.finalize(p, id, body);
  }

  @Get()
  @RequirePermissions('campaign:read')
  async list(@Principal() p: UserPrincipal, @Query('campaign_id') campaignId?: string) {
    if (!campaignId) {
      throw new OolixError('VAL_001', 'campaign_id is required.', {
        fieldErrors: [{ field: 'campaign_id', message: 'required' }],
      });
    }
    return this.creatives.list(p, campaignId);
  }
}
