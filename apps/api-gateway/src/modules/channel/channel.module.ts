import { Module } from '@nestjs/common';
import { ManifestModule } from '../manifest/manifest.module.js';
import {
  ChannelConnectionController,
  ActivationEligibilityController,
  AgentChannelStatusController,
} from './channel.controller.js';
import { ChannelService } from './channel.service.js';
import { ChannelStatusService } from './channel-status.service.js';
import { ChannelEligibilityService } from './eligibility.service.js';
import { ChannelActivationService } from './channel-activation.service.js';

@Module({
  imports: [ManifestModule],
  controllers: [
    ChannelConnectionController,
    ActivationEligibilityController,
    AgentChannelStatusController,
  ],
  providers: [
    ChannelService,
    ChannelStatusService,
    ChannelEligibilityService,
    ChannelActivationService,
  ],
  exports: [ChannelEligibilityService, ChannelActivationService],
})
export class ChannelModule {}
