import { Global, Module } from '@nestjs/common';
import { IdentityOrgService } from './identity-org.service.js';
import { IdentityOrgController } from './identity-org.controller.js';
import { AdminOrganizationsController } from './admin-organizations.controller.js';
import { AuthModule } from '../auth/auth.module.js';

@Global()
@Module({
  // Invitations are emailed as one-time links, which the auth module owns.
  imports: [AuthModule],
  controllers: [IdentityOrgController, AdminOrganizationsController],
  providers: [IdentityOrgService],
  exports: [IdentityOrgService],
})
export class IdentityOrgModule {}
