/**
 * Agent updates (docs/DEPLOY-PARTNER-AGENT.md, "Updates"): which Agents are
 * offered the release the Partner Connect bundle runs, and where it is
 * published. What makes a release safe to install is its signature, which
 * every Agent checks with the key built into it; these only decide who is
 * offered it, and when.
 */
import { createHash } from 'node:crypto';

export interface AgentUpdate {
  version: string;
  url: string;
}

/**
 * Whether an Agent is in a rollout's share: the same answer for every
 * heartbeat during one release, and a fresh draw for the next, so the same
 * Agents are not always first.
 */
export function inRollout(agentId: string, version: string, percent: number): boolean {
  if (percent >= 100) return true;
  if (percent <= 0) return false;
  const h = createHash('sha256').update(`${agentId}:${version}`).digest();
  return h.readUInt32BE(0) % 100 < percent;
}

/**
 * The release offered to one Agent: the bundle's version, published under
 * the release URL, once the rollout has reached the Agent -- and none to an
 * Agent already running it.
 */
export function agentUpdate(
  agentId: string,
  running: string,
  latest: string | null,
  releaseUrl: string | undefined,
  percent: number,
): AgentUpdate | null {
  if (!latest || !releaseUrl || running === latest || !inRollout(agentId, latest, percent)) {
    return null;
  }
  const url = releaseUrl.includes('{version}')
    ? releaseUrl.replaceAll('{version}', encodeURIComponent(latest))
    : `${releaseUrl.replace(/\/+$/, '')}/${encodeURIComponent(latest)}/`;
  return { version: latest, url };
}

/**
 * Whether Oolix supports an Agent version: one of the listed, or the newest.
 * Null when no list is set, and no version is called unsupported.
 */
export function agentSupported(
  running: string,
  latest: string | null,
  supported?: string,
): boolean | null {
  const list = (supported ?? '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
  if (list.length === 0) return null;
  return list.includes(running) || running === latest;
}
