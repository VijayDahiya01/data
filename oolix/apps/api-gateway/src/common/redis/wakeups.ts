/**
 * Wake-ups for long-polling Agents.
 *
 * An Agent asks for work with ?wait=N and the request is held until work
 * arrives or N seconds pass. Whoever creates the work publishes a wake-up on
 * Redis, so every API instance -- whichever one holds the Agent's request --
 * answers at once. A reach estimate then takes a second or two instead of
 * up to a polling interval.
 *
 * Redis carries only the topic ("estimates:<partner org id>"); the work itself
 * is read from PostgreSQL as before. A lost wake-up costs nothing but the
 * wait: the request still ends on time, and the Agent asks again.
 */
import { Inject, Injectable, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import type Redis from 'ioredis';
import { REDIS } from './redis.token.js';

const PREFIX = 'oolix:wake:';

export interface Waiting {
  /** Resolves when woken or when the time is up. */
  done: Promise<void>;
  /** Stops waiting now. */
  cancel: () => void;
}

@Injectable()
export class Wakeups implements OnModuleInit, OnApplicationShutdown {
  private sub?: Redis;
  private readonly waiters = new Map<string, Set<() => void>>();

  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  onModuleInit(): void {
    // A subscribed connection can do nothing else, so it is a second one.
    this.sub = this.redis.duplicate();
    this.sub.on('pmessage', (_pattern: string, channel: string) => {
      const set = this.waiters.get(channel.slice(PREFIX.length));
      if (set) for (const wake of [...set]) wake();
    });
    this.sub.psubscribe(PREFIX + '*').catch(() => undefined);
  }

  async onApplicationShutdown(): Promise<void> {
    for (const set of this.waiters.values()) for (const wake of [...set]) wake();
    await this.sub?.quit().catch(() => undefined);
  }

  /** Wakes every request waiting on topic, on every API instance. */
  async notify(topic: string): Promise<void> {
    await this.redis.publish(PREFIX + topic, '1').catch(() => undefined);
  }

  /** Waits for a wake-up on topic, up to ms. Register before looking for work. */
  wait(topic: string, ms: number): Waiting {
    let wake = () => {};
    const done = new Promise<void>((resolve) => {
      const timer = setTimeout(() => wake(), ms);
      wake = () => {
        clearTimeout(timer);
        const set = this.waiters.get(topic);
        set?.delete(wake);
        if (set && set.size === 0) this.waiters.delete(topic);
        resolve();
      };
      const set = this.waiters.get(topic) ?? new Set();
      set.add(wake);
      this.waiters.set(topic, set);
    });
    return { done, cancel: () => wake() };
  }
}
