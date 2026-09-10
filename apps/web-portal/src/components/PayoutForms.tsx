'use client';

/**
 * Payout lifecycle controls (§76, §83.1, §102).
 *
 * §76's state machine is the whole design here: CALCULATED to REVIEWED to
 * APPROVED to PAID, one step at a time, and a DISPUTED payout cannot be paid at
 * all until the dispute resolves. So this component shows exactly ONE next
 * step — offering "mark paid" beside "review" would invite someone to try a
 * transition the API will refuse anyway.
 *
 * §66 splits who may do what: raising a dispute needs only `payout:read`
 * (either side can), while approving needs `payout:approve` — the FINANCE role.
 */
import { useState } from 'react';
import {
  advancePayout,
  disputePayout,
  resolvePayoutDispute,
  type ActionState,
} from '@/lib/actions-ops';
import { ActionForm, SubmitButton } from './FormState';

const NEXT_STEP: Record<string, { step: 'review' | 'approve' | 'mark-paid'; label: string }> = {
  CALCULATED: { step: 'review', label: 'Mark reviewed' },
  REVIEWED: { step: 'approve', label: 'Approve payout' },
  ADJUSTED: { step: 'approve', label: 'Approve adjusted payout' },
  APPROVED: { step: 'mark-paid', label: 'Mark as paid' },
};

export function PayoutAdvanceForm({
  payoutId,
  status,
  mayApprove,
}: {
  payoutId: string;
  status: string;
  mayApprove: boolean;
}) {
  const next = NEXT_STEP[status];

  if (status === 'PAID') {
    return <span className="badge badge-ok">settled</span>;
  }

  if (status === 'DISPUTED') {
    return (
      <span className="faint">
        Held until the dispute is resolved. A disputed payout cannot be paid.
      </span>
    );
  }

  if (!next) return <span className="faint">No action available in this state.</span>;

  if (!mayApprove) {
    return (
      <span className="faint">
        Next step is &ldquo;{next.label}&rdquo;, which needs the finance role.
      </span>
    );
  }

  const action = advancePayout.bind(null, payoutId, next.step);

  return (
    <ActionForm action={action}>
      {(_state: ActionState) => <SubmitButton pendingLabel="Working…">{next.label}</SubmitButton>}
    </ActionForm>
  );
}

const REASONS = [
  { value: 'QUALIFIED_COUNT_DISPUTED', label: 'The qualified count looks wrong' },
  { value: 'DUPLICATE_LEADS', label: 'Duplicate leads were counted' },
  { value: 'DELIVERY_MISMATCH', label: 'Delivery does not match my own counts' },
  { value: 'PRICING_DISAGREEMENT', label: 'The rate applied is not what we agreed' },
  { value: 'OTHER', label: 'Something else' },
];

export function DisputeForm({ payoutId }: { payoutId: string }) {
  const action = disputePayout.bind(null, payoutId);

  return (
    <ActionForm action={action}>
      {(_state: ActionState) => (
        <>
          <p className="muted" style={{ marginTop: 0 }}>
            Either side may dispute, and the payout is <strong>held</strong> until it resolves.
            Nothing is deleted — a correction is appended as its own event.
          </p>

          <div className="field-row">
            <div className="field">
              <label htmlFor={`reason-code-${payoutId}`}>What is wrong?</label>
              <select
                id={`reason-code-${payoutId}`}
                name="reason_code"
                defaultValue="QUALIFIED_COUNT_DISPUTED"
              >
                {REASONS.map((r) => (
                  <option key={r.value} value={r.value}>
                    {r.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor={`claimed-${payoutId}`}>Count you believe is correct</label>
              <input
                id={`claimed-${payoutId}`}
                name="claimed_qualified_count"
                type="number"
                min="0"
              />
              <div className="field-hint">Optional. Recorded alongside the dispute.</div>
            </div>
          </div>

          <div className="field">
            <label htmlFor={`dispute-reason-${payoutId}`}>Explain</label>
            <textarea
              id={`dispute-reason-${payoutId}`}
              name="reason"
              rows={2}
              required
              minLength={10}
            />
          </div>

          <div className="btn-row">
            <SubmitButton className="" pendingLabel="Raising…">
              Raise dispute
            </SubmitButton>
          </div>
        </>
      )}
    </ActionForm>
  );
}

export function ResolveDisputeForm({ payoutId }: { payoutId: string }) {
  const action = resolvePayoutDispute.bind(null, payoutId);
  const [outcome, setOutcome] = useState('ADJUSTED');

  return (
    <ActionForm action={action}>
      {(_state: ActionState) => (
        <>
          <p className="muted" style={{ marginTop: 0 }}>
            A correction is <strong>added</strong> as an adjustment. The original figure is never
            edited, so the history shows what changed and when — not just where things ended up.
          </p>

          <div className="field-row">
            <div className="field">
              <label htmlFor={`outcome-${payoutId}`}>Outcome</label>
              <select
                id={`outcome-${payoutId}`}
                name="outcome"
                value={outcome}
                onChange={(e) => setOutcome(e.target.value)}
              >
                <option value="ADJUSTED">Adjust the payout</option>
                <option value="REJECTED_DISPUTE">Dispute not upheld</option>
              </select>
            </div>

            {outcome === 'ADJUSTED' ? (
              <div className="field">
                <label htmlFor={`corrected-${payoutId}`}>Corrected verified count</label>
                <input
                  id={`corrected-${payoutId}`}
                  name="corrected_qualified_count"
                  type="number"
                  min="0"
                  required
                />
                <div className="field-hint">The adjustment is computed from this.</div>
              </div>
            ) : null}
          </div>

          <div className="field">
            <label htmlFor={`note-${payoutId}`}>Resolution note</label>
            <textarea
              id={`note-${payoutId}`}
              name="resolution_note"
              rows={2}
              required
              minLength={10}
            />
            <div className="field-hint">Recorded permanently against the payout.</div>
          </div>

          <div className="btn-row">
            <SubmitButton pendingLabel="Resolving…">Resolve dispute</SubmitButton>
          </div>
        </>
      )}
    </ActionForm>
  );
}
