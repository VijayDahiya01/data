'use client';

/**
 * Forms for the operational screens — team, placements, Agent identity, CRM.
 *
 * Two of these hand back a secret that is shown exactly once (§92.1 bootstrap
 * tokens, §71 CRM keys). Both store only a SHA-256 server-side, so there is no
 * "show it again" — the components say so plainly rather than letting someone
 * assume they can come back for it.
 */
import { useState } from 'react';
import {
  createBootstrapToken,
  createPlacement,
  inviteMember,
  issueCrmKey,
  reconcileActivation,
  removeMember,
  revokeAgent,
  revokeBootstrapTokens,
  setPlacementStatus,
  type ActionState,
  type KeyState,
  type ReconcileState,
  type TokenState,
} from '@/lib/actions-ops';
import { ActionForm, FieldError, SubmitButton } from './FormState';

/* --- team (§35.3, §66) ------------------------------------------------------ */

const ROLES = [
  { value: 'BUYER_ADMIN', label: 'Buyer admin — create and submit campaigns, manage billing' },
  { value: 'BUYER_OPERATOR', label: 'Buyer operator — draft campaigns, cannot change billing' },
  { value: 'PARTNER_ADMIN', label: 'Partner admin — publish supply, manage payout' },
  { value: 'PARTNER_SECURITY_ADMIN', label: 'Partner security — register Agents and connectors' },
  { value: 'PARTNER_CAMPAIGN_APPROVER', label: 'Partner approver — decide on requests only' },
  { value: 'FINANCE', label: 'Finance — invoices, payout and settlement' },
  { value: 'ANALYST', label: 'Analyst — read-only reports' },
  { value: 'NETWORK_ADMIN', label: 'Network admin — invitations and admission rules' },
];

export function InviteMemberForm() {
  return (
    <ActionForm action={inviteMember}>
      {(state: ActionState) => (
        <>
          <div className="field-row">
            <div className="field">
              <label htmlFor="invite_email">Work email</label>
              <input id="invite_email" name="email" type="email" required />
              <FieldError state={state} name="email" />
            </div>
            <div className="field">
              <label htmlFor="invite_role">Role</label>
              <select id="invite_role" name="role" required defaultValue="ANALYST">
                {ROLES.map((r) => (
                  <option key={r.value} value={r.value}>
                    {r.label}
                  </option>
                ))}
              </select>
              <FieldError state={state} name="role" />
            </div>
          </div>
          <div className="field-hint">
            Roles are deliberately narrow. Whoever creates a campaign request cannot be the one who
            approves it — not even someone who holds both roles.
          </div>
          <div className="btn-row">
            <SubmitButton pendingLabel="Inviting…">Send invitation</SubmitButton>
          </div>
        </>
      )}
    </ActionForm>
  );
}

export function RemoveMemberForm({ userId, name }: { userId: string; name: string }) {
  const action = removeMember.bind(null, userId);
  return (
    <ActionForm action={action}>
      {(_state: ActionState) => (
        <SubmitButton className="" pendingLabel="Removing…">
          Remove {name.split(' ')[0]}
        </SubmitButton>
      )}
    </ActionForm>
  );
}

/* --- placements (§43) ------------------------------------------------------- */

