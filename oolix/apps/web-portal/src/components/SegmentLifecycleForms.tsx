'use client';

/**
 * Keeping a published segment honest (§38.1, §72).
 *
 * Two actions, deliberately separate. Reporting a refresh says "I recomputed
 * this on my side, and it currently has N members" — the count re-derives the
 * published range and is then discarded. Publishing makes the segment
 * discoverable, and §38.1 will not allow it until a real refresh has been
 * reported, so a Buyer can never find a segment that has never actually been
 * computed.
 */
import { publishSegment, reportSegmentFreshness, type ActionState } from '@/lib/actions';
import { ActionForm, SubmitButton } from './FormState';

export function FreshnessForm({ segmentId }: { segmentId: string }) {
  const action = reportSegmentFreshness.bind(null, segmentId);

  return (
    <ActionForm action={action}>
      {(_state: ActionState) => (
        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div className="field" style={{ marginBottom: 0, maxWidth: 200 }}>
            <label htmlFor={`reach-${segmentId}`}>Current member count</label>
            <input
              id={`reach-${segmentId}`}
              name="reach_exact_local"
              type="number"
              min="0"
              required
            />
          </div>
          <SubmitButton className="" pendingLabel="Reporting…">
            Report refresh
          </SubmitButton>
        </div>
      )}
    </ActionForm>
  );
}

export function PublishForm({ segmentId, published }: { segmentId: string; published: boolean }) {
  const action = publishSegment.bind(null, segmentId);

  if (published) {
    return <span className="faint">Discoverable by Buyers in your network.</span>;
  }

  return (
    <ActionForm action={action}>
      {(_state: ActionState) => (
        <SubmitButton pendingLabel="Publishing…">Publish to catalogue</SubmitButton>
      )}
    </ActionForm>
  );
}
