/**
 * Sign-up, sign-in and account recovery routes -- spec v5 §35.1, §86.
 *
 * Everything under /v1/auth is public by nature -- these are the routes that
 * turn an anonymous caller into a signed-in one -- so each carries its own
 * per-IP budget instead of relying on the per-user limits that apply once
 * somebody is signed in. The portal calls these server-to-server and forwards
 * the visitor's address, so the budget is per visitor, not per portal.
 *
 * Every response that carries tokens is marked `no-store` (RFC 6749 §5.1): a
 * cache between here and the caller must never keep a copy.
 */
import { Body, Controller, Header, HttpCode, Inject, Post } from '@nestjs/common';
import type { OnboardingPrincipal, UserPrincipal } from '@oolix/auth-rbac';
import { AllowWithoutOrganization, Public } from '../../common/auth/auth.guard.js';
import { Principal } from '../../common/auth/principal.decorator.js';
import { RateLimit } from '../../common/ratelimit/rate-limit.guard.js';
import { ZodValidationPipe } from '../../common/validation/zod.pipe.js';
import {
  AuthService,
  AcceptInviteSchema,
  ChangePasswordSchema,
  EmailOnlySchema,
  LoginSchema,
  RefreshSchema,
  ResetPasswordSchema,
  SignupSchema,
  TokenOnlySchema,
  type LoginInput,
  type SignupInput,
} from './auth.service.js';

@Controller('v1')
export class AuthController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  @Post('auth/signup')
  @Public()
  @RateLimit('signup')
  @HttpCode(202)
  signup(@Body(new ZodValidationPipe(SignupSchema)) body: SignupInput) {
    return this.auth.signup(body);
  }

  @Post('auth/verify-email')
  @Public()
  @RateLimit('authLink')
  @HttpCode(200)
  verifyEmail(@Body(new ZodValidationPipe(TokenOnlySchema)) body: { token: string }) {
    return this.auth.verifyEmail(body.token);
  }

  @Post('auth/resend-verification')
  @Public()
  @RateLimit('emailVerification')
  @HttpCode(202)
  resendVerification(@Body(new ZodValidationPipe(EmailOnlySchema)) body: { email: string }) {
    return this.auth.resendVerification(body.email);
  }

  @Post('auth/login')
  @Public()
  @RateLimit('login')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  login(@Body(new ZodValidationPipe(LoginSchema)) body: LoginInput) {
    return this.auth.login(body);
  }

  @Post('auth/refresh')
  @Public()
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  refresh(@Body(new ZodValidationPipe(RefreshSchema)) body: { refresh_token: string }) {
    return this.auth.refresh(body.refresh_token);
  }

  @Post('auth/logout')
  @Public()
  @HttpCode(204)
  async logout(@Body(new ZodValidationPipe(RefreshSchema)) body: { refresh_token: string }) {
    await this.auth.logout(body.refresh_token);
  }

  @Post('auth/forgot-password')
  @Public()
  @RateLimit('passwordReset')
  @HttpCode(202)
  forgotPassword(@Body(new ZodValidationPipe(EmailOnlySchema)) body: { email: string }) {
    return this.auth.forgotPassword(body.email);
  }

  @Post('auth/reset-password')
  @Public()
  @RateLimit('authLink')
  @HttpCode(200)
  resetPassword(
    @Body(new ZodValidationPipe(ResetPasswordSchema)) body: { token: string; password: string },
  ) {
    return this.auth.resetPassword(body.token, body.password);
  }

  @Post('auth/accept-invite')
  @Public()
  @RateLimit('authLink')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  acceptInvite(
    @Body(new ZodValidationPipe(AcceptInviteSchema))
    body: {
      token: string;
      password?: string;
      name?: string;
    },
  ) {
    return this.auth.acceptInvitation(body);
  }

  @Post('me/password')
  @AllowWithoutOrganization()
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  changePassword(
    @Principal() p: UserPrincipal | OnboardingPrincipal,
    @Body(new ZodValidationPipe(ChangePasswordSchema))
    body: { current_password: string; new_password: string },
  ) {
    return this.auth.changePassword(p.userId, body.current_password, body.new_password);
  }
}
