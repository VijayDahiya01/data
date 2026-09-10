/**
 * The scrape endpoint.
 *
 * NOT for the public internet. It names Partner organisations and Agent ids,
 * which is operational detail no Buyer or Partner should be able to enumerate,
 * and it is the sort of endpoint that quietly becomes a reconnaissance tool.
 * The TLS terminator refuses it from outside (see infra/caddy/Caddyfile); this
 * controller is reachable on the internal network, which is where a collector
 * lives.
 */
import { Controller, Get, Inject, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { Public } from '../../common/auth/auth.guard.js';
import { NoRateLimit } from '../../common/ratelimit/rate-limit.guard.js';
import { MetricsService } from './metrics.service.js';

@NoRateLimit()
@Controller()
export class MetricsController {
  constructor(@Inject(MetricsService) private readonly metrics: MetricsService) {}

  // Written straight to the reply, not returned.
  //
  // A returned value goes through the response envelope every other endpoint
  // uses, and Prometheus exposition is not JSON -- the envelope turns the body
  // into an object Fastify then refuses to send as text/plain. The failure is
  // a 500 on the scrape endpoint only, so it would have gone unnoticed until
  // the first alert did not fire.
  @Public()
  @Get('metrics')
  async scrape(@Res() reply: FastifyReply): Promise<void> {
    const body = await this.metrics.render();
    await reply.header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8').send(body);
  }
}
