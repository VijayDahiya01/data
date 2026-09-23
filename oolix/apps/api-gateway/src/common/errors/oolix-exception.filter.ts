/**
 * Global exception filter -- spec v5 §53, §77.2, §99.
 *
 * Every error leaving the API uses the canonical envelope. §99 is explicit:
 * "Return structured error; never expose stack traces or secrets."
 *
 * So this filter is the ONLY place that turns a thrown value into an HTTP
 * body, and unknown errors collapse to SYS_002 with no detail. A stack trace
 * in a 500 body is how database schemas and file paths leak.
 */
import {
  Catch,
  HttpException,
  Inject,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { ZodError } from 'zod';
import { OolixError, buildError, type ErrorCode, type FieldError } from '@oolix/contracts';
import type { OolixLogger } from '@oolix/observability';
import { currentCorrelationId } from '../correlation/correlation.js';
import { LOGGER } from '../logging/logger.provider.js';

@Catch()
export class OolixExceptionFilter implements ExceptionFilter {
  constructor(@Inject(LOGGER) private readonly logger: OolixLogger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const reply = host.switchToHttp().getResponse<FastifyReply>();
    const correlationId = currentCorrelationId();

    const { status, body, logLevel, cause } = this.translate(exception, correlationId);

    this.logger[logLevel](body.error.message, {
      correlation_id: correlationId,
      event: 'REQUEST_FAILED',
      error_code: body.error.code,
      http_status: status,
      // The cause is logged, never returned to the caller.
      ...(cause ? { cause } : {}),
    });

    void reply.status(status).header('x-correlation-id', correlationId).send(body);
  }

  private translate(exception: unknown, correlationId: string) {
    // 1. Domain errors already carry a canonical code.
    if (exception instanceof OolixError) {
      return {
        status: exception.httpStatus,
        body: buildError(exception.code, correlationId, {
          message: exception.message,
          fieldErrors: exception.fieldErrors,
          ...(exception.retryAfterSeconds !== undefined
            ? { retryAfterSeconds: exception.retryAfterSeconds }
            : {}),
        }),
        logLevel: exception.httpStatus >= 500 ? ('error' as const) : ('warn' as const),
        cause: exception.cause,
      };
    }

    // 2. Validation failures become VAL_001 with per-field detail (§53).
    if (exception instanceof ZodError) {
      const fieldErrors: FieldError[] = exception.issues.map((i) => ({
        field: i.path.join('.') || '(root)',
        message: i.message,
      }));
      return {
        status: 400,
        body: buildError('VAL_001', correlationId, { fieldErrors }),
        logLevel: 'warn' as const,
        cause: undefined,
      };
    }

    // 3. Nest's own exceptions (404 on an unmatched route, payload too large).
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const code: ErrorCode =
        status === 401
          ? 'AUTH_001'
          : status === 403
            ? 'PERM_001'
            : status === 404
              ? 'CAMP_001'
              : status === 429
                ? 'SYS_001'
                : status >= 500
                  ? 'SYS_002'
                  : 'VAL_001';
      return {
        status,
        body: buildError(code, correlationId, { message: exception.message }),
        logLevel: status >= 500 ? ('error' as const) : ('warn' as const),
        cause: undefined,
      };
    }

    // 4. Anything else is a bug. Return nothing specific.
    return {
      status: 503,
      body: buildError('SYS_002', correlationId),
      logLevel: 'error' as const,
      cause: exception instanceof Error ? exception : String(exception),
    };
  }
}
