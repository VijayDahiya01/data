/**
 * Data Partner dashboard (§34, §37).
 *
 * Readiness is the first thing shown because §37 makes it DERIVED, not
 * declared: a Partner cannot be marked ready while its Agent has never checked
 * in. Showing the checklist means the answer to "why can't Buyers see my
 * audience yet" is on the page rather than in a support ticket.
 */
import Link from 'next/link';
import { requireContext } from '@/lib/nav-entry';
import { apiOptional } from '@/lib/api';
import { Shell } from '@/components/Shell';
import { Card, Empty, Notice, PageHeader, Stat, StatusBadge, relative } from '@/components/ui';

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
  version: string;
  status: string;
  last_heartbeat_at: string | null;
  config_age_seconds: number | null;
}

export default async function PartnerDashboardPage() {
  const ctx = await requireContext('/partner');

  const [readiness, queue, agents] = await Promise.all([
    apiOptional<Readiness>('/v1/partner/readiness'),
    apiOptional<{ items: QueueItem[] }>('/v1/partner-requests'),
    apiOptional<{ items: AgentRow[] }>('/v1/partner/agents'),
  ]);

  const pending = queue?.items ?? [];
  const agentList = agents?.items ?? [];
  const live = agentList.filter((a) => a.status === 'ACTIVE');

  return (
    <Shell ctx={ctx}>
      <PageHeader
        title={ctx.active_organization?.name ?? 'Partner'}
        lead="Your audience data never leaves your systems. Oolix sends signed instructions; your Agent decides locally."
        actions={
          pending.length ? (
            <Link className="btn btn-primary" href="/partner/requests">
              Review {pending.length} request{pending.length === 1 ? '' : 's'}
            </Link>
          ) : null
        }
      />

      <div className="grid" style={{ marginBottom: '1.5rem' }}>
        <Stat
          label="Readiness"
          value={<StatusBadge status={readiness?.readiness} />}
          note="Derived from observable facts"
        />
        <Stat label="Awaiting your decision" value={pending.length} note="7-day SLA each" />
        <Stat
          label="Agents online"
          value={`${live.length}/${agentList.length}`}
          note={live.length === 0 ? 'No Agent has checked in' : 'Heartbeat within 5 minutes'}
        />
      </div>

      {readiness && readiness.readiness !== 'READY_FOR_CAMPAIGNS' ? (
        <Card title="What is still needed">
          <ul style={{ margin: 0, paddingLeft: '1.1rem' }}>
            {readiness.checks.map((c) => (
              <li key={c.step} className={c.complete ? 'muted' : undefined}>
                {c.complete ? '✓' : '○'} {c.step.replaceAll('_', ' ').toLowerCase()}
                {c.detail ? <span className="faint"> — {c.detail}</span> : null}
              </li>
            ))}
          </ul>
          <p className="faint" style={{ marginBottom: 0 }}>
            Readiness is derived, not set by hand — so it cannot say ready while something is
            genuinely missing.
          </p>
        </Card>
      ) : null}

      <Card title="Requests awaiting your decision">
        {pending.length === 0 ? (
          <Empty>Nothing awaiting a decision right now.</Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Campaign</th>
                  <th>Buyer</th>
                  <th>Due</th>
                </tr>
              </thead>
              <tbody>
                {pending.slice(0, 6).map((r) => (
                  <tr key={r.request_id}>
                    <td>
                      <Link href={`/partner/requests/${r.request_id}`}>{r.campaign_name}</Link>
                    </td>
                    <td className="muted">{r.buyer_name}</td>
                    <td className="muted">{r.expires_at ? relative(r.expires_at) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Notice tone="plain">
        You can stop anything at any time. Kill switches are unilateral and immediate — no Buyer
        agreement, no Oolix approval, no notice period — and your Agent enforces them locally even
        if Oolix is unreachable.
      </Notice>
    </Shell>
  );
}
