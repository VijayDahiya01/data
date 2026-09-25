/**
 * Create the first Oolix platform administrator.
 *
 * An empty production database has no way in: signing in needs an account,
 * accounts come from invitations, and invitations come from an existing
 * administrator. This command is the one exception, run by whoever operates
 * the servers:
 *
 *   docker compose ... run --rm api node dist/cli/create-admin.js \
 *     --email ops@yourcompany.com --name "Priya Sharma"
 *
 * It creates the Oolix operations organization, records the person as its
 * OOLIX_ADMIN, and EMAILS them an invitation. The link never appears on the
 * terminal outside local development (where the `log` email transport prints
 * it), so a shared console or CI log cannot leak a working credential.
 *
 * It refuses once an administrator exists. Every further administrator is
 * invited from the portal's Team page by an existing one, which leaves an
 * audit trail with a real person's name on it. Running it again for the SAME
 * still-pending address just sends a fresh invitation -- the email went to
 * spam, or the week ran out.
 */
import 'reflect-metadata';
import { loadFileSecrets } from '@oolix/runtime-config';
import { loadDotEnv } from '../config/load-env.js';

loadDotEnv();
loadFileSecrets();

import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppConfigModule } from '../config/config.module.js';
import { LoggerModule } from '../common/logging/logger.provider.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { KeysModule } from '../keys/keys.module.js';
import { AuditModule } from '../common/audit/audit.module.js';
import { AuditService } from '../common/audit/audit.service.js';
import { AuthModule } from '../modules/auth/auth.module.js';
import { AuthService } from '../modules/auth/auth.service.js';

/** Only what sending an invitation needs: no HTTP server, Redis or queues. */
@Module({
  imports: [AppConfigModule, LoggerModule, PrismaModule, KeysModule, AuditModule, AuthModule],
})
class CreateAdminModule {}

function fail(message: string): never {
  console.error(`create-admin: ${message}`);
  process.exit(1);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      email: { type: 'string' },
      name: { type: 'string' },
      org: { type: 'string', default: 'Oolix Platform Operations' },
      domain: { type: 'string' },
    },
  });

  const email = values.email?.trim().toLowerCase();
  const name = values.name?.trim();
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    fail('--email is required, e.g. --email ops@yourcompany.com');
  }
  if (!name || name.length < 2 || name.length > 100) {
    fail('--name is required, e.g. --name "Priya Sharma"');
  }
  const orgName = values.org.trim();
  const domain = (values.domain ?? email.split('@')[1]!).toLowerCase();

  const app = await NestFactory.createApplicationContext(CreateAdminModule, {
    logger: ['error', 'warn'],
  });
  try {
    const prisma = app.get(PrismaService);
    const audit = app.get(AuditService);
    const auth = app.get(AuthService);

    const admins = await prisma.organizationMember.findMany({
      where: { role: 'OOLIX_ADMIN', status: { in: ['ACTIVE', 'INVITED'] } },
      include: { user: { select: { email: true } } },
    });
    const retry = admins.find((m) => m.status === 'INVITED' && m.user.email === email);
    if (admins.some((m) => m !== retry)) {
      fail(
        'an Oolix administrator already exists. Invite further administrators from the ' +
          "portal's Team page, signed in as that administrator.",
      );
    }

    const existingUser = await prisma.user.findUnique({ where: { email } });
    if (existingUser?.status === 'DISABLED') {
      fail(`${email} belongs to a disabled account. Use a different address.`);
    }

    // A retry reuses the organization the first run created. A fresh run
    // never adopts an organization by name: anyone may sign up and register
    // one called "Oolix Platform Operations", and attaching the platform's
    // administrator to it would hand that stranger a seat beside them.
    const { orgId, userId } = retry
      ? { orgId: retry.orgId, userId: retry.userId }
      : await prisma.$transaction(async (tx) => {
          const org = await tx.organization.create({
            data: {
              name: orgName,
              domain,
              type: 'AGENCY',
              country: 'IN',
              industry: 'adtech',
              // The operator verifies everyone else; nobody verifies it.
              verificationStatus: 'BUSINESS_VERIFIED',
            },
          });
          const id = randomUUID();
          const user =
            existingUser ??
            (await tx.user.create({
              data: {
                id,
                email,
                name,
                authSubject: `local:${id}`,
                status: 'PENDING_EMAIL_VERIFICATION',
              },
            }));
          await tx.organizationMember.create({
            data: { orgId: org.id, userId: user.id, role: 'OOLIX_ADMIN', status: 'INVITED' },
          });
          return { orgId: org.id, userId: user.id };
        });

    await audit.record({
      action: retry ? 'PLATFORM_ADMIN_REINVITED' : 'PLATFORM_ADMIN_BOOTSTRAPPED',
      entityType: 'organization_member',
      entityId: `${orgId}:${userId}`,
      orgId,
      actor: 'create-admin-cli',
      actorType: 'SYSTEM',
    });

    const org = await prisma.organization.findUniqueOrThrow({ where: { id: orgId } });
    if (!(await auth.sendInvitation(userId, org.name))) {
      fail(
        'the administrator was recorded, but the invitation email could not be sent. ' +
          'Check EMAIL_PROVIDER, BREVO_API_KEY and EMAIL_FROM, then run this again.',
      );
    }
    console.log(
      `Invitation sent to ${email}. Its link works for 7 days: opening it sets a password ` +
        `and signs them in as the Oolix administrator of "${org.name}".`,
    );
  } finally {
    await app.close();
  }
}

main().catch((err: unknown) => {
  console.error('create-admin failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
