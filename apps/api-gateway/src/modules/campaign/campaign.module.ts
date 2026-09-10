import { Module } from '@nestjs/common';
import { PartnerSupplyModule } from '../partner-supply/partner-supply.module.js';
import { CampaignService } from './campaign.service.js';
import { CampaignController } from './campaign.controller.js';

@Module({
  // Campaign creation gates on live Partner readiness (§37), so it depends on
  // the module that owns that evaluation.
  imports: [PartnerSupplyModule],
  controllers: [CampaignController],
  providers: [CampaignService],
  exports: [CampaignService],
})
export class CampaignModule {}
