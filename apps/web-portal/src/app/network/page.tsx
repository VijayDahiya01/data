/**
 * Network sponsor view (§31, §66.2).
 *
 * The capability exists in the API and is covered by tests; this screen is
 * what has not been built yet. Saying so explicitly beats a blank page.
 */
import { requireContext } from '@/lib/nav-entry';
import { Shell } from '@/components/Shell';
import { Placeholder } from '@/components/Placeholder';

export default async function Page() {
  const ctx = await requireContext('/network');

  return (
    <Shell ctx={ctx}>
      <Placeholder
        title="Network"
        lead="Portfolio-level performance, without customer data."
        works={[
          'Who belongs to a network, and what that lets them see, is enforced everywhere — not just hidden in the interface.',
          'A sponsor can choose which supply to offer, but can never overrule a Data Partner’s decision.',
        ]}
        missing={['Network dashboards and member management screens.', 'Invitation flows.']}
      />
    </Shell>
  );
}
