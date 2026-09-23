/**
 * Everything that turns a bare Nest application into the Oolix API.
 *
 * Extracted from `main.ts` so integration tests boot the SAME stack the
 * process does. §82 lists security headers, CORS and structured logging as
 * launch requirements; a test suite that skipped them would happily pass while
 * production served responses without them.
 */
import helmet from '@fastify/helmet';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { OolixLogger } from '@oolix/observability';
import { redactUrl } from '@oolix/observability';
import { CONFIG, type OolixConfig } from './config/configuration.js';
import { LOGGER } from './common/logging/logger.provider.js';
import { OolixExceptionFilter } from './common/errors/oolix-exception.filter.js';
import {
  CORRELATION_HEADER,
  resolveCorrelationId,
  runWithContext,
} from './common/correlation/correlation.js';

/** Fastify adapter options shared by the process and the test harness. */
export const fastifyOptions = {
  // Correlation IDs are generated in the hook below, so Fastify's own request
  // id is redundant.
  genReqId: () => '',
  trustProxy: true,
  bodyLimit: 1 * 1024 * 1024,
};

export async function configureApp(app: NestFastifyApplication): Promise<void> {
  const config = app.get<OolixConfig>(CONFIG);
  const logger = app.get<OolixLogger>(LOGGER);

  // §82 security headers.
  await app.register(helmet, {
    contentSecurityPolicy: config.APP_ENV === 'production' ? undefined : false,
    hsts: config.APP_ENV === 'production' ? { maxAge: 31_536_000, includeSubDomains: true } : false,
    frameguard: { action: 'deny' },
    referrerPolicy: { policy: 'no-referrer' },
  });

  // §82 CORS: "Oolix web API permits only Oolix portal origins. Partner SDK
  // calls Partner backend, not Oolix cross-origin." No Partner origin belongs
  // in this list -- if one ever appears, the SDK is talking to the wrong host.
  app.enableCors({
    origin: [config.WEB_PUBLIC_URL],
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'Idempotency-Key',
      'X-Correlation-Id',
      'X-Org-Id',
      'X-Agent-Id',
    ],
    exposedHeaders: [
      'X-Correlation-Id',
      'X-RateLimit-Limit',
      'X-RateLimit-Remaining',
      'X-RateLimit-Reset',
      'Retry-After',
    ],
    maxAge: 600,
  });

  const instance = app.getHttpAdapter().getInstance();

  // Establish the correlation context for the whole request lifecycle (§99).
  //
  // The id is stashed on the request because onResponse runs OUTSIDE the
  // AsyncLocalStorage scope opened here. Re-deriving it there would mint a
  // fresh id for any caller that did not send one, so the access log and the
  // error log for the same request would carry different ids -- exactly what
  // correlation is supposed to prevent.
  instance.decorateRequest('oolixCorrelationId', '');

  instance.addHook('onRequest', (req: FastifyRequest, reply: FastifyReply, done) => {
    const correlationId = resolveCorrelationId(req.headers[CORRELATION_HEADER]);
    (req as FastifyRequest & { oolixCorrelationId: string }).oolixCorrelationId = correlationId;
    void reply.header(CORRELATION_HEADER, correlationId);
    runWithContext({ correlationId }, () => done());
  });

  instance.addHook('onResponse', (req: FastifyRequest, reply: FastifyReply, done) => {
    logger.info('request', {
      correlation_id: (req as FastifyRequest & { oolixCorrelationId: string }).oolixCorrelationId,
      event: 'HTTP_REQUEST',
      method: req.method,
      // §53 / §82: never log a raw URL -- it may carry a token or PII.
      path: redactUrl(req.url),
      status: reply.statusCode,
      duration_ms: Math.round(reply.elapsedTime),
    });
    done();
  });

  app.useGlobalFilters(app.get(OolixExceptionFilter));
}
