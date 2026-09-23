/**
 * Partner payouts (§50, §76, §83.1, §102).
 *
 * Every payout is shown with the financial events it was built from, because
 * §50 requires "every financial calculation reproducible from immutable
 * settlement inputs" — a Partner should not have to take the figure on trust.
 *
 * §83.1: corrections APPEND an adjustment event and never rewrite history. So a
 * disputed and re-settled payout shows both the original accrual and the
 * adjustment, not one quietly-edited number.
 */
import { requireContext, can } from '@/lib/nav-entry';
import { apiOptional } from '@/lib/api';
import { Shell } from '@/components/Shell';
import { Card, Empty, Money, Notice, PageHeader, StatusBadge, dateOnly } from '@/components/ui';
import { DisputeForm, PayoutAdvanceForm, ResolveDisputeForm } from '@/components/PayoutForms';

interface FinancialEvent {
  type: string;
  amount_minor: number;
  currency?: string;
  created_at?: string;
  source_ref?: string;
}

interface Payout {
  payout_id: string;
  activation_id: string;
  buyer: string;
  campaign: string;
  status: string;
  eligible_amount_minor: number;
  adjustment_minor: number;
  net_payable_minor: number;
  currency: string;
  period: { start: string; end: string };
  dispute_reason?: string | null;
  financial_events?: FinancialEvent[];
}

/** §76's payout states, in order, so a reader can see where each one sits. */
const LIFECYCLE = ['CALCULATED', 'REVIEWED', 'APPROVED', 'PAID'];

