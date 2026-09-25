/**
 * Portal end-to-end tests.
 *
 * RUN THESE AGAINST A PRODUCTION BUILD, not `next dev`.
 *
 * The dev server compiles on demand through Turbopack, and under memory
 * pressure it crashes mid-suite -- `PoisonError`, or "Jest worker
 * encountered 2 child process exceptions". The browser then sees a Next.js
 * error page instead of the application, and the failure looks like a
 * missing element rather than a dead compiler. Measured on the same commit:
 * 4 failures in 11.1 minutes against `next dev`, 32 passes in 2.6 minutes
 * against `pnpm build && pnpm start`.
 *
 * The production build is also what actually deploys, so it is the honest
 * thing to test.
 */
/**
 * Portal end-to-end configuration (§79.1).
 *
 * Separate from `playwright.config.ts` because these two suites need opposite
 * things. The Mock Partner suite starts its own server and deliberately runs
 * against an Agent that is DOWN. This one needs the whole stack up — the
 * databases, the API, the portal — and cannot start any of it, so it points at
 * what is already running rather than pretending otherwise.
 *
 *   pnpm infra:up
 *   pnpm dev:api
 *   pnpm --filter @oolix/web-portal start
 *   pnpm test:e2e:portal
 */
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  testMatch:
    '**/{portal,campaign-flow,segment-publish,all-screens,v6-partner-forms,screenshots,dark-check,session-expiry,audience-lifecycle,submit-gate}.e2e.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  // These drive a real stack: a real sign-in per test, then a sweep
  // of many server-rendered pages. The 30s default is a per-test budget meant
  // for a single interaction.
  timeout: 150_000,
  expect: { timeout: 20_000 },
  use: {
    baseURL: process.env.PORTAL_URL ?? 'http://localhost:3000',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
