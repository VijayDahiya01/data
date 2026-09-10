import { Global, Module } from '@nestjs/common';
import { IdentityOrgService } from './identity-org.service.js';
import { IdentityOrgController } from './identity-org.controller.js';

@Global()
@Module({
  controllers: [IdentityOrgController],
  providers: [IdentityOrgService],
  exports: [IdentityOrgService],
})
export class IdentityOrgModule {}
