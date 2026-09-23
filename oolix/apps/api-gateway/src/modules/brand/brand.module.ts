import { Module } from '@nestjs/common';
import { BrandController } from './brand.controller.js';
import { BrandService } from './brand.service.js';
import { AuditModule } from '../../common/audit/audit.module.js';

@Module({
  imports: [AuditModule],
  controllers: [BrandController],
  providers: [BrandService],
  exports: [BrandService],
})
export class BrandModule {}
