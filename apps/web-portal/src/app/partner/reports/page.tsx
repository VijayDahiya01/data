/**
 * Partner delivery, revenue and reconciliation (§49, §67, §77.3).
 *
 * §67 scopes this to the caller's own organization — there is deliberately no
 * parameter that could address another Partner's data, which is why the whole
 * screen takes no id.
 *
 * Delivery and outcomes are shown side by side but never merged. §49 keeps them
 * apart because they are verified by different parties: a Partner counts an
 * impression, a Buyer's CRM confirms a qualified lead, and a Partner is paid on
 * the second (§50).
 */
import { requireContext, can } from '@/lib/nav-entry';
import { apiOptional } from '@/lib/api';
import { Shell } from '@/components/Shell';
import { Card, Empty, Money, Notice, PageHeader, StatusBadge } from '@/components/ui';
import { ReconcileForm } from '@/components/OpsForms';

interface Row {
  activation_id: string;
  buyer_name: string;
  campaign_name: string;
  channel: string;
  status: string;
  approved_allocation_minor: number;
  delivery: { impressions: number; clicks: number };
  outcomes: {
    received: number;
    valid: number;
    qualified: number;
    converted: number;
    rejected: number;
  };
  revenue: {
    pricing_model: string;
    unit_price_minor: number;
    accrued_minor: number;
    currency: string;
  };
}

export default async function PartnerReportsPage() {
  const ctx = await requireContext('/partner/reports');
  const data = await apiOptional<{ items: Row[] }>('/v1/reports/partner');
  const rows = data?.items ?? [];

  const mayReconcile = can(ctx, 'reconciliation:manage');
  const currency = rows[0]?.revenue?.currency ?? 'INR';

  const totals = rows.reduce(
    (acc, r) => ({
      impressions: acc.impressions + (r.delivery?.impressions ?? 0),
      clicks: acc.clicks + (r.delivery?.clicks ?? 0),
      qualified: acc.qualified + (r.outcomes?.qualified ?? 0),
      accrued: acc.accrued + Number(r.revenue?.accrued_minor ?? 0),
    }),
    { impressions: 0, clicks: 0, qualified: 0, accrued: 0 },
  );

  return (
    <Shell ctx={ctx}>
      <PageHeader
        title="Reports"
        lead="What you delivered, what the Buyer verified, and what you earned."
      />

      <div className="grid" style={{ marginBottom: '1.4rem' }}>
        <div className="stat">
          <div className="stat-label">Impressions</div>
          <div className="stat-value">{totals.impressions.toLocaleString()}</div>
          <div className="stat-note">Counted by your Agent</div>
        </div>
        <div className="stat">
          <div className="stat-label">Clicks</div>
          <div className="stat-value">{totals.clicks.toLocaleString()}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Qualified leads</div>
          <div className="stat-value">{totals.qualified.toLocaleString()}</div>
          <div className="stat-note">Confirmed by the Buyer&rsquo;s CRM</div>
        </div>
        <div className="stat">
          <div className="stat-label">Accrued</div>
          <div className="stat-value">
            <Money minor={totals.accrued} currency={currency} />
          </div>
          <div className="stat-note">On verified outcomes only</div>
        </div>
      </div>

      <Card title={`Activations (${rows.length})`}>
        {rows.length === 0 ? (
          <Empty>Nothing has run yet.</Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Campaign</th>
                  <th>Buyer</th>
                  <th>Channel</th>
                  <th>Status</th>
                  <th>Impressions</th>
                  <th>Clicks</th>
                  <th>Qualified</th>
                  <th>Accrued</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.activation_id}>
                    <td>{r.campaign_name}</td>
                    <td className="muted">{r.buyer_name}</td>
                    <td className="muted">{r.channel.replaceAll('_', ' ').toLowerCase()}</td>
                    <td>
                      <StatusBadge status={r.status} />
                    </td>
                    <td style={{ fontVariantNumeric: 'tabular-nums' }}>
                      {r.delivery?.impressions ?? 0}
                    </td>
                    <td style={{ fontVariantNumeric: 'tabular-nums' }}>
                      {r.delivery?.clicks ?? 0}
                    </td>
                    <td style={{ fontVariantNumeric: 'tabular-nums' }}>
                      {r.outcomes?.qualified ?? 0}
                    </td>
                    <td>
                      <Money minor={r.revenue?.accrued_minor} currency={r.revenue?.currency} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {mayReconcile && rows.length > 0 ? (
        <Card title="Reconcile your counts against ours">
          <p className="muted" style={{ marginTop: 0 }}>
            Compare what your Agent recorded against what Oolix received. A difference beyond
            tolerance raises a review — it never silently changes what you are owed.
          </p>
          {rows.slice(0, 5).map((r) => (
            <details key={r.activation_id} style={{ marginBottom: '0.6rem' }}>
              <summary style={{ cursor: 'pointer' }} className="muted">
                {r.campaign_name} <span className="faint">· {r.channel.toLowerCase()}</span>
              </summary>
              <div style={{ marginTop: '0.75rem' }}>
                <ReconcileForm activationId={r.activation_id} />
              </div>
            </details>
          ))}
        </Card>
      ) : null}

      <Notice tone="plain">
        These figures are yours alone. There is no view here — or anywhere — that would show you
        another Data Partner&rsquo;s, and no way to ask for one.
      </Notice>
    </Shell>
  );
}
