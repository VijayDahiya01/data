/**
 * Buyer billing (§19, §50, §81, §102).
 *
 * Every figure here is computed from immutable FinancialEvents, not from a
 * running total someone can edit. §50: "every financial calculation should be
 * reproducible from immutable settlement inputs" — so the invoice preview is a
 * derivation, and the events it derives from are shown alongside it.
 */
import Link from 'next/link';
import { requireContext, can } from '@/lib/nav-entry';
import { apiOptional } from '@/lib/api';
import { Shell } from '@/components/Shell';
import { Card, Empty, Money, Notice, PageHeader, StatusBadge, dateOnly } from '@/components/ui';

interface CampaignRow {
  id: string;
  name: string;
  status: string;
  budget: { amount_minor: number; currency: string };
  start_at: string;
  end_at: string;
}

interface InvoicePreview {
  campaign_id?: string;
  currency?: string;
  media_amount_minor?: number;
  platform_fee_minor?: number;
  subtotal_minor?: number;
  tax?: { note?: string } | null;
  lines?: { description: string; amount_minor: number; quantity?: number }[];
}

export default async function BillingPage() {
  const ctx = await requireContext('/billing');

  if (!can(ctx, 'billing:manage') && !can(ctx, 'invoice:read')) {
    return (
      <Shell ctx={ctx}>
        <PageHeader title="Billing" lead="Invoices and settlement." />
        <Notice tone="warn">
          Billing needs the Buyer admin or finance role. Your active organization holds neither —
          switch organization in the sidebar if you have another.
        </Notice>
      </Shell>
    );
  }

  const list = await apiOptional<{ items: CampaignRow[] }>('/v1/campaigns');
  const billable = (list?.items ?? []).filter((c) => c.status !== 'DRAFT').slice(0, 6);

  const previews = await Promise.all(
    billable.map(async (c) => ({
      campaign: c,
      preview: await apiOptional<InvoicePreview>(`/v1/billing/invoices/preview/${c.id}`),
    })),
  );

  return (
    <Shell ctx={ctx}>
      <PageHeader
        title="Billing"
        lead="What each campaign has accrued, derived from immutable financial events."
      />

      {billable.length === 0 ? (
        <Card>
          <Empty>
            Nothing billable yet. <Link href="/campaigns/new">Run a campaign</Link> first.
          </Empty>
        </Card>
      ) : (
        previews.map(({ campaign, preview }) => {
          const currency = preview?.currency ?? campaign.budget?.currency ?? 'INR';

          return (
            <Card key={campaign.id} title={campaign.name}>
              <p className="muted" style={{ marginTop: 0 }}>
                <StatusBadge status={campaign.status} />{' '}
                <span className="faint">
                  {dateOnly(campaign.start_at)} – {dateOnly(campaign.end_at)}
                </span>
              </p>

              {!preview ? (
                <Empty>Nothing has accrued on this campaign yet.</Empty>
              ) : (
                <>
                  <div className="table-wrap">
                    <table>
                      <tbody>
                        <tr>
                          <th>Media</th>
                          <td>
                            <Money minor={preview.media_amount_minor} currency={currency} />
                          </td>
                        </tr>
                        <tr>
                          <th>Platform fee</th>
                          <td>
                            <Money minor={preview.platform_fee_minor} currency={currency} />
                          </td>
                        </tr>
                        <tr>
                          <th>Subtotal</th>
                          <td>
                            <strong>
                              <Money minor={preview.subtotal_minor} currency={currency} />
                            </strong>
                          </td>
                        </tr>
                        <tr>
                          <th>Tax</th>
                          <td className="muted">
                            {preview.tax?.note ??
                              'Configured per jurisdiction and not assumed here.'}
                          </td>
                        </tr>
                      </tbody>
                    </table>
                  </div>

                  {preview.lines?.length ? (
                    <details style={{ marginTop: '0.9rem' }}>
                      <summary style={{ cursor: 'pointer' }} className="muted">
                        The {preview.lines.length} lines behind this
                      </summary>
                      <div className="table-wrap" style={{ marginTop: '0.6rem' }}>
                        <table>
                          <thead>
                            <tr>
                              <th>Description</th>
                              <th>Quantity</th>
                              <th>Amount</th>
                            </tr>
                          </thead>
                          <tbody>
                            {preview.lines.map((l, i) => (
                              <tr key={`${l.description}-${i}`}>
                                <td>{l.description}</td>
                                <td className="muted">{l.quantity ?? '—'}</td>
                                <td>
                                  <Money minor={l.amount_minor} currency={currency} />
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </details>
                  ) : null}
                </>
              )}

              <div className="btn-row">
                <Link className="btn" href={`/campaigns/${campaign.id}`}>
                  Open campaign
                </Link>
              </div>
            </Card>
          );
        })
      )}

      <Notice tone="plain">
        You are billed on outcomes a Partner delivered and your own CRM verified — never on
        unverified clicks. A dispute holds the related Partner payout until it resolves, and any
        correction is appended as a new event rather than editing history.
      </Notice>
    </Shell>
  );
}
