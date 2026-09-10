/**
 * Signing keys for Agent access tokens (§92.3) and activation manifests (§75).
 *
 * Two distinct key stores, deliberately. §75 and §92 are separate trust
 * domains: a manifest authorises a Partner Agent to serve ads and upload
 * audiences, while an access token merely authenticates an API call. Sharing
 * one key would let a compromise of the lower-value credential forge the
 * higher-value one.
 */
import { Injectable, Inject, type OnModuleInit } from '@nestjs/common';
import type { JWK } from 'jose';
import { importSigningKey, type ManifestSigningKey } from '@oolix/manifest-schema';
import { CONFIG, type OolixConfig } from '../config/configuration.js';
import { FileKeyStore } from './key-store.js';

@Injectable()
export class AgentKeyService implements OnModuleInit {
  private agentStore!: FileKeyStore;
  private manifestStore!: FileKeyStore;
  private agentSigningKey!: ManifestSigningKey;
  private manifestSigningKey!: ManifestSigningKey;

  constructor(@Inject(CONFIG) private readonly config: OolixConfig) {}

  async onModuleInit(): Promise<void> {
    // Outside development a missing key file is a failure, not a prompt to
    // invent one: see the note in FileKeyStore.load.
    const allowCreate = this.config.APP_ENV !== 'production' && this.config.APP_ENV !== 'staging';

    this.manifestStore = await FileKeyStore.load(
      this.config.MANIFEST_JWKS_PATH.replace(/\.json$/, '') + '.keyfile.json',
      'manifest',
      { allowCreate },
    );
    this.agentStore = await FileKeyStore.load('./.keys/agent-token.keyfile.json', 'agent-token', {
      allowCreate,
    });

    this.manifestSigningKey = await importSigningKey(this.manifestStore.privateJwk());
    this.agentSigningKey = await importSigningKey(this.agentStore.privateJwk());
  }

  // --- Agent access tokens (§92.3) -----------------------------------------

  agentSigningKid(): string {
    return this.agentStore.activeKid();
  }

  agentSigner(): ManifestSigningKey {
    return this.agentSigningKey;
  }

  /** Verification keys for Agent access tokens. Internal, not published. */
  async publicJwks(): Promise<{ keys: JWK[] }> {
    return this.agentStore.jwks();
  }

  // --- Manifest signing (§75) ----------------------------------------------

  manifestKid(): string {
    return this.manifestStore.activeKid();
  }

  manifestSigner(): ManifestSigningKey {
    return this.manifestSigningKey;
  }

  /**
   * The JWKS Partner Agents fetch to verify manifests. Served publicly at
   * /.well-known/oolix-manifest-jwks.json -- §75 requires Agents to cache it
   * and pin issuer and audience.
   */
  manifestJwks(): { keys: JWK[] } {
    return this.manifestStore.jwks();
  }
}
