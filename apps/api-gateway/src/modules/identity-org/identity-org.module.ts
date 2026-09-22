import { Global, Module } from '@nestjs/common';
import { IdentityOrgService } from './identity-org.service.js';
import { IdentityOrgController } from './identity-org.controller.js';
import { AdminOrganizationsController } from './admin-organizations.controller.js';

@Global()
@Module({
  controllers: [IdentityOrgController, AdminOrganizationsController],
  providers: [IdentityOrgService],
  exports: [IdentityOrgService],
})
export class IdentityOrgModule {}
