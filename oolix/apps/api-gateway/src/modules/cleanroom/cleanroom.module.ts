import { Module } from '@nestjs/common';
import { CleanRoomService } from './cleanroom.service.js';
import { AgentCleanRoomController, PartnerCleanRoomController } from './cleanroom.controller.js';

@Module({
  controllers: [PartnerCleanRoomController, AgentCleanRoomController],
  providers: [CleanRoomService],
})
export class CleanRoomModule {}
