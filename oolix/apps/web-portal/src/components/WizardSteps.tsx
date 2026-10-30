/**
 * The campaign builder's three screens.
 *
 * v6 §9 describes ten steps. They are all still here, grouped by what a Buyer
 * does rather than numbered by section: §9's numbers, shown out of order
 * (1, 2, 9, 8, 3...), told nobody where they were.
 *
 *   1 Campaign            §9 steps 1, 2, 3 and 9: objective, basics, the
 *                         audience and the lead definition
 *   2 Ad                  step 8
 *   3 Partners & submit   steps 4-7 and 10: matches, selection, channels,
 *                         budget, review and submit
 *
 * The ad comes before the Partners deliberately. §70 binds a Partner's approval
 * to a specific creative VERSION and its content hash, so a creative has to
 * exist before a request can be made to a Partner at all.
 */
const STEPS = ['Campaign', 'Ad', 'Partners & submit'];

export function WizardSteps({ current }: { current: number }) {
  return (
    <ol className="steps" aria-label="Campaign builder steps">
      {STEPS.map((label, i) => {
        const n = i + 1;
        const cls = n === current ? 'step step-current' : n < current ? 'step step-done' : 'step';
        return (
          <li key={label}>
            <span className={cls} aria-current={n === current ? 'step' : undefined}>
              {n}. {label}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
