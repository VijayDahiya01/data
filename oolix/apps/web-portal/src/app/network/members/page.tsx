/**
 * Network membership (§34, §66.2).
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
  const ctx = await requireContext('/network/members');

  return (
    <Shell ctx={ctx}>
      <Placeholder
        title="Member companies"
        lead="The organizations admitted to this network."
        works={[
          'Membership decides what a Buyer can see. Private supply is visible only through a network they have actually been admitted to.',
          'The demo data includes a private network with the Buyer and both Data Partners in it, so the visibility rules can be seen working.',
        ]}
        missing={[
          'A member list and admission screen.',
          'Inviting an organization to join a network.',
        ]}
      />
    </Shell>
  );
}
