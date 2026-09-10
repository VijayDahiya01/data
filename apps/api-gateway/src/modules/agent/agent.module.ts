import { Module } from '@nestjs/common';
import { AgentRegistryService } from './agent-registry.service.js';
import { AgentControlController, PartnerAgentAdminController } from './agent.controller.js';

@Module({
  controllers: [PartnerAgentAdminController, AgentControlController],
  providers: [AgentRegistryService],
  exports: [AgentRegistryService],
})
export class AgentModule {}
