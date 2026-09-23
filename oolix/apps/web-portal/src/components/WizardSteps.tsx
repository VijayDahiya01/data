/**
 * The campaign builder, as v6 §9's ten steps.
 *
 * v6 renumbers the wizard around the inverted flow: audience first, then the
 * Partners who can evaluate it. Step 3 is no longer "audience discovery" but
 * "choose/create Audience Group", and Partner matching becomes its own step
 * between choosing an audience and choosing who serves it.
 *
 * The portal groups them onto four screens because the API creates a draft in
 * one call, attaches Partner requests in another, and submits in a third. The
 * labels stay faithful to §9 so a reader of the spec can find where they are.
 */
const STEPS = [
  { n: 1, label: 'Objective', screen: 1 },
  { n: 2, label: 'Campaign basics', screen: 1 },
  { n: 9, label: 'Lead definition', screen: 1 },
  // Step 8 is taken out of numerical order deliberately. §70 binds a Partner's
  // approval to a specific creative VERSION and its content hash, so a
  // creative has to exist before a request can be made to a Partner at all.
  { n: 8, label: 'Creative', screen: 2 },
  { n: 3, label: 'Audience', screen: 3 },
  { n: 4, label: 'Partner matches', screen: 3 },
  { n: 5, label: 'Partner selection', screen: 3 },
  { n: 6, label: 'Channel & placement', screen: 3 },
  { n: 7, label: 'Budget allocation', screen: 3 },
  { n: 10, label: 'Review & submit', screen: 4 },
];

export function WizardSteps({ current }: { current: number }) {
  return (
    <ol className="steps" aria-label="Campaign builder steps">
      {STEPS.map((s) => {
        const cls =
          s.screen === current
            ? 'step step-current'
            : s.screen < current
              ? 'step step-done'
              : 'step';
        return (
          <li key={s.n}>
            <span className={cls}>
              {s.n}. {s.label}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
