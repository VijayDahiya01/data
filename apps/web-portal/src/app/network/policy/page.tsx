/**
 * Network admission rules (§31, §34).
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
  const ctx = await requireContext('/network/policy');

  return (
    <Shell ctx={ctx}>
      <Placeholder
        title="Network policy"
        lead="The rules that govern who may join and what they may transact."
        works={[
          'The limit that matters most is already in force: a network sponsor can choose which supply to offer, but can never overrule a Data Partner’s decision. There is no way to do it.',
          'Each Data Partner sets its own advertising policy, and every change is kept as a version — see Policies under Data Partner.',
        ]}
        missing={['A screen for editing network policy.']}
      />
    </Shell>
  );
}
