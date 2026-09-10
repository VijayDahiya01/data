/**
 * Oolix background worker -- spec v5 §55, §64.
 *
 * Long-running process, not a scheduled function: §64 forbids serverless
 * cold-start dependencies in the ad-control path, and §78.2 measures queue lag
 * in seconds.
 *
 * Two kinds of work:
 *   - queue consumers, reacting to domain events (§55)
 *   - scheduled monitors, evaluating the §78.2 thresholds
 */
import { loadFileSecrets } from '@oolix/runtime-config';
import { SQSClient } from '@aws-sdk/client-sqs';
import { PrismaPg } from '@prisma/adapter-pg';
import { createLogger } from '@oolix/observability';
import { PrismaClient } from '@oolix/db';
import { QueueConsumer } from './queue/consumer.js';
import { startSchedulers } from './schedulers/index.js';

// Before anything reads a credential: a mounted secret file becomes an
// environment variable here, and nowhere else.
loadFileSecrets();

const env = process.env;

const logger = createLogger({
  service: 'worker',
  environment: env.APP_ENV ?? 'local',
  level: (env.LOG_LEVEL as 'debug' | 'info') ?? 'info',
  pretty: env.LOG_FORMAT === 'pretty',
});

const prisma = new PrismaClient({
  adapter: new PrismaPg({
    connectionString: env.DATABASE_URL,
    // §73: worker pool baseline is 5 per pod, lower than the API's 10.
    max: Number(env.DATABASE_POOL_SIZE ?? 5),
  }),
});

const sqs = new SQSClient({
  region: env.AWS_REGION ?? 'ap-south-1',
  ...(env.AWS_ENDPOINT_URL ? { endpoint: env.AWS_ENDPOINT_URL } : {}),
  ...(env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY
    ? {
        credentials: {
          accessKeyId: env.AWS_ACCESS_KEY_ID,
          secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
        },
      }
    : {}),
});

async function main(): Promise<void> {
  await prisma.$connect();
  logger.info('worker starting', { event: 'STARTUP' });

  const consumers: QueueConsumer[] = [];

  if (env.SQS_DOMAIN_EVENTS_URL) {
    const domainEvents = new QueueConsumer(sqs, logger, {
      queueUrl: env.SQS_DOMAIN_EVENTS_URL,
      ...(env.SQS_DOMAIN_EVENTS_DLQ_URL ? { dlqUrl: env.SQS_DOMAIN_EVENTS_DLQ_URL } : {}),
    });

    // Handlers are registered per phase as their producers land. §74 makes an
    // unrouted event harmless, so a partially-wired queue is safe.
    domainEvents.on('AGENT_REGISTERED' as never, async (e) => {
      logger.info('agent registered', {
        event: 'AGENT_REGISTERED',
        correlation_id: e.correlation_id,
        entity_id: e.aggregate.id,
      });
    });

    consumers.push(domainEvents);
    void domainEvents.start();
  } else {
    logger.warn('SQS_DOMAIN_EVENTS_URL is not set; queue consumers are disabled', {
      event: 'STARTUP',
    });
  }

  const stopSchedulers = startSchedulers({ prisma, logger });

  // The scheduler timers are deliberately unref'd, so that a consumer dying
  // takes the process down with it rather than leaving a worker that looks
  // alive and consumes nothing. That is right whenever a consumer is running.
  //
  // With no queue configured there is no consumer, so nothing holds the event
  // loop at all: the worker ran one pass of the monitors and sweeps and exited
  // — with status 0, which tells an orchestrator it finished successfully. The
  // §78.2 monitors then simply stop, quietly.
  //
  // Scheduler-only is a legitimate deployment, so hold the loop open for it.
  const keepAlive = consumers.length === 0 ? setInterval(() => {}, 60_000) : undefined;

  const shutdown = async (signal: string) => {
    logger.info('worker shutting down', { event: 'SHUTDOWN', signal });
    for (const c of consumers) c.stop();
    stopSchedulers();
    if (keepAlive) clearInterval(keepAlive);
    await prisma.$disconnect();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  logger.info('worker ready', { event: 'STARTUP' });
}

main().catch((err) => {
  logger.fatal('worker failed to start', {
    event: 'STARTUP_FAILED',
    error: err instanceof Error ? err.message : String(err),
  });
  process.exit(1);
});
