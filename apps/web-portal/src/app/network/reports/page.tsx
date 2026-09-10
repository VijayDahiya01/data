/**
 * Portfolio-level reporting (§34, §66.2).
 *
 * §34 lists this in the persona's primary navigation, so the link exists.
 * The capability behind it does not: there is no API endpoint for it yet, and
 * §85's phase plan does not reach it. Saying that plainly beats a dead link
 * or a screen that looks broken.
 */
import { requireContext } from '@/lib/nav-entry';
import { Shell } from '@/components/Shell';
import { Placeholder } from '@/components/Placeholder';

export default async function Page() {
  const ctx = await requireContext('/network/reports');

  return (
    <Shell ctx={ctx}>
      <Placeholder
        title="Network reports"
        lead="Aggregate performance across member companies, without customer data."
        works={[
          'Per-campaign and per-Partner reporting works today for the Buyer and the Partner themselves.',
          'What a sponsor may see is already limited to overall performance across the network, never a member’s customer data.',
        ]}
        missing={[
          'A roll-up view across the whole network.',
          'Note that any such view must not sum reach across Partners.',
        ]}
      />
    </Shell>
  );
}
