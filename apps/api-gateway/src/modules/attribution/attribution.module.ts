import { Module } from '@nestjs/common';
import { AttributionService } from './attribution.service.js';
import { LeadService } from './lead.service.js';
import { AgentAttributionController } from './attribution.controller.js';
import { LeadController } from './lead.controller.js';

@Module({
  controllers: [AgentAttributionController, LeadController],
  providers: [AttributionService, LeadService],
  exports: [AttributionService, LeadService],
})
export class AttributionModule {}
