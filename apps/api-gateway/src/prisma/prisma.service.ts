/**
 * Prisma client lifecycle.
 *
 * Prisma 7 connects through a driver adapter rather than an embedded engine,
 * so the pg Pool is owned here. §73 sets the pool baseline at 10 connections
 * per API pod, tuned by load test against the database's max_connections.
 */
import { Injectable, Inject, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@oolix/db';
import { CONFIG, type OolixConfig } from '../config/configuration.js';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor(@Inject(CONFIG) config: OolixConfig) {
    super({
      adapter: new PrismaPg({
        connectionString: config.DATABASE_URL,
        max: config.DATABASE_POOL_SIZE,
        // A connection that cannot be obtained quickly is better surfaced as
        // an error than as an ad-decision-blocking hang.
        connectionTimeoutMillis: 5_000,
        idleTimeoutMillis: 30_000,
      }),
      log: config.APP_ENV === 'local' ? ['warn', 'error'] : ['error'],
    });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

  /** Lightweight liveness probe used by /readyz. */
  async ping(): Promise<boolean> {
    try {
      await this.$queryRaw`SELECT 1`;
      return true;
    } catch {
      return false;
    }
  }
}
