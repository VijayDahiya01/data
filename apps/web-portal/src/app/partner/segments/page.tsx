/**
 * Partner audience segments (§38.1, §72).
 *
 * The column that matters most here is the one that is absent. §38.1 sends
 * Oolix METADATA ONLY — no membership list ever leaves the Partner — and §72
 * publishes a reach BUCKET rather than a count, so repeated refreshes cannot be
 * differenced back into individual membership changes.
 */
import { requireContext } from '@/lib/nav-entry';
import { apiOptional } from '@/lib/api';
import { Shell } from '@/components/Shell';
import { Card, Empty, Notice, PageHeader, Reach, StatusBadge, relative } from '@/components/ui';
import { SegmentForm } from '@/components/SegmentForm';
import { FreshnessForm, PublishForm } from '@/components/SegmentLifecycleForms';
import { can } from '@/lib/nav-entry';

interface Segment {
  segment_id: string;
  internal_segment_id: string;
  display_name: string;
  description: string;
  category: string;
  geographies: string[];
  reach_bucket: string | null;
  freshness_at: string | null;
  refresh_frequency: string;
  consent_eligibility: string;
  allowed_channels: string[];
  allowed_categories?: string[];
  blocked_categories?: string[];
  status: string;
  version: number;
}

export default async function PartnerSegmentsPage() {
  const ctx = await requireContext('/partner/segments');
  const data = await apiOptional<{ items: Segment[] }>('/v1/partner/segments');
  const items = data?.items ?? [];

  const mayManage = can(ctx, 'segment:manage');
  const mayPublish = can(ctx, 'segment:publish');

  return (
    <Shell ctx={ctx}>
      <PageHeader
        title="Audience segments"
        lead="What Buyers can discover about your audiences — and nothing more."
      />

      <Notice tone="plain">
        <strong>The audience itself is not built here.</strong> You build it in your own systems —
        Oolix only ever holds the description below, and your Agent resolves who is actually in it,
        inside your infrastructure, at the moment an ad is decided.
      </Notice>

      {mayManage ? (
        <details className="card">
          <summary style={{ cursor: 'pointer', fontWeight: 550 }}>Publish a new segment</summary>
          <div style={{ marginTop: '1rem' }}>
            <SegmentForm />
          </div>
        </details>
      ) : (
        <Notice tone="warn">
          Your role can view segments but not publish them. A Partner admin can.
        </Notice>
      )}

      {items.length === 0 ? (
        <Card>
          <Empty>No segments yet.</Empty>
        </Card>
      ) : (
        items.map((s) => (
          <Card key={s.segment_id} title={s.display_name}>
            <p className="muted" style={{ marginTop: 0 }}>
              {s.description}
            </p>
            <div className="table-wrap">
              <table>
                <tbody>
                  <tr>
                    <th>Status</th>
                    <td>
                      <StatusBadge status={s.status} /> <span className="faint">v{s.version}</span>
                    </td>
                  </tr>
                  <tr>
                    <th>Your key</th>
                    <td>
                      <code>{s.internal_segment_id}</code>
                      <div className="field-hint">
                        Oolix passes this back inside a signed manifest. It only ever means
                        something inside your systems.
                      </div>
                    </td>
                  </tr>
                  <tr>
                    <th>Published reach</th>
                    <td>
                      <Reach bucket={s.reach_bucket} />
                      <div className="field-hint">
                        A bucket, not a count. Republication is rate-limited so a Buyer cannot
                        difference refreshes into an exact size.
                      </div>
                    </td>
                  </tr>
                  <tr>
                    <th>Freshness</th>
                    <td className="muted">
                      {s.freshness_at ? relative(s.freshness_at) : 'never refreshed'}{' '}
                      <span className="faint">· expected {s.refresh_frequency}</span>
                    </td>
                  </tr>
                  <tr>
                    <th>Consent</th>
                    <td>
                      <StatusBadge status={s.consent_eligibility} />
                    </td>
                  </tr>
                  <tr>
                    <th>Channels you allow</th>
                    <td className="muted">
                      {s.allowed_channels
                        .map((c) => c.replaceAll('_', ' ').toLowerCase())
                        .join(', ')}
                    </td>
                  </tr>
                  {s.blocked_categories?.length ? (
                    <tr>
                      <th>Blocked categories</th>
                      <td className="muted">{s.blocked_categories.join(', ')}</td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>

            {mayManage || mayPublish ? (
              <div
                style={{
                  marginTop: '1rem',
                  paddingTop: '0.9rem',
                  borderTop: '1px solid var(--border)',
                  display: 'flex',
                  gap: '1.5rem',
                  flexWrap: 'wrap',
                  alignItems: 'flex-end',
                }}
              >
                {mayManage ? <FreshnessForm segmentId={s.segment_id} /> : null}
                {mayPublish ? (
                  <PublishForm segmentId={s.segment_id} published={s.status === 'PUBLISHED'} />
                ) : null}
              </div>
            ) : null}
          </Card>
        ))
      )}
    </Shell>
  );
}
