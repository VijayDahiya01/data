/**
 * Structured logging -- spec v5 §78.1.
 *
 * The canonical log line shape is fixed by §78.1:
 *   timestamp, level, service, environment, correlation_id, org_id,
 *   entity_type, entity_id, event, message
 *
 * Levels, per §78.1:
 *   DEBUG  non-production by default
 *   INFO   state changes and normal operations
 *   WARN   degraded but retryable
 *   ERROR  a business or system action failed
 *   FATAL  the process cannot continue
 */
import pino, { type Logger as PinoLogger } from 'pino';
import { redact } from './redaction.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export interface LogContext {
  correlation_id?: string;
  org_id?: string;
  entity_type?: string;
  entity_id?: string;
  event?: string;
  [key: string]: unknown;
}

export interface LoggerOptions {
  service: string;
  environment: string;
  level?: LogLevel;
  /** Pretty output for local development; JSON everywhere else. */
  pretty?: boolean;
}

export interface OolixLogger {
  debug(msg: string, ctx?: LogContext): void;
  info(msg: string, ctx?: LogContext): void;
  warn(msg: string, ctx?: LogContext): void;
  error(msg: string, ctx?: LogContext): void;
  fatal(msg: string, ctx?: LogContext): void;
  /** Derive a logger that carries fixed context, e.g. per request. */
  child(ctx: LogContext): OolixLogger;
  raw(): PinoLogger;
}

function wrap(base: PinoLogger, bound: LogContext): OolixLogger {
  const emit = (level: LogLevel, msg: string, ctx?: LogContext) => {
    // Redaction happens here, on the merge object, so every call site is
    // covered whether or not the developer remembered (§78.1).
    base[level](redact({ ...bound, ...ctx }), msg);
  };

  return {
    debug: (m, c) => emit('debug', m, c),
    info: (m, c) => emit('info', m, c),
    warn: (m, c) => emit('warn', m, c),
    error: (m, c) => emit('error', m, c),
    fatal: (m, c) => emit('fatal', m, c),
    child: (ctx) => wrap(base, { ...bound, ...ctx }),
    raw: () => base,
  };
}

export function createLogger(opts: LoggerOptions): OolixLogger {
  const level = opts.level ?? (opts.environment === 'production' ? 'info' : 'debug');

  const base = pino({
    level,
    base: { service: opts.service, environment: opts.environment },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      // §78.1 uses upper-case level names.
      level: (label) => ({ level: label.toUpperCase() }),
    },
    // Belt and braces: pino's own redaction covers paths our recursive
    // redactor cannot see, such as raw HTTP header objects.
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'res.headers["set-cookie"]',
        '*.password',
        '*.secret',
      ],
      censor: '[REDACTED]',
    },
    ...(opts.pretty
      ? { transport: { target: 'pino-pretty', options: { colorize: true, translateTime: true } } }
      : {}),
  });

  return wrap(base, {});
}

/**
 * §99: a correlation ID is generated at the edge when the caller did not send
 * one, then propagated through API -> queue -> worker -> Agent.
 */
export function newCorrelationId(): string {
  return `corr_${crypto.randomUUID().replace(/-/g, '')}`;
}

export function isValidCorrelationId(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length > 0 && value.length <= 128 && /^[\w.:-]+$/.test(value)
  );
}
