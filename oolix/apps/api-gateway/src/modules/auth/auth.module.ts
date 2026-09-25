import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { AuthTokensService } from './auth-tokens.service.js';
import { SessionsService } from './sessions.service.js';
import { PasswordBreachService } from './password-breach.service.js';
import { EmailService } from './email/email.service.js';

@Module({
  controllers: [AuthController],
  providers: [AuthService, AuthTokensService, SessionsService, PasswordBreachService, EmailService],
  // Identity-org sends invitations through AuthService; tests read the
  // capture transport through EmailService.
  exports: [AuthService, EmailService],
})
export class AuthModule {}
