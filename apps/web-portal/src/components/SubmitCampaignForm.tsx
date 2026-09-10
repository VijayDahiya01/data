'use client';

/**
 * Step 9 — submit (§40.9).
 *
 * Submitting freezes the request version and starts each Partner's own review
 * clock (§101). §53 makes the Idempotency-Key mandatory here, because a
 * retried submit must not open a second review.
 */
import { submitCampaign, type ActionState } from '@/lib/actions';
import { ActionForm, SubmitButton } from './FormState';

export function SubmitCampaignForm({
  campaignId,
  disabled,
}: {
  campaignId: string;
  disabled?: boolean;
}) {
  const action = submitCampaign.bind(null, campaignId);

  if (disabled) {
    return (
      <button type="button" disabled>
        Submit for Partner review
      </button>
    );
  }

  return (
    <ActionForm action={action}>
      {(_state: ActionState) => (
        <SubmitButton pendingLabel="Submitting…">Submit for Partner review</SubmitButton>
      )}
    </ActionForm>
  );
}
