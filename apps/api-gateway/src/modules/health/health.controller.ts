/**
 * Health probes -- spec v5 §67, §69.2.
 *
 * §69.2 draws the distinction that matters to an orchestrator:
 *   /healthz  process is alive; NO dependency checks
 *   /readyz   dependencies are healthy enough to serve
 *
 * Conflating them causes a database blip to restart every pod instead of
 * merely removing them from the load balancer.
 */
import { Controller, Get, Inject, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { CONTRACT_VERSION } from '@oolix/contracts';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AgentKeyService } from '../../keys/agent-key.service.js';
import { Public } from '../../common/auth/auth.guard.js';
import { NoRateLimit } from '../../common/ratelimit/rate-limit.guard.js';
import { CONFIG, type OolixConfig } from '../../config/configuration.js';

// §94: probes are exempt from rate limiting. An orchestrator polls /healthz
// every few seconds from every node; throttling it would take the whole
// deployment out of rotation on the busiest cluster, which is the exact
// opposite of what a liveness probe is for.
@NoRateLimit()
@Controller()
export class HealthController {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AgentKeyService) private readonly keys: AgentKeyService,
    @Inject(CONFIG) private readonly config: OolixConfig,
  ) {}

  @Public()
  @Get('healthz')
  liveness() {
    return { status: 'ok', contract_version: CONTRACT_VERSION };
  }

  @Public()
  @Get('readyz')
  async readiness(@Res({ passthrough: true }) reply: FastifyReply) {
    const database = await this.prisma.ping();
    const ready = database;
    void reply.status(ready ? 200 : 503);
    return {
      status: ready ? 'ready' : 'not_ready',
      checks: { database },
      contract_version: CONTRACT_VERSION,
      environment: this.config.APP_ENV,
    };
  }

  /**
   * Manifest verification keys (§75).
   *
   * Public by design: Partner Agents fetch and cache this to verify signed
   * manifests, and pin issuer and audience against it.
   */
  @Public()
  @Get('.well-known/oolix-manifest-jwks.json')
  manifestJwks() {
    return this.keys.manifestJwks();
  }
}
