/**
 * Oolix Ops dashboard endpoints -- spec v5 §98.1.
 */
import { Controller, Get, Inject } from '@nestjs/common';
import { RequirePermissions } from '../../common/auth/auth.guard.js';
import { OpsService } from './ops.service.js';

@Controller('v1/admin/ops')
export class OpsController {
  constructor(@Inject(OpsService) private readonly ops: OpsService) {}

  /**
   * §66: OOLIX_ADMIN operates the platform. It cannot bypass Partner approval
   * or read Partner customer data, and nothing on this dashboard exposes any.
   */
  @Get('dashboard')
  @RequirePermissions('admin:operate')
  async dashboard() {
    return this.ops.dashboard();
  }

  @Get('no-ad-distribution')
  @RequirePermissions('admin:operate')
  async noAd() {
    return this.ops.noAdDistribution();
  }
}
