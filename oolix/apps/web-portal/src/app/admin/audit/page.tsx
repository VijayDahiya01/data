/**
 * Audit trail (§56, §83).
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
  const ctx = await requireContext('/admin/audit');

  return (
    <Shell ctx={ctx}>
      <Placeholder
        title="Audit"
        lead="What happened, who did it, and when."
        works={[
          'Audit events ARE written for every consequential action — approvals, revocations, kill switches, payout transitions, Agent registration and revocation.',
          'The trail records what happened, never a person’s identity or any customer data.',
          'Every event can be traced back to the exact action that caused it.',
        ]}
        missing={[
          'A screen for browsing the trail. Everything is being recorded — there is just no way to read it back here yet.',
          'Export and retention tooling.',
        ]}
      />
    </Shell>
  );
}
