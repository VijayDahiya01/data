'use client';

/**
 * Verify an organization, or put a verified one back to pending (§35.2, §66).
 *
 * §66.3 gates campaign submission and supply publication on BUSINESS_VERIFIED.
 * This is the only way to grant it on a real deployment: the development seed
 * is the only other writer of that state, and it refuses to run against
 * production.
 *
 * Verifying asks for nothing, because the evidence lives wherever the operator
 * checked it and an optional note is enough to point back at it. Revoking
 * requires a reason, because that is the one somebody will be asked to explain
 * months later.
 */
import {
  verifyOrganization,
  revokeOrganizationVerification,
  type ActionState,
} from '@/lib/actions-ops';
import { ActionForm, SubmitButton } from './FormState';

export function OrganizationVerification({
  orgId,
  canSubmitOrPublish,
}: {
  orgId: string;
  canSubmitOrPublish: boolean;
}) {
  return canSubmitOrPublish ? <RevokeForm orgId={orgId} /> : <VerifyForm orgId={orgId} />;
}

function VerifyForm({ orgId }: { orgId: string }) {
  const bound = verifyOrganization.bind(null, orgId);

  return (
    <details>
      <summary style={{ cursor: 'pointer' }}>Verify</summary>
      <div style={{ marginTop: '0.6rem', minWidth: 280 }}>
        <ActionForm action={bound}>
          {(_state: ActionState) => (
            <>
              <div className="field">
                <label htmlFor={`note-${orgId}`}>Note (optional)</label>
                <input
                  id={`note-${orgId}`}
                  name="note"
                  maxLength={500}
                  placeholder="Where the evidence lives"
                />
                <div className="field-hint">
                  Recorded in the audit trail. Verifying says this is a real legal entity — it does
                  not approve anything on a Data Partner&rsquo;s behalf.
                </div>
              </div>
              <SubmitButton pendingLabel="Verifying…">Verify organization</SubmitButton>
            </>
          )}
        </ActionForm>
      </div>
    </details>
  );
}

function RevokeForm({ orgId }: { orgId: string }) {
  const bound = revokeOrganizationVerification.bind(null, orgId);

  return (
    <details>
      <summary style={{ cursor: 'pointer' }} className="faint">
        Revoke verification
      </summary>
      <div style={{ marginTop: '0.6rem', minWidth: 280 }}>
        <ActionForm action={bound}>
          {(_state: ActionState) => (
            <>
              <div className="field">
                <label htmlFor={`reason-${orgId}`}>Reason</label>
                <input
                  id={`reason-${orgId}`}
                  name="reason"
                  required
                  minLength={3}
                  maxLength={500}
                />
                <div className="field-hint">
                  Required, and recorded in the audit trail. Stops new submissions and publications.
                  Anything already approved keeps running.
                </div>
              </div>
              <SubmitButton className="btn-danger" pendingLabel="Revoking…">
                Revoke verification
              </SubmitButton>
            </>
          )}
        </ActionForm>
      </div>
    </details>
  );
}
