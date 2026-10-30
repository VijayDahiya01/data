/**
 * The Compose bundle the API serves is the one in the Partner pack.
 *
 * A Partner's engineers read `partner/pack/docker-compose.partner.yml` before
 * running anything; the API serves its own copy with the deployment's values
 * filled in. If the two drifted, what a Partner reviewed would not be what
 * they ran.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import { PARTNER_COMPOSE_TEMPLATE, renderPartnerCompose } from './partner-compose.js';
import { latestAgentVersion } from './agent-registry.service.js';

const PACK = path.resolve(__dirname, '../../../../../../partner/pack/docker-compose.partner.yml');

describe('Partner Connect Compose bundle', () => {
  it('is the same text as the one in the Partner pack', () => {
    const pack = readFileSync(PACK, 'utf8').replace(/\r\n/g, '\n');
    expect(PARTNER_COMPOSE_TEMPLATE).toBe(pack);
  });

  it('fills in the API address and the Agent image, and nothing else changes', () => {
    const out = renderPartnerCompose(
      'https://api.oolix.example/',
      'ghcr.io/acme/partner-agent:abc123',
    );
    const doc = parse(out) as {
      services: Record<
        string,
        { image: string; environment?: Record<string, string>; ports?: string[] }
      >;
    };
    const agent = doc.services.agent!;
    expect(agent.image).toBe('ghcr.io/acme/partner-agent:abc123');
    expect(agent.environment?.OOLIX_API_BASE_URL).toBe('https://api.oolix.example');
    expect(out).not.toContain('REPLACE_WITH');
    // The setup page is never published beyond the server itself.
    expect(agent.ports).toContain('127.0.0.1:8083:8083');
    // Interpolation is left for Docker Compose, not eaten by the template.
    expect(out).toContain('${OOLIX_SETUP_PASSWORD:-}');
    // The portal's install command sets it, and the Agent registers itself.
    expect(out).toContain('${OOLIX_BOOTSTRAP_TOKEN:-}');
  });
});

describe('latestAgentVersion', () => {
  it('reads the version an image tag names, and nothing else', () => {
    expect(latestAgentVersion('ghcr.io/acme/data/partner-agent:3f2a9c1e')).toBe('3f2a9c1e');
    expect(latestAgentVersion('registry.local:5000/partner-agent:1.4.0')).toBe('1.4.0');
    expect(latestAgentVersion('ghcr.io/acme/data/partner-agent:latest')).toBeNull();
    expect(latestAgentVersion('oolix/partner-agent:dev')).toBeNull();
    expect(latestAgentVersion('ghcr.io/acme/partner-agent@sha256:abc')).toBeNull();
    expect(latestAgentVersion('partner-agent')).toBeNull();
  });
});
