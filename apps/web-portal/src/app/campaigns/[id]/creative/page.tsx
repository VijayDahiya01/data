/**
 * Campaign builder — step 7 (§40.7, §70).
 *
 * Placed before Partner selection because §70 binds a Partner's approval to a
 * specific creative version and its content hash: a request cannot name a
 * creative that does not exist yet.
 */
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireContext } from '@/lib/nav-entry';
import { apiOptional } from '@/lib/api';
import { Shell } from '@/components/Shell';
import { Card, Empty, Notice, PageHeader, StatusBadge } from '@/components/ui';
import { WizardSteps } from '@/components/WizardSteps';
import { CreativeUploadForm } from '@/components/CreativeUploadForm';

interface CreativeVersion {
  creative_version_id: string;
  version: number;
  type: string;
  status: string;
  headline?: string;
}

interface Campaign {
  id: string;
  name: string;
  status: string;
  landing_url?: string;
}

export default async function CreativeStepPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireContext(`/campaigns/${id}/creative`);

  const campaign = await apiOptional<Campaign>(`/v1/campaigns/${id}`);
  if (!campaign) notFound();

  const creatives = await apiOptional<{ items: CreativeVersion[] }>(
    `/v1/creatives?campaign_id=${id}`,
  );
  const items = creatives?.items ?? [];
  const ready = items.filter((c) => c.status === 'READY');

  return (
    <Shell ctx={ctx}>
      <PageHeader title={campaign.name} lead="Step 7 · Creative" />
      <WizardSteps current={2} />

      <Card title="Upload a creative version">
        <CreativeUploadForm campaignId={id} landingUrl={campaign.landing_url} />
      </Card>

      <Card title={`Versions (${items.length})`}>
        {items.length === 0 ? (
          <Empty>Nothing uploaded yet. A Partner request needs at least one ready version.</Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Version</th>
                  <th>Format</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {items.map((c) => (
                  <tr key={c.creative_version_id}>
                    <td>v{c.version}</td>
                    <td className="muted">{c.type.replaceAll('_', ' ').toLowerCase()}</td>
                    <td>
                      <StatusBadge status={c.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Notice tone="plain">
        Each upload is a new version, and a Partner approves a specific one. Replacing an image
        after approval does not change what runs on their property — it creates a version they have
        not agreed to.
      </Notice>

      <div className="btn-row">
        <Link
          className={ready.length ? 'btn btn-primary' : 'btn'}
          href={ready.length ? `/campaigns/${id}/audience` : `/campaigns/${id}/creative`}
          aria-disabled={ready.length === 0}
        >
          Continue to audiences
        </Link>
        {ready.length === 0 ? (
          <span className="faint">Upload at least one creative to continue.</span>
        ) : null}
      </div>
    </Shell>
  );
}
