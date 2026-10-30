/**
 * Campaign builder — screen 2 of 3: the ad (§40.7, §70).
 *
 * Placed before Partner selection because §70 binds a Partner's approval to a
 * specific creative version and its content hash: a request cannot name a
 * creative that does not exist yet.
 *
 * Once an ad is ready the screen leads with it and "Continue"; uploading
 * another version is still there, folded away, for the Buyer who wants one.
 */
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireContext } from '@/lib/nav-entry';
import { apiOptional } from '@/lib/api';
import { Shell } from '@/components/Shell';
import { Card, PageHeader, StatusBadge } from '@/components/ui';
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
      <PageHeader title={campaign.name} lead="Your ad" />
      <WizardSteps current={2} />

      {items.length === 0 ? (
        <Card>
          <CreativeUploadForm campaignId={id} landingUrl={campaign.landing_url} />
        </Card>
      ) : (
        <>
          <Card title="Your ad">
            <ul className="plain-list">
              {items.map((c) => (
                <li key={c.creative_version_id}>
                  Version {c.version} · {c.type === 'IMAGE' ? 'image' : 'card'}
                  {c.headline ? <span className="muted"> · {c.headline}</span> : null}{' '}
                  <StatusBadge status={c.status} />
                </li>
              ))}
            </ul>
            <div className="btn-row">
              {ready.length ? (
                <Link className="btn btn-primary" href={`/campaigns/${id}/audience`}>
                  Continue to Partners
                </Link>
              ) : (
                <span className="faint">Your ad is still being checked. Reload in a moment.</span>
              )}
            </div>
          </Card>

          <details className="more">
            <summary>Upload a new version</summary>
            <p className="faint small" style={{ marginTop: 0 }}>
              Partners approve one exact version, so a new one is reviewed again.
            </p>
            <CreativeUploadForm
              campaignId={id}
              landingUrl={campaign.landing_url}
              submitLabel="Save new version and continue"
            />
          </details>
        </>
      )}

      <p className="faint">
        <Link href="/campaigns">Save and finish later</Link>
      </p>
    </Shell>
  );
}
