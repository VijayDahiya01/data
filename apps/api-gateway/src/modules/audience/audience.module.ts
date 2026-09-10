import { Module } from '@nestjs/common';
import { AudienceController, PartnerCapabilityController } from './audience.controller.js';
import { AgentAudienceController } from './agent-audience.controller.js';
import { AudienceService } from './audience.service.js';
import { AgentAudienceService } from './agent-audience.service.js';
import { AuditModule } from '../../common/audit/audit.module.js';

@Module({
  imports: [AuditModule],
  controllers: [AudienceController, PartnerCapabilityController, AgentAudienceController],
  providers: [AudienceService, AgentAudienceService],
  exports: [AudienceService],
})
export class AudienceModule {}
