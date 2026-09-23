/**
 * New campaign — steps 1, 2 and 8 (§40).
 *
 * §36 step 4 requires a brand profile before a campaign can name one, so this
 * screen offers to create one rather than dead-ending a Buyer who has not made
 * one yet.
 */
import Link from 'next/link';
import { requireContext } from '@/lib/nav-entry';
import { apiOptional } from '@/lib/api';
import { Shell } from '@/components/Shell';
import { Card, Notice, PageHeader } from '@/components/ui';
import { CampaignBasicsForm, type BrandOption } from '@/components/CampaignBasicsForm';
import { BrandForm } from '@/components/BrandForm';
import { WizardSteps } from '@/components/WizardSteps';

export default async function NewCampaignPage() {
  const ctx = await requireContext('/campaigns/new');
  const brands = await apiOptional<{ items: BrandOption[] }>('/v1/brands');
  const items = brands?.items ?? [];

  const canSubmitLater = ctx.active_organization?.can_submit_campaigns ?? false;

  return (
    <Shell ctx={ctx}>
      <PageHeader
        title="New campaign"
        lead="Every Data Partner you select reviews and approves independently. Nothing runs until they do."
      />

      <WizardSteps current={1} />

      {!canSubmitLater ? (
        <Notice tone="warn">
          You can build this campaign now, but submitting it needs business verification to finish
          first.
        </Notice>
      ) : null}

      {items.length === 0 ? (
        <Card title="First, add a brand">
          <p className="muted" style={{ marginTop: 0 }}>
            A campaign runs under a brand, and the Partner reviewing it is told which one. The
            landing domain you set here is the only domain your campaign links may point at.
          </p>
          <BrandForm />
        </Card>
      ) : (
        <Card>
          <CampaignBasicsForm brands={items} />
        </Card>
      )}

      {items.length > 0 ? (
        <p className="faint">
          Need another brand? <Link href="/connections">Manage brands and connections</Link>.
        </p>
      ) : null}
    </Shell>
  );
}
