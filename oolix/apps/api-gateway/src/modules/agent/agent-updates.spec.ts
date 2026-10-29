import { randomUUID } from 'node:crypto';
import { agentSupported, agentUpdate, inRollout } from './agent-updates.js';

const RELEASES = 'https://downloads.oolix.in/agent/{version}/';

describe('Agent updates', () => {
  it('offers a release to the share of Agents the rollout has reached', () => {
    const agents = Array.from({ length: 4000 }, () => randomUUID());
    const reached = agents.filter((a) => inRollout(a, 'abc123', 10)).length;
    // About a tenth: a fair draw, not the first Agents to ask.
    expect(reached).toBeGreaterThan(300);
    expect(reached).toBeLessThan(500);
    expect(agents.every((a) => inRollout(a, 'abc123', 100))).toBe(true);
    expect(agents.some((a) => inRollout(a, 'abc123', 0))).toBe(false);
    // Every heartbeat of one Agent gets the same answer during a release...
    const one = agents[0]!;
    expect(new Set(Array.from({ length: 20 }, () => inRollout(one, 'abc123', 50))).size).toBe(1);
    // ...and those in a small share are not always the same Agents.
    const first = agents.filter((a) => inRollout(a, 'abc123', 5));
    const next = agents.filter((a) => inRollout(a, 'def456', 5));
    expect(first.filter((a) => next.includes(a)).length).toBeLessThan(first.length / 2);
  });

  it('says where the release is published, and offers nothing to an Agent running it', () => {
    expect(agentUpdate('agent-1', 'old', 'abc123', RELEASES, 100)).toEqual({
      version: 'abc123',
      url: 'https://downloads.oolix.in/agent/abc123/',
    });
    expect(
      agentUpdate('agent-1', 'old', 'abc123', 'https://github.com/o/r/releases/download/', 100),
    ).toEqual({
      version: 'abc123',
      url: 'https://github.com/o/r/releases/download/abc123/',
    });
    expect(agentUpdate('agent-1', 'abc123', 'abc123', RELEASES, 100)).toBeNull();
    // No release URL: Agents are only told a newer version exists.
    expect(agentUpdate('agent-1', 'old', 'abc123', undefined, 100)).toBeNull();
    // An image without a version names nothing to install.
    expect(agentUpdate('agent-1', 'old', null, RELEASES, 100)).toBeNull();
    expect(agentUpdate('agent-1', 'old', 'abc123', RELEASES, 0)).toBeNull();
  });

  it('tells an Agent on an unsupported version, and never one on the newest', () => {
    expect(agentSupported('v9', 'v10', undefined)).toBeNull();
    expect(agentSupported('v9', 'v10', ' ')).toBeNull();
    expect(agentSupported('v9', 'v10', 'v8, v9 ,v7')).toBe(true);
    expect(agentSupported('v6', 'v10', 'v8,v9,v7')).toBe(false);
    // A list not yet updated for the newest release still supports it.
    expect(agentSupported('v10', 'v10', 'v8,v9,v7')).toBe(true);
  });
});
