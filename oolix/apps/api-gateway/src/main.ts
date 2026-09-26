/**
 * Oolix Cloud control plane entrypoint.
 *
 * Fastify rather than Express: §103 sets a p95 budget of 300-500 ms on control
 * plane writes, and §64 forbids serverless cold starts in the ad-control path,
 * so the process is long-lived and the HTTP layer is the cheap one.
 */
import 'reflect-metadata';
import { loadFileSecrets } from '@oolix/runtime-config';
import { loadDotEnv } from './config/load-env.js';

// Before any module is imported that might read process.env at load time.
loadDotEnv();
// After the .env, so a mounted secret always wins over a checked-in default.
loadFileSecrets();

import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module.js';
import { CONFIG, type OolixConfig } from './config/configuration.js';
import { LOGGER } from './common/logging/logger.provider.js';
import type { OolixLogger } from '@oolix/observability';
import { configureApp, fastifyOptions } from './bootstrap.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter(fastifyOptions),
    { bufferLogs: true },
  );

  // Security headers, CORS, correlation and the error filter. Shared with the
  // integration harness so the tests exercise this exact stack (§79.1).
  await configureApp(app);
  app.enableShutdownHooks();

  const config = app.get<OolixConfig>(CONFIG);
  const logger = app.get<OolixLogger>(LOGGER);

  await app.listen({ port: config.API_PORT, host: '0.0.0.0' });

  logger.info('Oolix API listening', {
    event: 'STARTUP',
    port: config.API_PORT,
    environment: config.APP_ENV,
    // Surfaced at boot so nobody has to guess whether a connector is live.
    meta_enabled: config.FEATURE_META_ENABLED,
    google_enabled: config.FEATURE_GOOGLE_ENABLED,
    billing_enabled: config.FEATURE_BILLING_ENABLED,
  });
}

void bootstrap();
