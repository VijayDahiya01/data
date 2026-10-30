/**
 * Data Partner home (§34, §37).
 *
 * Until a Partner is ready for campaigns, the page leads with what is left to
 * do, in plain words, each linked to where it is done. §37 makes readiness
 * DERIVED, not declared -- a Partner cannot be marked ready while its Agent has
 * never checked in -- so this list is the honest answer to "why can't Buyers
 * see us yet", and it disappears once there is nothing on it.
 *
 * After that the page is about what needs the Partner: requests to decide.
 */
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { requireContext } from '@/lib/nav-entry';
import { isPartner } from '@/lib/context';
import { apiOptional } from '@/lib/api';
import { Shell } from '@/components/Shell';
import { Card, Empty, PageHeader, relative } from '@/components/ui';

interface Readiness {
  readiness: string;
  checks: { step: string; complete: boolean; detail?: string }[];
  blocking: string[];
}

interface QueueItem {
  request_id: string;
  campaign_name: string;
  buyer_name: string;
  expires_at: string | null;
  status: string;
}

interface AgentRow {
  id: string;
  status: string;
  last_heartbeat_at: string | null;
}

/** Each readiness step (partner-profile.service.ts), as a thing to do and where. */
const STEPS: Record<string, { todo: string; done: string; href?: string }> = {
  business_verified: {
    todo: 'Oolix verifies your business — we email you when it is done',
    done: 'Business verified',
  },
  profile: {
    todo: 'Fill in your company profile',
    done: 'Company profile',
    href: '/partner/policies',
  },
  policy: {
    todo: 'Set the rules for which ads you accept',
    done: 'Ad rules set',
    href: '/partner/policies',
  },
  agent_registered: {
    todo: 'Connect your data',
    done: 'Data connected',
    href: '/partner/integrations',
  },
  agent_heartbeat: {
    todo: 'Start the Agent on your server',
    done: 'Agent running',
    href: '/partner/integrations',
  },
  audience_published: {
    todo: 'Publish what Buyers can ask you about',
    done: 'Published what Buyers can ask',
    href: '/partner/capabilities',
  },
  placement_active: {
    todo: 'Add a place on your site or app where ads can show',
    done: 'Ad slot added',
    href: '/partner/placements',
  },
};

export default async function PartnerHomePage() {
  const ctx = await requireContext('/partner');
  // A Buyer-only organization has no Partner side to show.
  if (!isPartner(ctx)) redirect('/dashboard');

  const [readiness, queue, agents] = await Promise.all([
    apiOptional<Readiness>('/v1/partner/readiness'),
    apiOptional<{ items: QueueItem[] }>('/v1/partner-requests'),
    apiOptional<{ items: AgentRow[] }>('/v1/partner/agents'),
  ]);

  const pending = queue?.items ?? [];
  const live = (agents?.items ?? []).filter((a) => a.status === 'ACTIVE');
  const lastHeard = live
    .map((a) => a.last_heartbeat_at)
    .filter((t): t is string => Boolean(t))
    .sort()
    .at(-1);
  const settingUp = readiness && readiness.readiness !== 'READY_FOR_CAMPAIGNS';

  return (
    <Shell ctx={ctx}>
      <PageHeader
        title={ctx.active_organization?.name ?? 'Partner'}
        actions={
          pending.length ? (
            <Link className="btn btn-primary" href="/partner/requests">
              Review {pending.length} request{pending.length === 1 ? '' : 's'}
            </Link>
          ) : null
        }
      />

      {settingUp ? (
        <Card title="Finish setting up">
          <ul className="plain-list">
            {readiness.checks.map((c) => {
              const step = STEPS[c.step] ?? { todo: c.step, done: c.step };
              return (
                <li key={c.step} className={c.complete ? 'muted' : undefined}>
                  {c.complete ? '✓ ' : '○ '}
                  {c.complete ? (
                    step.done
                  ) : step.href ? (
                    <Link href={step.href}>{step.todo}</Link>
                  ) : (
                    step.todo
                  )}
                </li>
              );
            })}
          </ul>
          <p className="faint small" style={{ marginBottom: 0 }}>
            Buyers can find you once every step is done.
          </p>
        </Card>
      ) : null}

      <Card title="Needs your decision">
        {pending.length === 0 ? (
          <Empty>Nothing to decide right now.</Empty>
        ) : (
          <ul className="plain-list">
            {pending.slice(0, 6).map((r) => (
              <li key={r.request_id} className="with-action">
                <span>
                  <Link href={`/partner/requests/${r.request_id}`}>{r.campaign_name}</Link>{' '}
                  <span className="muted">
                    · {r.buyer_name}
                    {r.expires_at ? ` · decide ${relative(r.expires_at)}` : ''}
                  </span>
                </span>
                <Link className="btn btn-primary btn-sm" href={`/partner/requests/${r.request_id}`}>
                  Review
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <p className="faint">
        {live.length > 0 ? (
          <>Your Agent is running{lastHeard ? `, last heard from ${relative(lastHeard)}` : ''}. </>
        ) : (
          <>
            No Agent is running. <Link href="/partner/integrations">Connect your data</Link>.{' '}
          </>
        )}
        You can pause any campaign at any time, under{' '}
        <Link href="/partner/activations">Campaigns → Running</Link>.
      </p>
    </Shell>
  );
}
