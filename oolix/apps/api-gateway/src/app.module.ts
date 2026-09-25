/**
 * Oolix Cloud application root.
 *
 * §61: "Start as a modular monolith or a small number of deployables. Do not
 * create dozens of microservices before traffic and team size justify them.
 * Keep strong module/data ownership so services can be split later."
 *
 * Each module below corresponds to one of §61's `services/*` entries and owns
 * its own tables, so extracting one later is a deployment change rather than a
 * data untangling exercise.
 */
import { Module } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR, Reflector } from '@nestjs/core';
import { IpRateLimitGuard } from './common/ratelimit/ip-rate-limit.guard.js';
import { AppConfigModule } from './config/config.module.js';
import { LoggerModule } from './common/logging/logger.provider.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { RedisModule } from './common/redis/redis.provider.js';
import { KeysModule } from './keys/keys.module.js';
import { AuditModule } from './common/audit/audit.module.js';
import { AuthGuard } from './common/auth/auth.guard.js';
import { OolixExceptionFilter } from './common/errors/oolix-exception.filter.js';
import { IdempotencyService } from './common/idempotency/idempotency.service.js';
import { IdempotencyInterceptor } from './common/idempotency/idempotency.interceptor.js';
import { RateLimitService } from './common/ratelimit/rate-limit.service.js';
import { RateLimitGuard } from './common/ratelimit/rate-limit.guard.js';
import { HealthModule } from './modules/health/health.module.js';
import { MetricsModule } from './modules/metrics/metrics.module.js';
import { ChannelModule } from './modules/channel/channel.module.js';
import { IdentityOrgModule } from './modules/identity-org/identity-org.module.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { PartnerSupplyModule } from './modules/partner-supply/partner-supply.module.js';
import { AgentModule } from './modules/agent/agent.module.js';
import { CatalogueModule } from './modules/catalogue/catalogue.module.js';
import { CampaignModule } from './modules/campaign/campaign.module.js';
import { BrandModule } from './modules/brand/brand.module.js';
import { AudienceModule } from './modules/audience/audience.module.js';
import { CreativeModule } from './modules/creative/creative.module.js';
import { ApprovalModule } from './modules/approval/approval.module.js';
import { ManifestModule } from './modules/manifest/manifest.module.js';
import { AttributionModule } from './modules/attribution/attribution.module.js';
import { ReportingModule } from './modules/reporting/reporting.module.js';
import { BillingModule } from './modules/billing/billing.module.js';

@Module({
  imports: [
    AppConfigModule,
    LoggerModule,
    PrismaModule,
    RedisModule,
    KeysModule,
    AuditModule,
    HealthModule,
    MetricsModule,
    ChannelModule,
    AuthModule,
    IdentityOrgModule,
    PartnerSupplyModule,
    AgentModule,
    CatalogueModule,
    CampaignModule,
    // §40.2 requires a brand on every campaign, so this is a prerequisite for
    // the builder rather than an optional extra (§36 step 4).
    BrandModule,
    // v6: Buyer-defined audiences, Partner capability matching and safe reach
    // estimation. Replaces segment-first discovery as the primary Buyer path.
    AudienceModule,
    CreativeModule,
    ManifestModule,
    ApprovalModule,
    AttributionModule,
    ReportingModule,
    BillingModule,
  ],
  providers: [
    OolixExceptionFilter,
    IdempotencyService,
    RateLimitService,
    { provide: 'Reflector', useExisting: Reflector },
    // §82: RBAC and org scoping on EVERY endpoint. Registering the guard
    // globally makes authentication opt-out (@Public) rather than opt-in, so a
    // forgotten decorator fails closed.
    // Before AuthGuard, deliberately. A request that never authenticates never
    // reaches the per-principal limiter, so an unauthenticated flood was
    // entirely unbounded until this existed.
    { provide: APP_GUARD, useClass: IpRateLimitGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
    // §94: registered AFTER AuthGuard so the window is scoped to a resolved
    // principal. Global rather than opt-in -- the endpoint nobody remembered
    // to annotate is the one that gets abused.
    { provide: APP_GUARD, useClass: RateLimitGuard },
    // §99: registered globally so the replay guarantee is uniform. Routes opt
    // in with @Idempotent(); everything else passes straight through.
    { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },
  ],
  exports: [IdempotencyService, RateLimitService],
})
export class AppModule {}
