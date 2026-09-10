/**
 * Advertising policy (§41, §83).
 *
 * The capability exists in the API and is covered by tests; this screen is
 * what has not been built yet. Saying so explicitly beats a blank page.
 */
import { requireContext } from '@/lib/nav-entry';
import { Shell } from '@/components/Shell';
import { Placeholder } from '@/components/Placeholder';

export default async function Page() {
  const ctx = await requireContext('/partner/policies');

  return (
    <Shell ctx={ctx}>
      <Placeholder
        title="Policies"
        lead="The categories and rules every campaign request is checked against."
        works={[
          'Publishing a policy creates a new version. A policy is never edited in place, so you can always see what applied when.',
          'Every approval binds to the policy version in force at that moment, so editing one cannot retroactively change what you agreed to.',
        ]}
        missing={[
          'A policy editor.',
          'A screen for managing which advertising categories you allow and block.',
        ]}
      />
    </Shell>
  );
}
