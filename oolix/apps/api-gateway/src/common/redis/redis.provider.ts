/**
 * Redis connection. Used for rate limiting (§94) and short-lived cache state
 * (§64). It is NOT a source of truth: anything that must survive a restart or
 * be auditable lives in PostgreSQL.
 */
import { Global, Module, type OnApplicationShutdown } from '@nestjs/common';
import { Inject, Injectable } from '@nestjs/common';
import Redis from 'ioredis';
import { CONFIG, type OolixConfig } from '../../config/configuration.js';

export const REDIS = Symbol('OOLIX_REDIS');

@Injectable()
export class RedisLifecycle implements OnApplicationShutdown {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async onApplicationShutdown(): Promise<void> {
    await this.redis.quit().catch(() => undefined);
  }
}

@Global()
@Module({
  providers: [
    {
      provide: REDIS,
      inject: [CONFIG],
      useFactory: (config: OolixConfig) =>
        new Redis(config.REDIS_URL, {
          maxRetriesPerRequest: 3,
          enableReadyCheck: true,
          // Rate limiting must not become the reason a request hangs; fail
          // fast and let the guard decide how to degrade.
          connectTimeout: 3_000,
          lazyConnect: false,
        }),
    },
    RedisLifecycle,
  ],
  exports: [REDIS],
})
export class RedisModule {}
