/**
 * SQS consumer framework -- spec v5 §55, §74, §99.
 *
 * §74 fixes the delivery semantics and the consequences:
 *
 *   "Use AWS SQS Standard queues for MVP. Delivery is at-least-once;
 *    consumers must be idempotent. Do not rely on ordering between unrelated
 *    entities."
 *
 * So this framework guarantees three things and deliberately not a fourth:
 *   - a handler that throws is retried on the §74 backoff ladder
 *   - after MAX_RECEIVE_ATTEMPTS the message goes to the DLQ and alerts
 *   - a schema-invalid message goes STRAIGHT to the DLQ (§99: "Queue schema
 *     error -- non-retryable -> DLQ immediately")
 *   - ordering is NOT guaranteed, and handlers must not assume it
 */
import {
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  ChangeMessageVisibilityCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import {
  EventEnvelopeSchema,
  MAX_RECEIVE_ATTEMPTS,
  backoffForAttempt,
  type EventEnvelope,
  type EventType,
} from '@oolix/contracts';
import type { OolixLogger } from '@oolix/observability';

export type EventHandler = (event: EventEnvelope) => Promise<void>;

export interface ConsumerOptions {
  queueUrl: string;
  dlqUrl?: string;
  /** Long-poll seconds. 20 is the SQS maximum and minimises empty receives. */
  waitTimeSeconds?: number;
  maxMessages?: number;
  visibilityTimeoutSeconds?: number;
}

export class QueueConsumer {
  private readonly handlers = new Map<EventType, EventHandler[]>();
  private running = false;

  constructor(
    private readonly sqs: SQSClient,
    private readonly logger: OolixLogger,
    private readonly opts: ConsumerOptions,
  ) {}

  on(eventType: EventType, handler: EventHandler): this {
    const list = this.handlers.get(eventType) ?? [];
    list.push(handler);
    this.handlers.set(eventType, list);
    return this;
  }

  stop(): void {
    this.running = false;
  }

  async start(): Promise<void> {
    this.running = true;
    this.logger.info('queue consumer started', {
      event: 'WORKER_START',
      queue: this.opts.queueUrl,
      event_types: [...this.handlers.keys()],
    });

    while (this.running) {
      try {
        await this.poll();
      } catch (err) {
        // A failure of the receive loop itself (network, credentials) must not
        // kill the worker; back off and keep trying.
        this.logger.error('queue poll failed', {
          event: 'WORKER_POLL_FAILED',
          error: err instanceof Error ? err.message : String(err),
        });
        await sleep(5_000);
      }
    }
  }

  private async poll(): Promise<void> {
    const res = await this.sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: this.opts.queueUrl,
        MaxNumberOfMessages: this.opts.maxMessages ?? 10,
        WaitTimeSeconds: this.opts.waitTimeSeconds ?? 20,
        VisibilityTimeout: this.opts.visibilityTimeoutSeconds ?? 60,
        MessageAttributeNames: ['All'],
        // v3 replaced AttributeNames with MessageSystemAttributeNames.
        MessageSystemAttributeNames: ['ApproximateReceiveCount'],
      }),
    );

    for (const message of res.Messages ?? []) {
      await this.handleMessage(message);
    }
  }

  private async handleMessage(message: {
    Body?: string;
    ReceiptHandle?: string;
    MessageId?: string;
    Attributes?: Record<string, string>;
  }): Promise<void> {
    const receiveCount = Number(message.Attributes?.ApproximateReceiveCount ?? '1');

    let envelope: EventEnvelope;
    try {
      envelope = EventEnvelopeSchema.parse(JSON.parse(message.Body ?? '{}'));
    } catch (err) {
      // §99: a schema error is non-retryable. Retrying a malformed message
      // just burns the retry budget and delays the alert.
      this.logger.error('malformed queue message sent straight to DLQ', {
        event: 'QUEUE_SCHEMA_ERROR',
        message_id: message.MessageId,
        error: err instanceof Error ? err.message : String(err),
      });
      await this.deadLetter(message, 'SCHEMA_INVALID');
      return;
    }

    const log = this.logger.child({
      correlation_id: envelope.correlation_id,
      entity_type: envelope.aggregate.type,
      entity_id: envelope.aggregate.id,
      event: envelope.event_type,
    });

    const handlers = this.handlers.get(envelope.event_type) ?? [];
    if (handlers.length === 0) {
      // An unrouted event is not an error: several consumers share a queue and
      // each ignores what it does not handle.
      await this.deleteMessage(message);
      return;
    }

    try {
      for (const handler of handlers) {
        await handler(envelope);
      }
      await this.deleteMessage(message);
      log.info('event processed');
    } catch (err) {
      const attempt = receiveCount;

      if (attempt >= MAX_RECEIVE_ATTEMPTS) {
        log.error('event exhausted retries; moving to DLQ', {
          attempt,
          error: err instanceof Error ? err.message : String(err),
        });
        await this.deadLetter(message, 'MAX_ATTEMPTS');
        return;
      }

      // Re-drive on the §74 ladder by extending visibility rather than
      // deleting: SQS redelivers automatically once the timeout lapses.
      const delayMs = backoffForAttempt(attempt);
      log.warn('event failed; will retry', {
        attempt,
        retry_in_ms: delayMs,
        error: err instanceof Error ? err.message : String(err),
      });

      if (message.ReceiptHandle) {
        await this.sqs
          .send(
            new ChangeMessageVisibilityCommand({
              QueueUrl: this.opts.queueUrl,
              ReceiptHandle: message.ReceiptHandle,
              VisibilityTimeout: Math.ceil(delayMs / 1000),
            }),
          )
          .catch(() => undefined);
      }
    }
  }

  private async deleteMessage(message: { ReceiptHandle?: string }): Promise<void> {
    if (!message.ReceiptHandle) return;
    await this.sqs.send(
      new DeleteMessageCommand({
        QueueUrl: this.opts.queueUrl,
        ReceiptHandle: message.ReceiptHandle,
      }),
    );
  }

  /**
   * Move a message to the DLQ explicitly and delete the original.
   *
   * §74 keeps the correlation and event id with it so an operator can trace
   * the failure, and §78.2 alerts on any production DLQ message.
   */
  private async deadLetter(
    message: { Body?: string; ReceiptHandle?: string; MessageId?: string },
    reason: string,
  ): Promise<void> {
    if (this.opts.dlqUrl) {
      await this.sqs
        .send(
          new SendMessageCommand({
            QueueUrl: this.opts.dlqUrl,
            MessageBody: message.Body ?? '{}',
            MessageAttributes: {
              dlq_reason: { DataType: 'String', StringValue: reason },
              original_message_id: {
                DataType: 'String',
                StringValue: message.MessageId ?? 'unknown',
              },
            },
          }),
        )
        .catch((err) => {
          this.logger.error('failed to write to DLQ', {
            event: 'DLQ_WRITE_FAILED',
            error: err instanceof Error ? err.message : String(err),
          });
        });
    }
    await this.deleteMessage(message);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
