/**
 * The key that signs user access tokens.
 *
 * Its own purpose and its own file, separate from the manifest and Agent
 * keys: a leak or rotation of one never touches the others, and a token
 * signed for one kind of caller can never verify as another.
 *
 * Losing this key is far less serious than losing the manifest key -- every
 * signed-in person is simply signed out -- but it is provisioned the same
 * explicit way (`rotate-cli init user-session`), so there is one procedure
 * for keys rather than one per key.
 */
import { Injectable, Inject, type OnModuleInit } from '@nestjs/common';
import type { JWK } from 'jose';
import { importSigningKey, type ManifestSigningKey } from '@oolix/manifest-schema';
import { CONFIG, type OolixConfig } from '../config/configuration.js';
import { FileKeyStore } from './key-store.js';

export const USER_SESSION_KEY_PATH = './.keys/user-session.keyfile.json';

@Injectable()
export class UserKeyService implements OnModuleInit {
  private store!: FileKeyStore;
  private signingKey!: ManifestSigningKey;

  constructor(@Inject(CONFIG) private readonly config: OolixConfig) {}

  async onModuleInit(): Promise<void> {
    const allowCreate = this.config.APP_ENV !== 'production' && this.config.APP_ENV !== 'staging';
    this.store = await FileKeyStore.load(USER_SESSION_KEY_PATH, 'user-session', { allowCreate });
    this.signingKey = await importSigningKey(this.store.privateJwk());
  }

  kid(): string {
    return this.store.activeKid();
  }

  signer(): ManifestSigningKey {
    return this.signingKey;
  }

  /** Every non-retired key, so tokens signed just before a rotation still verify. */
  jwks(): { keys: JWK[] } {
    return this.store.jwks();
  }
}
