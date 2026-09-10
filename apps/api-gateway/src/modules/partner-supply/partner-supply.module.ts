import { Module } from '@nestjs/common';
import { SegmentService } from './segment.service.js';
import { PlacementService } from './placement.service.js';
import { PartnerProfileService } from './partner-profile.service.js';
import { PartnerSupplyController } from './partner-supply.controller.js';
import { KillSwitchService } from './killswitch.service.js';
import { ActivationController, KillSwitchController } from './killswitch.controller.js';

@Module({
  controllers: [PartnerSupplyController, KillSwitchController, ActivationController],
  providers: [SegmentService, PlacementService, PartnerProfileService, KillSwitchService],
  exports: [SegmentService, PlacementService, PartnerProfileService, KillSwitchService],
})
export class PartnerSupplyModule {}
