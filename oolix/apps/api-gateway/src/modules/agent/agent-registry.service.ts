/**
 * Partner Agent registration and workload authentication -- spec v5 §69.3, §92.
 *
 * The security properties this file is responsible for:
 *
 *   - A bootstrap token is 32 random bytes, single-use, 15 minutes, and only
 *     its SHA-256 is stored (§92.1). Reading the database yields nothing
 *     usable.
 *   - Consuming a bootstrap token and creating the Agent happen in ONE
 *     transaction (§92.2), so a crash cannot leave a token spendable twice.
 *   - The Agent's private key never reaches Oolix (§92.2). We store only its
 *     public JWK, which is why a signed report batch is meaningful tamper
 *     evidence -- Oolix could not have produced it.
 */
import { Injectable, Inject } from '@nestjs/common';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { JWK } from 'jose';
import { OolixError, type Channel } from '@oolix/contracts';
import {
  defaultAgentScopes,
  issueAgentAccessToken,
  verifyClientAssertion,
  CLIENT_ASSERTION_TYPE,
} from '@oolix/auth-rbac';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AuditService } from '../../common/audit/audit.service.js';
import { AgentKeyService } from '../../keys/agent-key.service.js';
import { CONFIG, type OolixConfig } from '../../config/configuration.js';
import { toBytes } from '../../common/bytes.js';
import { renderPartnerCompose } from './partner-compose.js';

export const RegisterAgentSchema = z.object({
  bootstrap_token: z.string().min(20),
  agent_public_key_jwk: z.object({
    kty: z.literal('EC'),
    crv: z.literal('P-256'),
    x: z.string().min(1),
    y: z.string().min(1),
    // A private key parameter here means the Agent is misconfigured and
    // leaking its own secret; refuse rather than store it.
    d: z.undefined({ message: 'must not include private key material' }).optional(),
  }),
  agent_version: z.string().min(1).max(32),
  capabilities: z.array(z.enum(['PARTNER_WEB', 'PARTNER_APP', 'META', 'GOOGLE'])).min(1),
});
export type RegisterAgentInput = z.infer<typeof RegisterAgentSchema>;

export const AgentTokenSchema = z.object({
  client_id: z.string().min(1),
  client_assertion_type: z.literal(CLIENT_ASSERTION_TYPE),
  client_assertion: z.string().min(20),
});
export type AgentTokenInput = z.infer<typeof AgentTokenSchema>;

export const HeartbeatSchema = z.object({
  agent_version: z.string().min(1).max(32),
  config_age_seconds: z.number().int().nonnegative(),
  status: z.enum(['HEALTHY', 'DEGRADED', 'ERROR']),
  sent_at: z.string().refine((v) => !Number.isNaN(Date.parse(v)), 'ISO-8601 date-time'),
  connector_status: z.enum(['HEALTHY', 'DEGRADED', 'ERROR']).optional(),
  payload_signature: z.string().optional(),
});
export type HeartbeatInput = z.infer<typeof HeartbeatSchema>;

function sha256(value: string): Uint8Array<ArrayBuffer> {
  return toBytes(createHash('sha256').update(value).digest());
}