export function PlacementForm() {
  const [surface, setSurface] = useState('web');

  return (
    <ActionForm action={createPlacement}>
      {(state: ActionState) => (
        <>
          <div className="field-row">
            <div className="field">
              <label htmlFor="placement_key">Placement key</label>
              <input
                id="placement_key"
                name="placement_key"
                required
                placeholder="booking_success_offer"
              />
              <div className="field-hint">
                What your Agent matches on locally — so a kill switch scoped to this placement works
                even while Oolix is unreachable.
              </div>
              <FieldError state={state} name="placement_key" />
            </div>
            <div className="field">
              <label htmlFor="placement_name">Display name</label>
              <input
                id="placement_name"
                name="display_name"
                required
                placeholder="Booking Success Offer"
              />
              <FieldError state={state} name="display_name" />
            </div>
          </div>

          <div className="field-row">
            <div className="field">
              <label htmlFor="surface">Surface</label>
              <select
                id="surface"
                name="surface"
                value={surface}
                onChange={(e) => setSurface(e.target.value)}
              >
                <option value="web">Website</option>
                <option value="app">App</option>
              </select>
            </div>
            <div className="field">
              <label htmlFor="format">Format</label>
              <select id="format" name="format" defaultValue="native_card">
                <option value="native_card">Native card</option>
                <option value="banner">Banner</option>
              </select>
            </div>
            <div className="field">
              <label htmlFor="max_frequency_default">Default frequency cap</label>
              <input
                id="max_frequency_default"
                name="max_frequency_default"
                type="number"
                min="1"
                defaultValue="2"
              />
              <div className="field-hint">Per day, unless a request agrees otherwise.</div>
            </div>
          </div>

          <div className="field-row">
            <div className="field">
              <label htmlFor="width">Width (px)</label>
              <input id="width" name="width" type="number" min="1" placeholder="1200" />
            </div>
            <div className="field">
              <label htmlFor="height">Height (px)</label>
              <input id="height" name="height" type="number" min="1" placeholder="628" />
            </div>
            <div className="field">
              <label htmlFor="fallback">When no ad is served</label>
              <select id="fallback" name="fallback" defaultValue="HOUSE_CONTENT">
                <option value="HOUSE_CONTENT">Show your own content</option>
                <option value="EMPTY">Collapse the slot</option>
              </select>
              <div className="field-hint">
                An ad that fails must never block a checkout, a booking or a login.
              </div>
            </div>
          </div>

          <div className="field-row">
            <div className="field">
              <label htmlFor="context_tags">Context tags</label>
              <input id="context_tags" name="context_tags" placeholder="booking_success" />
              <div className="field-hint">Comma separated.</div>
            </div>
            <div className="field">
              <label htmlFor="p_blocked">Blocked categories</label>
              <input
                id="p_blocked"
                name="blocked_categories"
                placeholder="direct_travel_competitor"
              />
            </div>
          </div>

          <div className="btn-row">
            <SubmitButton pendingLabel="Creating…">Create placement</SubmitButton>
          </div>
        </>
      )}
    </ActionForm>
  );
}

export function PlacementStatusForm({
  placementId,
  status,
}: {
  placementId: string;
  status: string;
}) {
  const disabling = status === 'ACTIVE';
  const action = setPlacementStatus.bind(null, placementId, disabling ? 'DISABLED' : 'ACTIVE');

  return (
    <ActionForm action={action}>
      {(_state: ActionState) => (
        <SubmitButton className={disabling ? 'btn-danger' : ''} pendingLabel="Working…">
          {disabling ? 'Disable' : 'Enable'}
        </SubmitButton>
      )}
    </ActionForm>
  );
}

/* --- Agent identity (§92) --------------------------------------------------- */

export function BootstrapTokenForm() {
  return (
    <ActionForm action={createBootstrapToken}>
      {(state: TokenState) => (
        <>
          {state.token ? (
            <div className="notice notice-warn">
              <strong>Copy this now — it is shown once.</strong>
              <div style={{ margin: '0.5rem 0' }}>
                <code style={{ display: 'block', padding: '0.5rem', wordBreak: 'break-all' }}>
                  {state.token}
                </code>
              </div>
              Single-use, expires in 15 minutes. Oolix stores only its SHA-256, so it genuinely
              cannot be shown again.
            </div>
          ) : null}

          <p className="muted" style={{ marginTop: 0 }}>
            Hand this to the Agent on first start. It registers once, generates its own P-256
            keypair, and the private key never leaves your infrastructure.
          </p>

          <div className="btn-row">
            <SubmitButton pendingLabel="Minting…">Generate bootstrap token</SubmitButton>
          </div>
        </>
      )}
    </ActionForm>
  );
}

