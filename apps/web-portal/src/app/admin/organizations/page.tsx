/**
 * Platform organization administration (§34, §35.2).
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
  const ctx = await requireContext('/admin/organizations');

  return (
    <Shell ctx={ctx}>
      <Placeholder
        title="Organizations"
        lead="Every organization on the platform, and its verification state."
        works={[
          'Organizations can be created, and each carries a verification state. Until an organization is verified it can prepare work but cannot submit or publish it.',
          'Anyone signed in can see their own organization and its verification state.',
        ]}
        missing={[
          'A platform-wide list of organizations, and a workflow for moving them through verification.',
          'Whatever is built keeps the same limit: running the platform never includes approving on a Data Partner’s behalf, or reaching their data.',
        ]}
      />
    </Shell>
  );
}
