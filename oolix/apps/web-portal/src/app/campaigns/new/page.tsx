/**
 * New campaign — screen 1 of 3 (§40; v6 §9 steps 1-3 and 9).
 *
 * §36 step 4 requires a brand profile before a campaign can name one, so this
 * screen offers to create one rather than dead-ending a Buyer who has not made
 * one yet.
 *
 * `?audience=` arrives from an audience's "Use in a campaign" and preselects
 * it, so a Buyer who started from who they want to reach does not pick it
 * twice.
 */
import { requireContext } from '@/lib/nav-entry';
import { apiOptional } from '@/lib/api';
import { Shell } from '@/components/Shell';
import { Card, Notice, PageHeader } from '@/components/ui';
import {
  CampaignBasicsForm,
  type AudienceOption,
  type BrandOption,
} from '@/components/CampaignBasicsForm';
import { BrandForm } from '@/components/BrandForm';
import { WizardSteps } from '@/components/WizardSteps';

export default async function NewCampaignPage({
  searchParams,
}: {
  searchParams: Promise<{ audience?: string | string[] }>;
}) {
  const ctx = await requireContext('/campaigns/new');
  const { audience } = await searchParams;
  const [brands, audiences] = await Promise.all([
    apiOptional<{ items: BrandOption[] }>('/v1/brands'),
    apiOptional<{ items: (AudienceOption & { status: string })[] }>('/v1/audiences'),
  ]);
  const items = brands?.items ?? [];
  // Only a finished audience can be linked: a draft has no version to freeze.
  const ready = (audiences?.items ?? []).filter((a) => a.status === 'READY');
  const chosen = typeof audience === 'string' && ready.some((a) => a.id === audience);

  const canSubmitLater = ctx.active_organization?.can_submit_campaigns ?? false;

  return (
    <Shell ctx={ctx}>
      <PageHeader title="New campaign" />

      <WizardSteps current={1} />

      {!canSubmitLater ? (
        <Notice tone="warn">
          You can build this campaign now. Submitting it waits until your business is verified.
        </Notice>
      ) : null}

      {items.length === 0 ? (
        <Card title="First, add a brand">
          <p className="muted" style={{ marginTop: 0 }}>
            A campaign runs under a brand, and the Partner reviewing it sees which one. Your links
            may only point at the landing domain you set here.
          </p>
          <BrandForm />
        </Card>
      ) : (
        <Card>
          <CampaignBasicsForm
            brands={items}
            audiences={ready.map((a) => ({ id: a.id, name: a.name }))}
            audienceId={chosen ? (audience as string) : undefined}
          />
        </Card>
      )}
    </Shell>
  );
}
