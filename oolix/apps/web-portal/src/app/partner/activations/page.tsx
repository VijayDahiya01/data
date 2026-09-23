/**
 * Active activations and kill switches (§24, §6, §52.3).
 *
 * §6 and §24 give the Partner the right to stop anything, immediately, without
 * anyone's agreement. This screen makes that a button rather than a support
 * request — and says plainly that it takes effect locally, so it works while
 * Oolix is unreachable.
 */
import Link from 'next/link';
import { requireContext, can } from '@/lib/nav-entry';
import { apiOptional } from '@/lib/api';
import { Shell } from '@/components/Shell';
import { Card, Empty, Money, Notice, PageHeader, StatusBadge, dateTime } from '@/components/ui';
import { KillSwitchForm, ReleaseKillSwitchForm } from '@/components/KillSwitchForms';

interface QueueItem {
  request_id: string;
  campaign_name: string;
  buyer_name: string;
  status: string;
  targeting_source?: string;
  audience?: { name: string; audience_version: number | null } | null;
  channels: { channel: string; allocation_minor: number }[];
  /**
   * v6 §11: what this Partner's own Agent has compiled locally.
   *
   * Status, version and freshness. There is no member count here because Oolix
   * was never told one — the compiled audience never leaves the Partner.
   */
  activations?: {
    activation_id: string;
    channel: string;
    status: string;
    materialization: { status: string; version: number | null; built_at: string | null } | null;
  }[];
}

interface KillSwitch {
  id: string;
  scope: string;
  target_id: string | null;
  reason: string;
  active: boolean;
  activated_at: string;
}

export default async function ActivationsPage() {
  const ctx = await requireContext('/partner/activations');

  const [approved, switches] = await Promise.all([
    apiOptional<{ items: QueueItem[] }>('/v1/partner-requests?status=APPROVED'),
    apiOptional<{ items: KillSwitch[] }>('/v1/partner/kill-switches'),
  ]);

  const live = approved?.items ?? [];
  const active = (switches?.items ?? []).filter((k) => k.active);
  const mayOperate = can(ctx, 'killswitch:operate');

  return (
    <Shell ctx={ctx}>
      <PageHeader
        title="Active activations"
        lead="What is approved to run on your property, and how to stop it."
      />

      {active.length ? (
        <Notice tone="danger">
          {active.length} kill switch{active.length === 1 ? '' : 'es'} active. Serving is stopped
          within their scope.
        </Notice>
      ) : null}

      <Card title="Approved campaigns">
        <p className="faint small">
          <strong>Local audience</strong> is what your own Agent has compiled from the approved
          rules, and when. Oolix holds this status, version and timestamp — and nothing about who
          matched. The members live only in your database.
        </p>
        {live.length === 0 ? (
          <Empty>Nothing approved yet.</Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Campaign</th>
                  <th>Buyer</th>
                  <th>Targeting</th>
                  <th>Channels</th>
                  <th>Budget</th>
                  <th>Status</th>
                  <th>Local audience</th>
                </tr>
              </thead>
              <tbody>
                {live.map((r) => (
                  <tr key={r.request_id}>
                    <td>
                      <Link href={`/partner/requests/${r.request_id}`}>{r.campaign_name}</Link>
                    </td>
                    <td className="muted">{r.buyer_name}</td>
                    <td className="muted">
                      {r.audience ? (
                        <>
                          {r.audience.name}
                          <span className="faint"> · rules v{r.audience.audience_version}</span>
                        </>
                      ) : (
                        <span className="faint">prebuilt segment</span>
                      )}
                    </td>
                    <td className="muted">
                      {r.channels
                        .map((c) => c.channel.replaceAll('_', ' ').toLowerCase())
                        .join(', ')}
                    </td>
                    <td>
                      <Money
                        minor={r.channels.reduce((s, c) => s + Number(c.allocation_minor), 0)}
                      />
                    </td>
                    <td>
                      <StatusBadge status={r.status} />
                    </td>
                    <td>
                      {(r.activations ?? []).filter((a) => a.materialization).length === 0 ? (
                        <span className="faint">{r.audience ? 'not compiled yet' : 'n/a'}</span>
                      ) : (
                        (r.activations ?? [])
                          .filter((a) => a.materialization)
                          .map((a) => (
                            <div key={a.activation_id}>
                              <StatusBadge status={a.materialization!.status} />
                              <span className="faint">
                                {' '}
                                v{a.materialization!.version} ·{' '}
                                {dateTime(a.materialization!.built_at)}
                              </span>
                            </div>
                          ))
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {mayOperate ? (
        <Card title="Stop serving">
          <KillSwitchForm />
        </Card>
      ) : (
        <Notice tone="warn">
          Your role can view activations but not operate a kill switch. A Partner admin or security
          admin can.
        </Notice>
      )}

      <Card title={`Kill switches (${active.length} active)`}>
        {active.length === 0 ? (
          <Empty>None active.</Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Scope</th>
                  <th>Target</th>
                  <th>Reason</th>
                  <th>Since</th>
                  {mayOperate ? <th /> : null}
                </tr>
              </thead>
              <tbody>
                {active.map((k) => (
                  <tr key={k.id}>
                    <td>{k.scope.replaceAll('_', ' ').toLowerCase()}</td>
                    <td className="faint">{k.target_id ?? 'all'}</td>
                    <td className="muted">{k.reason}</td>
                    <td className="muted">{dateTime(k.activated_at)}</td>
                    {mayOperate ? (
                      <td>
                        <ReleaseKillSwitchForm killSwitchId={k.id} />
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Notice tone="plain">
        A kill switch is unilateral and immediate: no Buyer agreement, no Oolix approval, no notice
        period. Your Agent enforces it locally, so it holds even if Oolix is unreachable. Releasing
        one does not restart an activation that already ended.
      </Notice>
    </Shell>
  );
}
