/**
 * Creative library (§70, §93).
 *
 * The capability exists in the API and is covered by tests; this screen is
 * what has not been built yet. Saying so explicitly beats a blank page.
 */
import { requireContext } from '@/lib/nav-entry';
import { Shell } from '@/components/Shell';
import { Placeholder } from '@/components/Placeholder';

export default async function Page() {
  const ctx = await requireContext('/creatives');

  return (
    <Shell ctx={ctx}>
      <Placeholder
        title="Creatives"
        lead="Every creative is versioned, and a Partner approves a specific version."
        works={[
          'Uploading, verifying and versioning all work — see step 7 of the campaign builder.',
          'A Partner approves one exact creative. Change the image and it becomes a new version, which nobody has approved yet.',
        ]}
        missing={[
          'A library view across campaigns.',
          'Re-using one creative version on a second campaign.',
        ]}
      />
    </Shell>
  );
}
