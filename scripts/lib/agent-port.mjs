/**
 * Choose and discover the Partner Agent's local port.
 *
 * §69.1 lets the Partner set `agent.listen_addr`; 8082 is only a default. That
 * matters more on Windows than it looks: Hyper-V and WSL2 reserve large blocks
 * of TCP ports dynamically, and the reservation moves between reboots. On this
 * machine 8082-8181 became reserved mid-session, and the Agent failed to bind
 * with a message that reads like a permissions problem rather than a taken
 * port.
 *
 * So provisioning probes for a port it can actually bind, and everything that
 * needs to reach the Agent reads back what was chosen. Nobody has to know which
 * port won.
 */
import { createServer } from 'node:net';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export const DEFAULT_AGENT_PORT = 8082;

const CONFIG_PATH = path.resolve(
  path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')),
  '..',
  '..',
  'partner-agent',
  'config.local.yaml',
);

/** True when this process can actually bind the port on all interfaces. */
export function canBind(port) {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '0.0.0.0', () => {
      server.close(() => resolve(true));
    });
  });
}

/**
 * First bindable port at or after `start`.
 *
 * Probing rather than assuming, because a reserved range fails at bind time
 * with EACCES — indistinguishable from a real permissions problem unless you
 * already know to look.
 *
 * The window is wide on purpose: Hyper-V reserves in blocks of 100 and often
 * takes several adjacent ones, so this host had 8082-8281 gone in a single
 * stretch.
 */
export async function findAgentPort(start = DEFAULT_AGENT_PORT, attempts = 400) {
  for (let port = start; port < start + attempts; port += 1) {
    if (await canBind(port)) return port;
  }
  throw new Error(
    `No bindable port between ${start} and ${start + attempts}. On Windows, check ` +
      '`netsh int ipv4 show excludedportrange protocol=tcp` — Hyper-V reserves ranges dynamically.',
  );
}

/**
 * Where the Agent is actually listening, for anything that needs to call it.
 *
 * Order: an explicit override, then whatever provisioning wrote into
 * `config.local.yaml`, then the default. The config file is the source of truth
 * for the running Agent, so reading it beats guessing.
 */
export function agentUrl() {
  if (process.env.PARTNER_AGENT_URL) return process.env.PARTNER_AGENT_URL;

  if (existsSync(CONFIG_PATH)) {
    const match = /listen_addr:\s*["']?([^"'\s]+)["']?/.exec(readFileSync(CONFIG_PATH, 'utf8'));
    const addr = match?.[1];
    if (addr) {
      const port = addr.split(':').pop();
      if (port) return `http://localhost:${port}`;
    }
  }

  return `http://localhost:${DEFAULT_AGENT_PORT}`;
}
