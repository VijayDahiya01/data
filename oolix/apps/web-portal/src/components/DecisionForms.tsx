'use client';

/**
 * Partner decisions (§41, §31).
 *
 * §31 is the point of this screen: "the Data Partner makes the final decision;
 * neither the network sponsor nor Oolix can override it." Everything here is
 * built so that decision is informed and reversible in the right direction —
 * a Partner can approve a subset, ask for a change, reject, or later revoke,
 * but nothing approves on their behalf and silence never becomes consent
 * (§101).
 */
import { useState } from 'react';
import {
  approveRequest,
  extendReview,
  rejectRequest,
  requestChange,
  type ActionState,
} from '@/lib/actions';
import { ActionForm, FieldError, SubmitButton } from './FormState';

export interface DecisionChannel {
  channel: string;
  placement_ids: string[];
  allocation_minor: number;
}

export interface DecisionCreative {
  creative_version_id: string;
  version: number;
  type: string;
  headline?: string | null;
}

const CHANNEL_LABELS: Record<string, string> = {
  PARTNER_WEB: 'Partner website',
  PARTNER_APP: 'Partner app',
  META: 'Meta',
  GOOGLE: 'Google',
};

export function ApproveForm({
  requestId,
  channels,
  creatives,
  expansionRequested,
}: {
  requestId: string;
  channels: DecisionChannel[];
  creatives: DecisionCreative[];
  expansionRequested: boolean;
}) {
  const action = approveRequest.bind(null, requestId);
  const [expansion, setExpansion] = useState(false);

  return (
    <ActionForm action={action}>
      {(_state: ActionState) => (
        <>
          <p className="muted" style={{ marginTop: 0 }}>
            You may approve <strong>less</strong> than was requested. Anything left unchecked is not
            approved, and no activation is created for it.
          </p>

          <div className="field">
            <label>Channels you are approving</label>
            {channels.map((c) => (
              <label className="check" key={c.channel}>
                <input
                  type="checkbox"
                  name="approved_channels"
                  value={c.channel}
                  defaultChecked={c.channel === 'PARTNER_WEB' || c.channel === 'PARTNER_APP'}
                />
                <span>
                  {CHANNEL_LABELS[c.channel] ?? c.channel}
                  {c.channel === 'META' || c.channel === 'GOOGLE' ? (
                    <>
                      <br />
                      <span className="faint">
                        Approving this does not enable an upload. The activation stays pending an
                        eligibility check and receives no manifest.
                      </span>
                    </>
                  ) : null}
                </span>
              </label>
            ))}
            {channels.flatMap((c) => c.placement_ids).length > 0 ? (
              <div className="field-hint">
                Placement selection is carried through from the request. Disable a placement
                entirely from Placements if you never want it used.
              </div>
            ) : null}
          </div>

          {channels
            .flatMap((c) => c.placement_ids)
            .map((pid) => (
              <input key={pid} type="hidden" name="approved_placement_ids" value={pid} />
            ))}

          <div className="field">
            <label>Creative versions you are approving</label>
            {creatives.map((c) => (
              <label className="check" key={c.creative_version_id}>
                <input
                  type="checkbox"
                  name="approved_creative_version_ids"
                  value={c.creative_version_id}
                  defaultChecked
                />
                <span>
                  v{c.version}
                  {c.headline ? ` — ${c.headline}` : ''}{' '}
                  <span className="faint">· {c.type.replaceAll('_', ' ').toLowerCase()}</span>
                </span>
              </label>
            ))}
            <div className="field-hint">
              Approval binds to this exact version and its content hash. A later edit creates a new
              version you have not approved.
            </div>
          </div>

          <label className="check">
            <input
              type="checkbox"
              name="audience_expansion_allowed"
              checked={expansion}
              onChange={(e) => setExpansion(e.target.checked)}
            />
            <span>
              Allow audience expansion / lookalikes
              <br />
              <span className="faint">
                {expansionRequested
                  ? 'The Buyer asked for this. It stays off unless you turn it on.'
                  : 'Not requested. Leave off.'}
              </span>
            </span>
          </label>

          <div className="field">
            <label htmlFor="approval_note">Note (optional)</label>
            <input id="approval_note" name="approval_note" maxLength={1000} />
          </div>

          <div className="btn-row">
            <SubmitButton pendingLabel="Approving…">Approve</SubmitButton>
          </div>
        </>
      )}
    </ActionForm>
  );
}

