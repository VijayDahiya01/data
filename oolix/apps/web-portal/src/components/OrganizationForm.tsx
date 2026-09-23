'use client';

/**
 * Organization setup (§35.2).
 *
 * The type choice is the consequential one: it decides whether this
 * organization buys media, supplies audiences, or both. §34 requires that
 * "both" be one account with one login rather than two, which is why it is an
 * option here rather than something to sort out later.
 */
import { createOrganization, type ActionState } from '@/lib/actions';
import { ActionForm, FieldError, SubmitButton } from './FormState';

const TYPES = [
  { value: 'BUYER', label: 'Buyer — I want to run campaigns' },
  { value: 'DATA_PARTNER', label: 'Data Partner — I have an audience and placements' },
  { value: 'BUYER_AND_PARTNER', label: 'Both' },
  { value: 'NETWORK_SPONSOR', label: 'Network sponsor — I curate a portfolio' },
  { value: 'AGENCY', label: 'Agency' },
];

export function OrganizationForm() {
  return (
    <ActionForm action={createOrganization}>
      {(state: ActionState) => (
        <>
          <div className="field">
            <label htmlFor="org_name">Company name</label>
            <input id="org_name" name="name" required minLength={2} maxLength={200} />
            <div className="field-hint">Appears on campaign approvals and invoices.</div>
            <FieldError state={state} name="name" />
          </div>

          <div className="field-row">
            <div className="field">
              <label htmlFor="domain">Company domain</label>
              <input id="domain" name="domain" required placeholder="example.com" />
              <div className="field-hint">Used for verification and network trust.</div>
              <FieldError state={state} name="domain" />
            </div>

            <div className="field">
              <label htmlFor="country">Country</label>
              <input id="country" name="country" required maxLength={2} defaultValue="IN" />
              <div className="field-hint">Two-letter code. Sets currency and legal defaults.</div>
              <FieldError state={state} name="country" />
            </div>
          </div>

          <div className="field">
            <label htmlFor="type">Organization type</label>
            <select id="type" name="type" required defaultValue="BUYER">
              {TYPES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
            <div className="field-hint">
              You can be both. Switching between them never needs a second account.
            </div>
            <FieldError state={state} name="type" />
          </div>

          <div className="field-row">
            <div className="field">
              <label htmlFor="industry">Industry</label>
              <input id="industry" name="industry" placeholder="insurance" />
            </div>
            <div className="field">
              <label htmlFor="tax_id">Tax / GST ID</label>
              <input id="tax_id" name="tax_id" />
              <div className="field-hint">Needed before invoicing where it applies.</div>
            </div>
          </div>

          <div className="btn-row">
            <SubmitButton pendingLabel="Creating…">Create organization</SubmitButton>
          </div>
        </>
      )}
    </ActionForm>
  );
}
