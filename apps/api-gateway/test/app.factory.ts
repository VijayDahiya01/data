/**
 * Boots the REAL application for integration tests (§79.1).
 *
 * Deliberately imports `AppModule` rather than assembling a reduced module:
 * most of what these tests protect -- the global auth guard, the rate limit
 * guard, the idempotency interceptor, the error filter -- exists only because
 * of how the application is wired together. A hand-built test module would
 * pass while the real one was broken.
 */
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from '../src/app.module.js';
import { configureApp, fastifyOptions } from '../src/bootstrap.js';

export interface TestApp {
  app: NestFastifyApplication;
  /** Every route Nest actually mapped, as `method /path` with `:param` segments. */
  routes: Set<string>;
}

export async function createTestApp(): Promise<TestApp> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();

  const app = moduleRef.createNestApplication<NestFastifyApplication>(
    new FastifyAdapter(fastifyOptions),
  );

  // Collected from Fastify itself rather than by re-reading the controller
  // decorators, so the set reflects what was ACTUALLY registered. The hook is
  // attached before init(), which is when Nest registers the routes.
  const routes = new Set<string>();
  app
    .getHttpAdapter()
    .getInstance()
    .addHook('onRoute', (route) => {
      const methods = Array.isArray(route.method) ? route.method : [route.method];
      for (const method of methods) {
        const m = method.toLowerCase();
        if (m === 'head' || m === 'options') continue;
        routes.add(`${m} ${route.url}`);
      }
    });

  // The same security headers, CORS, correlation hooks and error filter the
  // process installs -- see src/bootstrap.ts.
  await configureApp(app);

  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return { app, routes };
}