/**
 * §41 names the fields; v6 §10 adds the audience rules to what a Partner may
 * push back on.
 *
 * The field list is not decoration. The API requires at least one, and this
 * form previously sent none — so every request-change was rejected with a
 * validation error the Partner had no way to interpret.
 */
const CHANGEABLE = [
  {
    value: 'audience_rules',
    label: 'Audience rules',
    // v6 §10: "REQUEST_CHANGE can request audience-rule changes in addition to
    // creative/placement/commercial changes." A Partner asked to serve a rule
    // set they consider too broad, too narrow or outside their policy needs a
    // way to say so that is not "reject".
    hint: 'The conditions themselves — too broad, too narrow, or outside your policy.',
  },
  { value: 'creative', label: 'Creative', hint: 'Copy, imagery or the landing destination.' },
  { value: 'placement', label: 'Placement', hint: 'Which slot on your property.' },
  { value: 'channel', label: 'Channel', hint: 'Web, app or an external channel.' },
  { value: 'commercial_terms', label: 'Commercial terms', hint: 'Payout basis or unit price.' },
  { value: 'dates_frequency', label: 'Dates or frequency', hint: 'Flight dates, or the cap.' },
  { value: 'purpose', label: 'Purpose', hint: 'The declared advertising purpose.' },
];

export function RequestChangeForm({ requestId }: { requestId: string }) {
  const action = requestChange.bind(null, requestId);

  return (
    <ActionForm action={action}>
      {(state: ActionState) => (
        <>
          <p className="muted" style={{ marginTop: 0 }}>
            The Buyer edits and resubmits as a new version. Nothing runs in the meantime.
          </p>

          <div className="field">
            <label>What needs to change?</label>
            {CHANGEABLE.map((c) => (
              <label className="check" key={c.value}>
                <input type="checkbox" name="fields" value={c.value} />
                <span>
                  {c.label}
                  <br />
                  <span className="faint">{c.hint}</span>
                </span>
              </label>
            ))}
            <div className="field-hint">Pick at least one, so the Buyer knows what to fix.</div>
          </div>

          <div className="field">
            <label htmlFor="change_reason">Why</label>
            <textarea id="change_reason" name="reason" rows={3} required minLength={3} />
            <FieldError state={state} name="reason" />
          </div>

          <div className="btn-row">
            <SubmitButton className="" pendingLabel="Sending…">
              Request change
            </SubmitButton>
          </div>
        </>
      )}
    </ActionForm>
  );
}

export function RejectForm({ requestId }: { requestId: string }) {
  const action = rejectRequest.bind(null, requestId);

  return (
    <ActionForm action={action}>
      {(_state: ActionState) => (
        <>
          <p className="muted" style={{ marginTop: 0 }}>
            A rejected request never becomes approved without a new one. Your reason is the only
            thing the Buyer has to work from.
          </p>
          <div className="field">
            <label htmlFor="reject_reason">Reason</label>
            <textarea id="reject_reason" name="reason" rows={3} required minLength={3} />
          </div>
          <div className="btn-row">
            <SubmitButton className="btn-danger" pendingLabel="Rejecting…">
              Reject
            </SubmitButton>
          </div>
        </>
      )}
    </ActionForm>
  );
}

/** §101: one extension, up to 7 days, with an audited reason. */
export function ExtendForm({
  requestId,
  alreadyExtended,
}: {
  requestId: string;
  alreadyExtended: boolean;
}) {
  const action = extendReview.bind(null, requestId);

  if (alreadyExtended) {
    return <p className="muted">This review has already been extended once, which is the limit.</p>;
  }

  return (
    <ActionForm action={action}>
      {(_state: ActionState) => (
        <>
          <p className="muted" style={{ marginTop: 0 }}>
            Buys more time to decide. It is not a decision, and expiry is neither approval nor
            rejection.
          </p>
          <div className="field-row">
            <div className="field">
              <label htmlFor="extra_days">Extra days</label>
              <input
                id="extra_days"
                name="extra_days"
                type="number"
                min="1"
                max="7"
                defaultValue="7"
              />
            </div>
            <div className="field">
              <label htmlFor="extend_reason">Reason</label>
              <input id="extend_reason" name="reason" required minLength={3} />
            </div>
          </div>
          <div className="btn-row">
            <SubmitButton className="" pendingLabel="Extending…">
              Extend review
            </SubmitButton>
          </div>
        </>
      )}
    </ActionForm>
  );
}
