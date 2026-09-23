/**
 * CRM lead feedback (§71, §90).
 *
 * The capability exists in the API and is covered by tests; this screen is
 * what has not been built yet. Saying so explicitly beats a blank page.
 */
import { requireContext } from '@/lib/nav-entry';
import { Shell } from '@/components/Shell';
import { Placeholder } from '@/components/Placeholder';

export default async function Page() {
  const ctx = await requireContext('/leads');

  return (
    <Shell ctx={ctx}>
      <Placeholder
        title="Leads"
        lead="What your CRM reported back, against opaque click tokens."
        works={[
          'Your CRM can send lead outcomes back to Oolix, one at a time or in batches, using your own key.',
          'Lead states move forward only: received to valid to qualified to converted, or rejected.',
          'Events are idempotent on (buyer_org_id, crm_event_id), so a retry storm cannot inflate a payout.',
        ]}
        missing={[
          'A lead browser and quality dashboard.',
          'A screen for connecting your CRM. Keys can be issued today — see Connections.',
        ]}
      />
    </Shell>
  );
}
