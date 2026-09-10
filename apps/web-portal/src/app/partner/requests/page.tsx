/**
 * Partner review queue (§41, §101).
 *
 * Sorted by urgency rather than arrival: §101 gives each request a 7-day clock
 * whose expiry is neither approval nor rejection, so the thing a Partner most
 * needs to see is which decisions are about to lapse by default.
 */
import Link from 'next/link';
import { requireContext } from '@/lib/nav-entry';
import { apiOptional } from '@/lib/api';
import { Shell } from '@/components/Shell';
import {
  Card,
  Empty,
  Money,
  Notice,
  PageHeader,
  Reach,
  StatusBadge,
  relative,
} from '@/components/ui';

interface QueueItem {
  request_id: string;
  status: string;
  request_version: number;
  submitted_at: string;
  expires_at: string | null;
  days_remaining: number | null;
  buyer_name: string;
  brand_name: string | null;
  campaign_name: string;
  category: string;
  // v6 §19: exactly one of these. §18.2 asks the queue to name the audience
  // either way, so a Partner can triage without opening each request.
  segment: { display_name: string; reach_bucket: string | null } | null;
  audience?: { name: string; audience_version: number | null; reach_bucket: string | null } | null;
  channels: { channel: string; allocation_minor: number }[];
}

const TABS = [
  { key: '', label: 'Awaiting decision' },
  { key: 'APPROVED', label: 'Approved' },
  { key: 'CHANGE_REQUESTED', label: 'Change requested' },
  { key: 'REJECTED', label: 'Rejected' },
  { key: 'EXPIRED', label: 'Expired' },
];

const DECIDED: Record<string, string> = {
  approved:
    'Approved. Activations are being prepared and a signed manifest is on its way to your Agent.',
  rejected: 'Rejected. No activation was created.',
  change: 'Change requested. The Buyer must resubmit a new version before anything runs.',
};

export default async function PartnerRequestsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; decided?: string }>;
}) {
  const { status, decided } = await searchParams;
  const ctx = await requireContext('/partner/requests');

  const query = status ? `?status=${encodeURIComponent(status)}` : '';
  const data = await apiOptional<{ items: QueueItem[] }>(`/v1/partner-requests${query}`);
  const items = data?.items ?? [];

  // Soonest expiry first — those are the ones that lapse by default.
  const sorted = [...items].sort((a, b) => {
    const ax = a.expires_at ? Date.parse(a.expires_at) : Number.MAX_SAFE_INTEGER;
    const bx = b.expires_at ? Date.parse(b.expires_at) : Number.MAX_SAFE_INTEGER;
    return ax - bx;
  });

  return (
    <Shell ctx={ctx}>
      <PageHeader
        title="Campaign requests"
        lead="Each request is yours alone to decide. Nothing runs on your property until you approve it."
      />

      {decided && DECIDED[decided] ? <Notice tone="info">{DECIDED[decided]}</Notice> : null}

      <div className="steps" style={{ marginBottom: '1rem' }}>
        {TABS.map((t) => (
          <Link
            key={t.key || 'open'}
            className={`step ${(status ?? '') === t.key ? 'step-current' : ''}`}
            href={t.key ? `/partner/requests?status=${t.key}` : '/partner/requests'}
          >
            {t.label}
          </Link>
        ))}
      </div>

      <Card>
        {sorted.length === 0 ? (
          <Empty>
            {status
              ? 'Nothing in this state.'
              : 'No requests awaiting a decision. New ones appear here as Buyers submit them.'}
          </Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Campaign</th>
                  <th>Buyer</th>
                  <th>Segment</th>
                  <th>Reach</th>
                  <th>Budget</th>
                  <th>Status</th>
                  <th>Decision due</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((r) => {
                  const urgent = (r.days_remaining ?? 99) <= 2 && r.status === 'PARTNER_REVIEW';
                  return (
                    <tr key={r.request_id}>
                      <td>
                        <Link href={`/partner/requests/${r.request_id}`}>{r.campaign_name}</Link>
                        {r.request_version > 1 ? (
                          <span className="faint"> · v{r.request_version}</span>
                        ) : null}
                      </td>
                      <td className="muted">
                        {r.buyer_name}
                        {r.brand_name ? <div className="faint">{r.brand_name}</div> : null}
                      </td>
                      <td className="muted">
                        {r.segment?.display_name ?? r.audience?.name ?? '—'}
                        {r.audience ? (
                          <div className="faint small">rules v{r.audience.audience_version}</div>
                        ) : null}
                      </td>
                      <td>
                        <Reach bucket={r.segment?.reach_bucket ?? r.audience?.reach_bucket} />
                      </td>
                      <td>
                        <Money
                          minor={r.channels.reduce((s, c) => s + Number(c.allocation_minor), 0)}
                        />
                      </td>
                      <td>
                        <StatusBadge status={r.status} />
                      </td>
                      <td className={urgent ? 'badge badge-warn' : 'muted'}>
                        {r.expires_at ? relative(r.expires_at) : '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Notice tone="plain">
        If a request expires without a decision it becomes <strong>expired</strong> — not approved
        and not rejected. The Buyer may resubmit, and nothing runs in the meantime.
      </Notice>
    </Shell>
  );
}
