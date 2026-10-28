'use client';

/**
 * The cross-Partner clean room (docs/DESIGN-PARTNER-DATA.md phase 7): taking
 * part, asking another Partner for a run, and answering one.
 */
import type { ActionState } from '@/lib/actions';
import {
  decideCleanRoomRun,
  requestCleanRoomRun,
  setCleanRoomParticipation,
} from '@/lib/actions-audience';
import { ActionForm, SubmitButton } from './FormState';

export function CleanRoomParticipation({ enabled }: { enabled: boolean }) {
  return (
    <ActionForm action={setCleanRoomParticipation}>
      {(_state: ActionState) => (
        <>
          <p style={{ marginTop: 0 }}>
            {enabled ? (
              <>
                <strong>Taking part.</strong> Other Partners who take part can ask you for runs; you
                approve each one.
              </>
            ) : (
              <>
                <strong>Not taking part.</strong> Nobody can ask you for a run.
              </>
            )}
          </p>
          <input type="hidden" name="enabled" value={enabled ? 'false' : 'true'} />
          <SubmitButton className={enabled ? 'btn-secondary' : 'btn-primary'}>
            {enabled ? 'Stop taking part' : 'Take part'}
          </SubmitButton>
        </>
      )}
    </ActionForm>
  );
}

export function CleanRoomRequest({ partners }: { partners: { org_id: string; name: string }[] }) {
  return (
    <ActionForm action={requestCleanRoomRun}>
      {(_state: ActionState) => (
        <>
          <div className="field">
            <label htmlFor="with_org_id">Partner</label>
            <select id="with_org_id" name="with_org_id" defaultValue="">
              <option value="" disabled>
                Choose a Partner
              </option>
              {partners.map((p) => (
                <option key={p.org_id} value={p.org_id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="kind">What to find out</label>
            <select id="kind" name="kind" defaultValue="OVERLAP">
              <option value="OVERLAP">How many customers we share (a size band)</option>
              <option value="JOINT">An audience of my customers we share</option>
            </select>
            <div className="field-hint">
              A joint audience goes to your Agent alone, sealed to it. Under 100 shared customers,
              nothing is given.
            </div>
          </div>
          <SubmitButton pendingLabel="Asking…">Ask</SubmitButton>
        </>
      )}
    </ActionForm>
  );
}

export function CleanRoomDecision({ runId }: { runId: string }) {
  const decide = decideCleanRoomRun.bind(null, runId);
  return (
    <div style={{ display: 'flex', gap: '0.5rem' }}>
      <ActionForm action={decide}>
        {(_state: ActionState) => (
          <>
            <input type="hidden" name="approve" value="true" />
            <SubmitButton pendingLabel="Approving…">Approve</SubmitButton>
          </>
        )}
      </ActionForm>
      <ActionForm action={decide}>
        {(_state: ActionState) => (
          <>
            <input type="hidden" name="approve" value="false" />
            <SubmitButton className="btn-secondary" pendingLabel="Declining…">
              Decline
            </SubmitButton>
          </>
        )}
      </ActionForm>
    </div>
  );
}
