import { Module } from '@nestjs/common';
import { ManifestService } from './manifest.service.js';
import { AgentConfigController } from './manifest.controller.js';

@Module({
  controllers: [AgentConfigController],
  providers: [ManifestService],
  exports: [ManifestService],
})
export class ManifestModule {}
