import { Module } from '@nestjs/common';
import { CodeSuggestionsService } from './code-suggestions.service.js';
import { SynonymsService } from './synonyms.service.js';
import { AdminSynonymsController, AgentSuggestionsController } from './suggestions.controller.js';

@Module({
  controllers: [AgentSuggestionsController, AdminSynonymsController],
  providers: [CodeSuggestionsService, SynonymsService],
  exports: [CodeSuggestionsService],
})
export class SuggestionsModule {}
