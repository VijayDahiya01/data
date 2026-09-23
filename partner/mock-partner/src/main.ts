/**
 * Mock Data Partner process entrypoint (§91).
 *
 * The server itself lives in `app.ts` so the same wiring can be exercised by
 * tests without binding a port.
 */
import { buildApp } from './app.js';

const PORT = Number(process.env.MOCK_PARTNER_PORT ?? 4001);
const AGENT_URL = process.env.PARTNER_AGENT_URL ?? 'http://localhost:8082';

buildApp({ agentUrl: AGENT_URL })
  .listen({ port: PORT, host: '0.0.0.0' })
  .then(() => {
    process.stdout.write(
      `
[mock-partner] http://localhost:${PORT}
` +
        `  ?user=U123  eligible (RECENT_TRAVELLER_60D, PREMIUM_USER)
` +
        `  ?user=U456  in no segment
` +
        `  ?user=U321  consent withdrawn
` +
        `  Partner Agent: ${AGENT_URL}

`,
    );
  })
  .catch((err) => {
    process.stderr.write(`[mock-partner] failed to start: ${String(err)}
`);
    process.exit(1);
  });
