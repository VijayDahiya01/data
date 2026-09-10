/**
 * Build an audience — v6 §6, §18.1.
 *
 * The attribute list comes from the Oolix taxonomy (§4), not from any Partner.
 * That is what makes this screen safe to show before a Buyer has any Partner
 * relationship at all: nothing here reveals what any particular Data Partner
 * holds, and nothing typed here reaches a Partner's database.
 */
import Link from 'next/link';
import { requireContext } from '@/lib/nav-entry';
import { apiOptional } from '@/lib/api';
import { Shell } from '@/components/Shell';
import { Card, Notice, PageHeader } from '@/components/ui';
import { AudienceBuilder, type TaxonomyAttribute } from '@/components/AudienceBuilder';
import { createAudience } from '@/lib/actions-audience';

export default async function NewAudiencePage() {
  const ctx = await requireContext('/audiences/new');
  const taxonomy = await apiOptional<{ items: TaxonomyAttribute[] }>('/v1/audiences/taxonomy');
  const attributes = taxonomy?.items ?? [];

  return (
    <Shell ctx={ctx}>
      <PageHeader
        title="New audience"
        lead="Pick the attributes that describe who you want to reach."
        actions={
          <Link className="btn-secondary" href="/audiences">
            Cancel
          </Link>
        }
      />

      {attributes.length === 0 ? (
        <Notice tone="danger">Conditions could not be loaded. Try again shortly.</Notice>
      ) : (
        <Card>
          <AudienceBuilder action={createAudience} attributes={attributes} />
        </Card>
      )}
    </Shell>
  );
}
