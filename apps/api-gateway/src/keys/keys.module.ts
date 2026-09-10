import { Global, Module } from '@nestjs/common';
import { AgentKeyService } from './agent-key.service.js';

@Global()
@Module({
  providers: [AgentKeyService],
  exports: [AgentKeyService],
})
export class KeysModule {}