export function RevokeBootstrapTokensForm() {
  return (
    <ActionForm action={revokeBootstrapTokens}>
      {(_state: ActionState) => (
        <SubmitButton className="" pendingLabel="Revoking…">
          Revoke all unused tokens
        </SubmitButton>
      )}
    </ActionForm>
  );
}

export function RevokeAgentForm({ agentId }: { agentId: string }) {
  const action = revokeAgent.bind(null, agentId);

  return (
    <ActionForm action={action}>
      {(_state: ActionState) => (
        <>
          <div className="field">
            <label htmlFor={`revoke-${agentId}`}>Reason</label>
            <input id={`revoke-${agentId}`} name="reason" required minLength={3} />
            <div className="field-hint">
              Recorded in the audit trail. Revocation takes effect immediately, not when the
              15-minute token expires.
            </div>
          </div>
          <div className="btn-row">
            <SubmitButton className="btn-danger" pendingLabel="Revoking…">
              Revoke this Agent
            </SubmitButton>
          </div>
        </>
      )}
    </ActionForm>
  );
}

/* --- CRM connection (§71) --------------------------------------------------- */

export function CrmKeyForm({ hasKey }: { hasKey: boolean }) {
  return (
    <ActionForm action={issueCrmKey}>
      {(state: KeyState) => (
        <>
          {state.apiKey ? (
            <div className="notice notice-warn">
              <strong>Copy this now — it is shown once.</strong>
              <div style={{ margin: '0.5rem 0' }}>
                <code style={{ display: 'block', padding: '0.5rem', wordBreak: 'break-all' }}>
                  {state.apiKey}
                </code>
              </div>
              Oolix stores only its SHA-256.
            </div>
          ) : null}

          <p className="muted" style={{ marginTop: 0 }}>
            Your CRM uses this to report lead outcomes against the opaque click token. It never
            sends, and never needs, a Partner&rsquo;s customer identifier.
          </p>

          <div className="btn-row">
            <SubmitButton pendingLabel="Issuing…">
              {hasKey ? 'Rotate CRM API key' : 'Issue CRM API key'}
            </SubmitButton>
            {hasKey ? (
              <span className="faint">Rotating invalidates the previous key immediately.</span>
            ) : null}
          </div>
        </>
      )}
    </ActionForm>
  );
}

/* --- reconciliation (§77.3) -------------------------------------------------- */

export function ReconcileForm({ activationId }: { activationId: string }) {
  const action = reconcileActivation.bind(null, activationId);

  return (
    <ActionForm action={action}>
      {(state: ReconcileState) => (
        <>
          {state.result ? (
            <div
              className={
                state.result.status === 'PASS' ? 'notice notice-info' : 'notice notice-warn'
              }
            >
              <strong>{state.result.status.replaceAll('_', ' ').toLowerCase()}</strong> — your Agent
              counted {state.result.agent_count}, Oolix recorded {state.result.central_count}, a
              difference of {state.result.difference} against a tolerance of{' '}
              {state.result.tolerance}.
              {state.result.note ? (
                <div style={{ marginTop: '0.4rem' }}>{state.result.note}</div>
              ) : null}
            </div>
          ) : null}

          <div style={{ display: 'flex', gap: '0.6rem', alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <div className="field" style={{ marginBottom: 0, maxWidth: 200 }}>
              <label htmlFor={`agent-count-${activationId}`}>Your Agent&rsquo;s count</label>
              <input
                id={`agent-count-${activationId}`}
                name="agent_count"
                type="number"
                min="0"
                required
              />
            </div>
            <div className="field" style={{ marginBottom: 0, maxWidth: 180 }}>
              <label htmlFor={`recon-date-${activationId}`}>Day</label>
              <input id={`recon-date-${activationId}`} name="date" type="date" />
            </div>
            <SubmitButton className="" pendingLabel="Comparing…">
              Reconcile
            </SubmitButton>
          </div>

          <div className="field-hint" style={{ marginTop: '0.5rem' }}>
            Tolerance is the larger of 10 events or 0.5% of your count. A breach raises a review and
            does <strong>not</strong> change your payout.
          </div>
        </>
      )}
    </ActionForm>
  );
}
