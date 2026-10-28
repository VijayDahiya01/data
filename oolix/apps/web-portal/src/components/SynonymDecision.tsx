'use client';

/**
 * Approve or reject one value Partners shared (docs/DESIGN-PARTNER-DATA.md
 * §5.6). Approving sends the value and its code to every Partner's Agent,
 * so the code is chosen explicitly -- the most agreed one first -- rather
 * than assumed.
 */
import { decideSharedSynonym, type ActionState } from '@/lib/actions-ops';
import { ActionForm, SubmitButton } from './FormState';

export function SynonymDecision({
  attributeKey,
  valueKey,
  codes,
  status,
}: {
  attributeKey: string;
  valueKey: string;
  /** The codes Partners gave, most agreed first; or the one decided. */
  codes: string[];
  /** The decision already made, if any. */
  status?: 'APPROVED' | 'REJECTED';
}) {
  const approve = decideSharedSynonym.bind(null, attributeKey, valueKey, 'APPROVED');
  const reject = decideSharedSynonym.bind(null, attributeKey, valueKey, 'REJECTED');
  const id = `code-${attributeKey}-${valueKey}`.replace(/[^a-z0-9_-]/gi, '-');

  return (
    <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-start', flexWrap: 'wrap' }}>
      {status !== 'APPROVED' ? (
        <ActionForm action={approve}>
          {(_state: ActionState) => (
            <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'center' }}>
              <select
                id={id}
                name="code"
                defaultValue={codes[0]}
                aria-label={`Code for ${valueKey}`}
              >
                {codes.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
              <SubmitButton pendingLabel="Approving…">Approve</SubmitButton>
            </div>
          )}
        </ActionForm>
      ) : null}
      {status !== 'REJECTED' ? (
        <ActionForm action={reject}>
          {(_state: ActionState) => (
            <>
              <input type="hidden" name="code" value={codes[0]} />
              <SubmitButton className="btn-secondary" pendingLabel="Rejecting…">
                Reject
              </SubmitButton>
            </>
          )}
        </ActionForm>
      ) : null}
    </div>
  );
}
