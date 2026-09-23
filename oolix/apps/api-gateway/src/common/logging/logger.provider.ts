/**
 * Logger provider. One process-wide logger, request context supplied by the
 * AsyncLocalStorage correlation store rather than by a per-request instance
 * (spec v5 §78.1, §99).
 */
import { Global, Module } from '@nestjs/common';
import { createLogger, type OolixLogger } from '@oolix/observability';
import { CONFIG, type OolixConfig } from '../../config/configuration.js';

export const LOGGER = Symbol('OOLIX_LOGGER');

@Global()
@Module({
  providers: [
    {
      provide: LOGGER,
      inject: [CONFIG],
      useFactory: (config: OolixConfig): OolixLogger =>
        createLogger({
          service: 'api-gateway',
          environment: config.APP_ENV,
          level: config.LOG_LEVEL,
          pretty: config.LOG_FORMAT === 'pretty',
        }),
    },
  ],
  exports: [LOGGER],
})
export class LoggerModule {}
