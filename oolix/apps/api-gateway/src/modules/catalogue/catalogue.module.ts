import { Module } from '@nestjs/common';
import { CatalogueService } from './catalogue.service.js';
import { CatalogueController } from './catalogue.controller.js';

@Module({
  controllers: [CatalogueController],
  providers: [CatalogueService],
  exports: [CatalogueService],
})
export class CatalogueModule {}
