'use client';

/**
 * Pause, resume and end one activation (§52.3, §76).
 *
 * §52.3 makes these reachable by the Partner that serves the activation AND the
 * Buyer that pays for it — neither can touch the other's. Ending is one-way:
 * §76 has no edge from ENDED back to LIVE, which is why it asks for a reason
 * and the others do not.
 */
import { activationAction, type ActionState } from '@/lib/actions';
import { ActionForm, SubmitButton } from './FormState';

export function ActivationControls({
  activationId,
  status,
}: {
  activationId: string;
  status: string;
}) {
  const running = status === 'LIVE' || status === 'READY' || status === 'SYNCING';
  const paused = status === 'PAUSED';
  const finished = status === 'ENDED' || status === 'ENDING';

  if (finished) {
    return <span className="faint">Ended. There is no way back to live.</span>;
  }

  return (
    <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'flex-start' }}>
      {running ? <PauseResume activationId={activationId} action="pause" label="Pause" /> : null}
      {paused ? <PauseResume activationId={activationId} action="resume" label="Resume" /> : null}
      <EndForm activationId={activationId} />
    </div>
  );
}

function PauseResume({
  activationId,
  action,
  label,
}: {
  activationId: string;
  action: 'pause' | 'resume';
  label: string;
}) {
  const bound = activationAction.bind(null, activationId, action);

  return (
    <ActionForm action={bound}>
      {(_state: ActionState) => (
        <SubmitButton className="" pendingLabel="Working…">
          {label}
        </SubmitButton>
      )}
    </ActionForm>
  );
}

function EndForm({ activationId }: { activationId: string }) {
  const bound = activationAction.bind(null, activationId, 'end');

  return (
    <details>
      <summary style={{ cursor: 'pointer' }} className="faint">
        End permanently
      </summary>
      <div style={{ marginTop: '0.6rem', minWidth: 260 }}>
        <ActionForm action={bound}>
          {(_state: ActionState) => (
            <>
              <div className="field">
                <label htmlFor={`end-${activationId}`}>Reason</label>
                <input id={`end-${activationId}`} name="reason" required minLength={3} />
                <div className="field-hint">
                  Recorded in the audit trail. This cannot be undone.
                </div>
              </div>
              <SubmitButton className="btn-danger" pendingLabel="Ending…">
                End activation
              </SubmitButton>
            </>
          )}
        </ActionForm>
      </div>
    </details>
  );
}
