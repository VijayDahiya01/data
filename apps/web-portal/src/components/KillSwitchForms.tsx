'use client';

/**
 * Kill switch controls (§6, §24).
 *
 * The scope selector is ordered narrowest first. Stopping everything is
 * available and sometimes right, but offering it as the default would make the
 * blunt instrument the easy one.
 */
import { useState } from 'react';
import { activateKillSwitch, releaseKillSwitch, type ActionState } from '@/lib/actions';
import { ActionForm, SubmitButton } from './FormState';

const SCOPES = [
  {
    value: 'ACTIVATION',
    label: 'One activation',
    hint: 'Stops a single campaign on your property.',
  },
  { value: 'PLACEMENT', label: 'One placement', hint: 'Stops every campaign in one slot.' },
  { value: 'CHANNEL', label: 'One channel', hint: 'Stops a whole channel, e.g. your app.' },
  { value: 'AGENT', label: 'One Agent', hint: 'Stops everything that Agent serves.' },
  { value: 'PARTNER_ALL', label: 'Everything', hint: 'Stops all Oolix serving on your property.' },
];

export function KillSwitchForm() {
  const [scope, setScope] = useState('ACTIVATION');
  const needsTarget = scope !== 'PARTNER_ALL';
  const hint = SCOPES.find((s) => s.value === scope)?.hint;

  return (
    <ActionForm action={activateKillSwitch}>
      {(_state: ActionState) => (
        <>
          <div className="field-row">
            <div className="field">
              <label htmlFor="scope">Scope</label>
              <select
                id="scope"
                name="scope"
                value={scope}
                onChange={(e) => setScope(e.target.value)}
              >
                {SCOPES.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </select>
              <div className="field-hint">{hint}</div>
            </div>

            {needsTarget ? (
              <div className="field">
                <label htmlFor="target_id">Target</label>
                <input
                  id="target_id"
                  name="target_id"
                  placeholder="activation id or placement key"
                />
                <div className="field-hint">
                  For a placement this is the placement KEY — what your Agent matches on locally,
                  without needing to reach Oolix.
                </div>
              </div>
            ) : null}
          </div>

          <div className="field">
            <label htmlFor="ks_reason">Reason</label>
            <input id="ks_reason" name="reason" required minLength={3} maxLength={500} />
            <div className="field-hint">Recorded in the audit trail.</div>
          </div>

          <div className="btn-row">
            <SubmitButton className="btn-danger" pendingLabel="Stopping…">
              Stop serving now
            </SubmitButton>
            <span className="faint">Takes effect immediately. No approval needed.</span>
          </div>
        </>
      )}
    </ActionForm>
  );
}

export function ReleaseKillSwitchForm({ killSwitchId }: { killSwitchId: string }) {
  const action = releaseKillSwitch.bind(null, killSwitchId);

  return (
    <ActionForm action={action}>
      {(_state: ActionState) => (
        <SubmitButton className="" pendingLabel="Releasing…">
          Release
        </SubmitButton>
      )}
    </ActionForm>
  );
}
