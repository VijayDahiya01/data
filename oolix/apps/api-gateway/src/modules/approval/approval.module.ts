import { Module } from '@nestjs/common';
import { ApprovalService } from './approval.service.js';
import { CampaignSubmitController, PartnerRequestController } from './approval.controller.js';
import { ChannelModule } from '../channel/channel.module.js';
import { ManifestModule } from '../manifest/manifest.module.js';
import { PartnerSupplyModule } from '../partner-supply/partner-supply.module.js';

@Module({
  imports: [ManifestModule, PartnerSupplyModule, ChannelModule],
  controllers: [CampaignSubmitController, PartnerRequestController],
  providers: [ApprovalService],
  exports: [ApprovalService],
})
export class ApprovalModule {}