@Injectable()
export class AgentRegistryService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(AgentKeyService) private readonly keys: AgentKeyService,
    @Inject(CONFIG) private readonly config: OolixConfig,
  ) {}

  /**
   * The Partner Connect bundle, with this deployment's API address and Agent
   * image filled in. It holds no secret: the Agent registers from its setup
   * page with a one-time code, and the local store's password is generated
   * on the Partner's server.
   */
  composeBundle(): string {
    return renderPartnerCompose(this.config.API_PUBLIC_URL, this.config.PARTNER_AGENT_IMAGE);
  }

  // -------------------------------------------------------------------------
  // §92.1 bootstrap token
  // -------------------------------------------------------------------------

  /**
   * Mint a one-time bootstrap token. Returned in plaintext EXACTLY once --
   * only its hash is persisted, so it cannot be recovered or re-displayed.
   */
  async createBootstrapToken(partnerOrgId: string, generatedBy: string) {
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + this.config.AGENT_BOOTSTRAP_TOKEN_TTL_SEC * 1000);

    const record = await this.prisma.agentBootstrapToken.create({
      data: {
        partnerOrgId,
        tokenHash: sha256(token),
        generatedBy,
        expiresAt,
      },
    });

    await this.audit.record({
      action: 'AGENT_BOOTSTRAP_TOKEN_ISSUED',
      entityType: 'agent_bootstrap_token',
      entityId: record.id,
      orgId: partnerOrgId,
      // The token itself is never audited (§78.1).
      metadata: { expires_at: expiresAt.toISOString() },
    });

    return {
      bootstrap_token: token,
      expires_at: expiresAt.toISOString(),
      warning: 'This token is shown once, is single-use and expires in 15 minutes.',
    };
  }

  async revokeBootstrapTokens(partnerOrgId: string) {
    const { count } = await this.prisma.agentBootstrapToken.updateMany({
      where: { partnerOrgId, usedAt: null, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return { revoked: count };
  }

  // -------------------------------------------------------------------------
  // §92.2 registration
  // -------------------------------------------------------------------------

  async register(input: RegisterAgentInput) {
    const tokenHash = sha256(input.bootstrap_token);

    // The whole exchange is one transaction: validate, mark spent, create.
    // Serializable isolation because two concurrent registrations racing on
    // the same token must not both succeed.
    const result = await this.prisma.$transaction(
      async (tx) => {
        const record = await tx.agentBootstrapToken.findUnique({ where: { tokenHash } });

        // Constant-time compare on a value we already looked up by hash is
        // belt-and-braces, but the lookup itself is the real defence: an
        // attacker never learns whether a guess was close.
        if (!record || !timingSafeEqual(Buffer.from(record.tokenHash), Buffer.from(tokenHash))) {
          throw new OolixError('AUTH_001', 'Invalid bootstrap token.');
        }
        if (record.revokedAt) throw new OolixError('AUTH_001', 'Bootstrap token was revoked.');
        if (record.usedAt) throw new OolixError('AUTH_001', 'Bootstrap token was already used.');
        if (record.expiresAt.getTime() <= Date.now()) {
          throw new OolixError('AUTH_001', 'Bootstrap token has expired.');
        }

        const org = await tx.organization.findUnique({ where: { id: record.partnerOrgId } });
        if (!org || org.verificationStatus === 'SUSPENDED') {
          throw new OolixError('PERM_002', 'Partner organization is not eligible.');
        }

        // §92.2: mark spent in the SAME transaction that creates the Agent.
        await tx.agentBootstrapToken.update({
          where: { id: record.id },
          data: { usedAt: new Date() },
        });

        const clientId = `oolix_agent_${randomBytes(9).toString('hex')}`;

        const agent = await tx.agent.create({
          data: {
            partnerOrgId: record.partnerOrgId,
            clientId,
            publicJwk: input.agent_public_key_jwk as never,
            version: input.agent_version,
            capabilities: input.capabilities as never,
            status: 'ACTIVE',
          },
        });

        return { agent, partnerOrgId: record.partnerOrgId };
      },
      { isolationLevel: 'Serializable' },
    );

    await this.audit.record({
      action: 'AGENT_REGISTERED',
      entityType: 'agent',
      entityId: result.agent.id,
      orgId: result.partnerOrgId,
      actor: result.agent.id,
      actorType: 'AGENT',
      metadata: { agent_version: input.agent_version, capabilities: input.capabilities },
    });

    return {
      agent_id: result.agent.id,
      client_id: result.agent.clientId,
      token_endpoint: `${this.config.API_PUBLIC_URL}/agent/v1/token`,
      issuer: this.config.AGENT_TOKEN_ISSUER,
      audience: this.config.AGENT_TOKEN_AUDIENCE,
      /**
       * The Partner this Agent now acts for, and the values its manifests are
       * pinned to (§75). A managed Agent registers from its setup page and
       * configures itself from these instead of a hand-edited file.
       */
      partner_org_id: result.partnerOrgId,
      manifest_issuer: this.config.MANIFEST_ISSUER,
      manifest_audience: this.config.MANIFEST_AUDIENCE,
      /** §75: where to fetch manifest verification keys. */
      manifest_jwks_uri: `${this.config.API_PUBLIC_URL}/.well-known/oolix-manifest-jwks.json`,
      control_sync_interval_seconds: this.config.CONTROL_SYNC_INTERVAL_SEC,
      stale_grace_seconds: this.config.CONTROL_STALE_GRACE_SEC,
    };
  }

  // -------------------------------------------------------------------------
  // §92.3 access token
  // -------------------------------------------------------------------------

  async issueToken(input: AgentTokenInput) {
    const agent = await this.prisma.agent.findUnique({
      where: { clientId: input.client_id },
      include: { organization: true },
    });

    if (!agent || agent.status !== 'ACTIVE') {
      throw new OolixError('AUTH_001', 'Unknown or revoked agent.');
    }

    await verifyClientAssertion(
      input.client_assertion,
      input.client_id,
      async () => {
        // §69.3: during a rotation both keys are accepted for up to 24 hours,
        // so an Agent mid-rollout is never locked out of its own control plane.
        const keys: JWK[] = [agent.publicJwk as JWK];
        if (agent.previousPublicJwk && agent.keyRotatedAt) {
          const withinOverlap = Date.now() - agent.keyRotatedAt.getTime() < 24 * 3_600_000;
          if (withinOverlap) keys.push(agent.previousPublicJwk as JWK);
        }
        return keys;
      },
      {
        issuer: this.config.AGENT_TOKEN_ISSUER,
        audience: `${this.config.API_PUBLIC_URL}/agent/v1/token`,
      },
    );

    if (agent.organization.verificationStatus === 'SUSPENDED') {
      throw new OolixError('PERM_002', 'Partner organization is suspended.');
    }

    const scopes = defaultAgentScopes();

    return issueAgentAccessToken(
      {
        sub: agent.id,
        client_id: agent.clientId,
        partner_org_id: agent.partnerOrgId,
        agent_version: agent.version,
        scope: scopes.join(' '),
      },
      this.keys.agentSigner(),
      this.keys.agentSigningKid(),
      {
        issuer: this.config.AGENT_TOKEN_ISSUER,
        audience: this.config.AGENT_TOKEN_AUDIENCE,
        ttlSeconds: this.config.AGENT_ACCESS_TOKEN_TTL_SEC,
      },
    );
  }

  // -------------------------------------------------------------------------
  // §92.4 heartbeat
  // -------------------------------------------------------------------------

  async heartbeat(agentId: string, partnerOrgId: string, input: HeartbeatInput) {
    await this.prisma.agent.update({
      where: { id: agentId },
      data: {
        lastHeartbeatAt: new Date(),
        configAgeSeconds: input.config_age_seconds,
        version: input.agent_version,
      },
    });

    // §78.2 thresholds, echoed back so the Agent can self-report degradation
    // even when it cannot reach the Oolix dashboards.
    const configStale = input.config_age_seconds > 300;
    const configCritical = input.config_age_seconds > this.config.CONTROL_STALE_GRACE_SEC;

    return {
      acknowledged: true,
      partner_org_id: partnerOrgId,
      control_sync_interval_seconds: this.config.CONTROL_SYNC_INTERVAL_SEC,
      stale_grace_seconds: this.config.CONTROL_STALE_GRACE_SEC,
      config_status: configCritical ? 'CRITICAL' : configStale ? 'STALE' : 'FRESH',
      server_time: new Date().toISOString(),
    };
  }

  // -------------------------------------------------------------------------
  // §69.3 / §80 revocation
  // -------------------------------------------------------------------------

  /**
   * Immediately revoke an Agent.
   *
   * §69.3: "Oolix may revoke an Agent immediately during incident response."
   * The auth guard re-checks Agent status on every call, so revocation takes
   * effect at once rather than when the 15-minute token expires.
   */
  async revoke(partnerOrgId: string, agentId: string, reason: string) {
    const agent = await this.prisma.agent.findUnique({ where: { id: agentId } });
    if (!agent || agent.partnerOrgId !== partnerOrgId) {
      throw new OolixError('PART_001', 'Agent not found.');
    }

    await this.prisma.agent.update({
      where: { id: agentId },
      data: { status: 'REVOKED', revokedAt: new Date() },
    });

    await this.audit.record({
      action: 'AGENT_REVOKED',
      entityType: 'agent',
      entityId: agentId,
      orgId: partnerOrgId,
      metadata: { reason },
    });

    return { agent_id: agentId, status: 'REVOKED' };
  }

  async list(partnerOrgId: string) {
    const agents = await this.prisma.agent.findMany({
      where: { partnerOrgId },
      orderBy: { createdAt: 'desc' },
    });

    return agents.map((a) => ({
      agent_id: a.id,
      client_id: a.clientId,
      version: a.version,
      status: a.status,
      capabilities: a.capabilities as Channel[],
      last_heartbeat_at: a.lastHeartbeatAt?.toISOString() ?? null,
      config_age_seconds: a.configAgeSeconds,
      heartbeat_age_seconds: a.lastHeartbeatAt
        ? Math.round((Date.now() - a.lastHeartbeatAt.getTime()) / 1000)
        : null,
      created_at: a.createdAt.toISOString(),
    }));
  }
}
