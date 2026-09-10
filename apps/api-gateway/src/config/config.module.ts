import { Global, Module } from '@nestjs/common';
import { CONFIG, loadConfig } from './configuration.js';

/**
 * Configuration is loaded and validated ONCE at boot (§65.1). Every consumer
 * injects the frozen result, so no code path reads process.env directly and
 * no request can observe a half-configured service.
 */
@Global()
@Module({
  providers: [{ provide: CONFIG, useFactory: () => Object.freeze(loadConfig()) }],
  exports: [CONFIG],
})
export class AppConfigModule {}
