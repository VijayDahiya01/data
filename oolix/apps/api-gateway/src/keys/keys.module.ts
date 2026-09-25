import { Global, Module } from '@nestjs/common';
import { AgentKeyService } from './agent-key.service.js';
import { UserKeyService } from './user-key.service.js';

@Global()
@Module({
  providers: [AgentKeyService, UserKeyService],
  exports: [AgentKeyService, UserKeyService],
})
export class KeysModule {}
