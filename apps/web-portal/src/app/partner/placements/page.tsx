/**
 * Placements (§43).
 *
 * §43 gives the Partner unilateral control of where anything may appear, and
 * the fallback column is the part that protects their own product: when no ad
 * is served the slot shows house content, because "ad placement failure cannot
 * block checkout/booking/login".
 */
import { requireContext, can } from '@/lib/nav-entry';
import { apiOptional } from '@/lib/api';
import { Shell } from '@/components/Shell';
import { Card, Empty, Notice, PageHeader, StatusBadge } from '@/components/ui';
import { PlacementForm, PlacementStatusForm } from '@/components/OpsForms';

interface Placement {
  placement_id: string;
  placement_key: string;
  display_name: string;
  surface: string;
  format: string;
  dimensions?: { width: number; height: number } | null;
  context_tags?: string[];
  allowed_categories?: string[];
  blocked_categories?: string[];
  max_frequency_default?: number;
  fallback?: string;
  status: string;
}

export default async function PlacementsPage() {
  const ctx = await requireContext('/partner/placements');
  const data = await apiOptional<{ items: Placement[] }>('/v1/partner/placements');
  const items = data?.items ?? [];
  const mayManage = can(ctx, 'placement:manage');

  return (
    <Shell ctx={ctx}>
      <PageHeader
        title="Placements"
        lead="Where an approved campaign may appear on your property."
      />

      {items.length === 0 ? (
        <Card>
          <Empty>No placements yet.</Empty>
        </Card>
      ) : (
        <Card>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Placement</th>
                  <th>Surface</th>
                  <th>Format</th>
                  <th>Default cap</th>
                  <th>Fallback</th>
                  <th>Status</th>
                  {mayManage ? <th /> : null}
                </tr>
              </thead>
              <tbody>
                {items.map((p) => (
                  <tr key={p.placement_id}>
                    <td>
                      {p.display_name}
                      <div className="faint">
                        <code>{p.placement_key}</code>
                      </div>
                    </td>
                    <td className="muted">{p.surface}</td>
                    <td className="muted">
                      {p.format.replaceAll('_', ' ')}
                      {p.dimensions ? (
                        <div className="faint">
                          {p.dimensions.width}×{p.dimensions.height}
                        </div>
                      ) : null}
                    </td>
                    <td className="muted">{p.max_frequency_default ?? '—'}</td>
                    <td className="muted">
                      {p.fallback?.replaceAll('_', ' ').toLowerCase() ?? '—'}
                    </td>
                    <td>
                      <StatusBadge status={p.status} />
                    </td>
                    {mayManage ? (
                      <td>
                        <PlacementStatusForm placementId={p.placement_id} status={p.status} />
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {mayManage ? (
        <details className="card">
          <summary>Add a placement</summary>
          <div style={{ marginTop: '1rem' }}>
            <PlacementForm />
          </div>
        </details>
      ) : null}

      <Notice tone="plain">
        You can disable any placement at any time, without anyone&rsquo;s agreement. The placement
        key is what your Agent matches on locally, so a kill switch scoped to a placement works even
        while Oolix is unreachable.
      </Notice>
    </Shell>
  );
}
