import { Module } from '@nestjs/common';
import { ReportingService } from './reporting.service.js';
import { OpsService } from './ops.service.js';
import { AgentReportingController, ReportsController } from './reporting.controller.js';
import { OpsController } from './ops.controller.js';

@Module({
  controllers: [AgentReportingController, ReportsController, OpsController],
  providers: [ReportingService, OpsService],
  exports: [ReportingService, OpsService],
})
export class ReportingModule {}
