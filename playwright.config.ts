/**
 * End-to-end smoke tests -- spec v5 §79.1 ("e2e smoke" stage).
 *
 * Scope is deliberately narrow. The full business flow -- onboarding,
 * approval, serving, attribution, settlement -- is already proven end to end
 * by `pnpm verify`, which drives real HTTP against a live Agent and asserts
 * §85's phase exit criteria. Repeating that through a browser would be slower
 * and less precise.
 *
 * What only a browser can prove is the part of §43 that faces a customer:
 * "ad placement failure cannot block checkout/booking/login". That is a
 * rendering property of the Partner's own page, and it is what this suite
 * covers.
 *
 * Playwright starts the Mock Partner (§91) itself and points it at an Agent
 * address that is deliberately not listening, so the suite needs no
 * infrastructure and runs anywhere.
 */
import { defineConfig, devices } from '@playwright/test';

const PORT = 4099;

export default defineConfig({
  testDir: './e2e',
  // The portal suite has its own config: it needs the whole stack running,
  // while this one starts its own server and needs the Agent DOWN.
  testMatch: '**/partner-page.e2e.ts',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['list']] : [['list']],

  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'on-first-retry',
  },

  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],

  webServer: {
    command: 'pnpm --filter @oolix/mock-partner dev',
    url: `http://127.0.0.1:${PORT}/healthz`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    env: {
      MOCK_PARTNER_PORT: String(PORT),
      // Points at a port nothing is listening on. §43 says the page must cope
      // with exactly this, so the default state of the suite is the failure
      // state -- the one that is easy to leave untested otherwise.
      PARTNER_AGENT_URL: 'http://127.0.0.1:9',
      MOCK_PARTNER_TIMEOUT_MS: '150',
    },
  },
});
