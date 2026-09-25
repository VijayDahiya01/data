/**
 * Sending email: verification links, invitations, password resets.
 *
 * Three transports, chosen by EMAIL_PROVIDER, and the configuration schema
 * refuses anything but `brevo` wherever real people sign in:
 *
 *   brevo    Brevo's HTTPS API. Port 443 rather than SMTP, so EC2's outbound
 *            port-25 block never matters, and no sandbox stage to wait out.
 *   log      local development: the whole message is printed, link included,
 *            so the flows can be clicked through without a mail account.
 *   capture  automated tests: kept in memory for the test to read.
 *
 * `send` reports failure instead of throwing. The caller decides: an
 * invitation surfaces it to the admin who sent it, while sign-up and
 * forgot-password must answer identically either way, or a delivery failure
 * would reveal which addresses have accounts.
 *
 * Neither addresses nor links are logged by the real transport: an address is
 * personal data (§78.1), and a link is a credential until it is used.
 */
import { Inject, Injectable } from '@nestjs/common';
import type { OolixLogger } from '@oolix/observability';
import { CONFIG, type OolixConfig } from '../../../config/configuration.js';
import { LOGGER } from '../../../common/logging/logger.provider.js';
import type { RenderedEmail } from './email.templates.js';

export interface SentEmail extends RenderedEmail {
  to: string;
  template: string;
  at: Date;
}

const BREVO_ENDPOINT = 'https://api.brevo.com/v3/smtp/email';

/** `Oolix <no-reply@example.com>` or a bare address. */
export function parseSender(from: string): { name?: string; email: string } {
  const m = /^\s*(.*?)\s*<\s*([^>]+)\s*>\s*$/.exec(from);
  if (m) return m[1] ? { name: m[1], email: m[2]! } : { email: m[2]! };
  return { email: from.trim() };
}

@Injectable()
export class EmailService {
  private readonly kept: SentEmail[] = [];

  constructor(
    @Inject(CONFIG) private readonly config: OolixConfig,
    @Inject(LOGGER) private readonly logger: OolixLogger,
  ) {}

  /** True when the message was accepted for delivery. */
  async send(template: string, to: string, message: RenderedEmail): Promise<boolean> {
    switch (this.config.EMAIL_PROVIDER) {
      case 'capture':
        this.kept.push({ ...message, to, template, at: new Date() });
        return true;
      case 'log':
        // Local development only -- the schema rejects `log` anywhere else.
        // Straight to stdout rather than through the logger, whose redaction
        // would strip exactly the link a developer needs to click.
        process.stdout.write(
          `\n[oolix-email] ${template} → ${to}\nSubject: ${message.subject}\n\n${message.text}\n\n`,
        );
        return true;
      case 'brevo':
        return this.viaBrevo(template, to, message);
    }
  }

  private async viaBrevo(template: string, to: string, message: RenderedEmail): Promise<boolean> {
    try {
      const res = await fetch(BREVO_ENDPOINT, {
        method: 'POST',
        headers: {
          'api-key': this.config.BREVO_API_KEY ?? '',
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify({
          sender: parseSender(this.config.EMAIL_FROM),
          to: [{ email: to }],
          subject: message.subject,
          textContent: message.text,
          htmlContent: message.html,
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        // The status alone: Brevo's error body can echo the recipient.
        this.logger.error('email_send_failed', { template, provider: 'brevo', status: res.status });
        return false;
      }
      this.logger.info('email_sent', { template, provider: 'brevo' });
      return true;
    } catch (err) {
      this.logger.error('email_send_failed', {
        template,
        provider: 'brevo',
        error: err instanceof Error ? err.name : 'unknown',
      });
      return false;
    }
  }

  /** Test seam: everything the capture transport has kept, newest last. */
  captured(): readonly SentEmail[] {
    return this.kept;
  }

  /** Test seam: the most recent message to one address. */
  lastTo(address: string): SentEmail | undefined {
    return [...this.kept].reverse().find((m) => m.to === address.toLowerCase());
  }
}
