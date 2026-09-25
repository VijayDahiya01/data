/**
 * Refuse passwords that have already leaked.
 *
 * With no second factor, the password is the whole of an account's defence,
 * and the passwords attackers try first are the ones from earlier breaches --
 * credential stuffing, not guessing. Have I Been Pwned's range API answers
 * "has this password appeared in a breach?" without ever seeing it: only the
 * first 5 hex characters of its SHA-1 leave the server (k-anonymity), and
 * `Add-Padding` hides even the size of the answer.
 *
 * Fails OPEN. If the service is slow or down, sign-up must still work; the
 * length rule and the common-password list still apply, and the outage is
 * logged so it is noticed.
 */
import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { OolixLogger } from '@oolix/observability';
import { CONFIG, type OolixConfig } from '../../config/configuration.js';
import { LOGGER } from '../../common/logging/logger.provider.js';

const RANGE_ENDPOINT = 'https://api.pwnedpasswords.com/range/';

@Injectable()
export class PasswordBreachService {
  constructor(
    @Inject(CONFIG) private readonly config: OolixConfig,
    @Inject(LOGGER) private readonly logger: OolixLogger,
  ) {}

  async isBreached(password: string): Promise<boolean> {
    if (!this.config.PASSWORD_BREACH_CHECK) return false;

    const sha1 = createHash('sha1').update(password, 'utf8').digest('hex').toUpperCase();
    const prefix = sha1.slice(0, 5);
    const suffix = sha1.slice(5);

    try {
      const res = await fetch(RANGE_ENDPOINT + prefix, {
        headers: { 'Add-Padding': 'true', 'User-Agent': 'oolix-api' },
        signal: AbortSignal.timeout(2500),
      });
      if (!res.ok) {
        this.logger.warn('password_breach_check_unavailable', { status: res.status });
        return false;
      }
      for (const line of (await res.text()).split('\n')) {
        const [candidate, count] = line.trim().split(':');
        // Padding rows carry a count of 0 and never match a real suffix.
        if (candidate === suffix && Number(count) > 0) return true;
      }
      return false;
    } catch (err) {
      this.logger.warn('password_breach_check_unavailable', {
        error: err instanceof Error ? err.name : 'unknown',
      });
      return false;
    }
  }
}