export default async function PartnerPayoutsPage() {
  const ctx = await requireContext('/partner/payouts');
  const data = await apiOptional<{ items: Payout[] }>('/v1/billing/payouts');
  const items = data?.items ?? [];

  const mayApprove = can(ctx, 'payout:approve');
  const mayResolve = can(ctx, 'reconciliation:manage');

  const settled = items
    .filter((p) => p.status === 'PAID')
    .reduce((s, p) => s + Number(p.net_payable_minor), 0);
  const pending = items
    .filter((p) => p.status !== 'PAID' && p.status !== 'DISPUTED')
    .reduce((s, p) => s + Number(p.net_payable_minor), 0);
  const disputed = items.filter((p) => p.status === 'DISPUTED');

  const currency = items[0]?.currency ?? 'INR';

  return (
    <Shell ctx={ctx}>
      <PageHeader
        title="Payouts"
        lead="What you have earned, which events produced each figure, and where each one sits in the settlement process."
      />

      <div className="grid" style={{ marginBottom: '1.4rem' }}>
        <div className="stat">
          <div className="stat-label">Paid</div>
          <div className="stat-value">
            <Money minor={settled} currency={currency} />
          </div>
        </div>
        <div className="stat">
          <div className="stat-label">In progress</div>
          <div className="stat-value">
            <Money minor={pending} currency={currency} />
          </div>
          <div className="stat-note">Calculated, reviewed or approved</div>
        </div>
        <div className="stat">
          <div className="stat-label">Disputed</div>
          <div className="stat-value">{disputed.length}</div>
          <div className="stat-note">Held until resolved</div>
        </div>
      </div>

      {items.length === 0 ? (
        <Card>
          <Empty>
            No payouts yet. They appear once an activation has delivered verified outcomes.
          </Empty>
        </Card>
      ) : (
        items.map((p) => {
          const stageIndex = LIFECYCLE.indexOf(p.status);

          return (
            <Card key={p.payout_id} title={p.campaign}>
              <p className="muted" style={{ marginTop: 0 }}>
                {p.buyer} · <StatusBadge status={p.status} />{' '}
                <span className="faint">
                  {dateOnly(p.period.start)} – {dateOnly(p.period.end)}
                </span>
              </p>

              {/* §76's path, so it is obvious what has happened and what is next. */}
              <ol className="steps" style={{ marginBottom: '1rem' }}>
                {LIFECYCLE.map((stage, i) => (
                  <li key={stage}>
                    <span
                      className={
                        p.status === stage
                          ? 'step step-current'
                          : stageIndex > i
                            ? 'step step-done'
                            : 'step'
                      }
                    >
                      {stage.toLowerCase()}
                    </span>
                  </li>
                ))}
                {p.status === 'DISPUTED' ? (
                  <li>
                    <span className="step" style={{ color: 'var(--danger)' }}>
                      disputed
                    </span>
                  </li>
                ) : null}
              </ol>

              <div className="table-wrap">
                <table>
                  <tbody>
                    <tr>
                      <th>Eligible</th>
                      <td>
                        <Money minor={p.eligible_amount_minor} currency={p.currency} />
                      </td>
                    </tr>
                    {p.adjustment_minor ? (
                      <tr>
                        <th>Adjustment</th>
                        <td>
                          <Money minor={p.adjustment_minor} currency={p.currency} />
                          <div className="field-hint">
                            Appended as its own event. The original accrual is untouched.
                          </div>
                        </td>
                      </tr>
                    ) : null}
                    <tr>
                      <th>Net payable</th>
                      <td>
                        <strong>
                          <Money minor={p.net_payable_minor} currency={p.currency} />
                        </strong>
                      </td>
                    </tr>
                    {p.dispute_reason ? (
                      <tr>
                        <th>Dispute</th>
                        <td className="muted">{p.dispute_reason}</td>
                      </tr>
                    ) : null}
                  </tbody>
                </table>
              </div>

              {p.financial_events?.length ? (
                <details style={{ marginTop: '0.9rem' }}>
                  <summary style={{ cursor: 'pointer' }} className="muted">
                    The {p.financial_events.length} events this figure was built from
                  </summary>
                  <div className="table-wrap" style={{ marginTop: '0.6rem' }}>
                    <table>
                      <thead>
                        <tr>
                          <th>Event</th>
                          <th>Amount</th>
                          <th>Source</th>
                        </tr>
                      </thead>
                      <tbody>
                        {p.financial_events.map((e, i) => (
                          <tr key={`${e.type}-${i}`}>
                            <td>{e.type.replaceAll('_', ' ').toLowerCase()}</td>
                            <td>
                              <Money minor={e.amount_minor} currency={e.currency ?? p.currency} />
                            </td>
                            <td className="faint">{e.source_ref ?? '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </details>
              ) : null}

              <div
                style={{
                  marginTop: '1rem',
                  paddingTop: '0.9rem',
                  borderTop: '1px solid var(--border)',
                }}
              >
                <PayoutAdvanceForm
                  payoutId={p.payout_id}
                  status={p.status}
                  mayApprove={mayApprove}
                />
              </div>

              {p.status === 'DISPUTED' && mayResolve ? (
                <details style={{ marginTop: '0.9rem' }}>
                  <summary style={{ cursor: 'pointer' }} className="muted">
                    Resolve this dispute
                  </summary>
                  <div style={{ marginTop: '0.75rem' }}>
                    <ResolveDisputeForm payoutId={p.payout_id} />
                  </div>
                </details>
              ) : null}

              {p.status !== 'DISPUTED' && p.status !== 'PAID' ? (
                <details style={{ marginTop: '0.6rem' }}>
                  <summary style={{ cursor: 'pointer' }} className="muted">
                    Something look wrong? Raise a dispute
                  </summary>
                  <div style={{ marginTop: '0.75rem' }}>
                    <DisputeForm payoutId={p.payout_id} />
                  </div>
                </details>
              ) : null}
            </Card>
          );
        })
      )}

      <Notice tone="plain">
        You are paid on outcomes the Buyer&rsquo;s CRM verified, never on unverified clicks. If
        reconciliation finds a difference beyond tolerance it raises a review — it does not silently
        change what you are owed.
      </Notice>
    </Shell>
  );
}
