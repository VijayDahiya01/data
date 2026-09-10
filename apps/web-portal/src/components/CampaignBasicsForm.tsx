'use client';

/**
 * Campaign builder steps 1, 2 and 8 (§40.1, §40.2, §40.8).
 *
 * These three are one form rather than three screens because the API creates
 * the draft in a single call, and because §40.8's lead definition is only
 * meaningful once the objective is known — splitting them would mean asking
 * for the objective, navigating away, and coming back to define its outcome.
 *
 * The outcome fields appear only for objectives that settle on outcomes. §50
 * forbids paying a Partner on unverified clicks, so a CPQL campaign with no
 * definition of "qualified" has no settleable basis and the API rejects it.
 */
import { useState } from 'react';
import { createCampaign, type ActionState } from '@/lib/actions';
import { ActionForm, FieldError, SubmitButton } from './FormState';

export interface BrandOption {
  id: string;
  name: string;
  landing_domain: string;
}

const OBJECTIVES = [
  { value: 'QUALIFIED_LEADS', label: 'Qualified leads', outcome: true, landing: true },
  { value: 'CONVERSIONS', label: 'Conversions', outcome: true, landing: true },
  { value: 'CLICKS', label: 'Clicks / traffic', outcome: false, landing: true },
  { value: 'AWARENESS', label: 'Awareness', outcome: false, landing: false },
] as const;

function isoLocal(daysFromNow: number): string {
  const d = new Date(Date.now() + daysFromNow * 86_400_000);
  // `datetime-local` wants a local ISO string with no zone suffix.
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

export function CampaignBasicsForm({ brands }: { brands: BrandOption[] }) {
  const [objective, setObjective] = useState<string>('QUALIFIED_LEADS');
  const [brandId, setBrandId] = useState<string>(brands[0]?.id ?? '');

  const selected = OBJECTIVES.find((o) => o.value === objective);
  const brand = brands.find((b) => b.id === brandId);

  return (
    <ActionForm action={createCampaign}>
      {(state: ActionState) => (
        <>
          <fieldset>
            <legend>Step 1 · Objective</legend>
            <div className="field">
              <label htmlFor="objective">What should this campaign achieve?</label>
              <select
                id="objective"
                name="objective"
                value={objective}
                onChange={(e) => setObjective(e.target.value)}
              >
                {OBJECTIVES.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
              <div className="field-hint">
                {selected?.outcome
                  ? 'Settles on outcomes your CRM confirms, so you will define what counts as qualified in step 8.'
                  : 'Settles on delivery. A frequency cap and Partner approval still apply.'}
              </div>
            </div>
          </fieldset>

          <fieldset>
            <legend>Step 2 · Campaign basics</legend>

            <div className="field">
              <label htmlFor="name">Campaign name</label>
              <input id="name" name="name" required minLength={3} maxLength={120} />
              <FieldError state={state} name="name" />
            </div>

            <div className="field-row">
              <div className="field">
                <label htmlFor="brand_id">Brand</label>
                <select
                  id="brand_id"
                  name="brand_id"
                  required
                  value={brandId}
                  onChange={(e) => setBrandId(e.target.value)}
                >
                  {brands.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </select>
                <div className="field-hint">
                  The Partner sees this when deciding whether to accept.
                </div>
                <FieldError state={state} name="brand_id" />
              </div>

              <div className="field">
                <label htmlFor="category">Product category</label>
                <input
                  id="category"
                  name="category"
                  required
                  placeholder="insurance"
                  defaultValue="insurance"
                />
                <div className="field-hint">Checked against each Partner&rsquo;s policy.</div>
                <FieldError state={state} name="category" />
              </div>
            </div>

            <div className="field">
              <label htmlFor="purpose_id">Purpose</label>
              <input
                id="purpose_id"
                name="purpose_id"
                required
                placeholder="travel_insurance_offer"
                defaultValue="travel_insurance_offer"
              />
              <div className="field-hint">
                Say what this campaign is for. Each Data Partner checks their customers&rsquo;
                consent against that stated purpose — nobody is marked permanently
                &ldquo;eligible&rdquo;.
              </div>
              <FieldError state={state} name="purpose_id" />
            </div>

            <div className="field-row">
              <div className="field">
                <label htmlFor="start_at">Starts</label>
                <input
                  type="datetime-local"
                  id="start_at"
                  name="start_at"
                  /* Starts now, not tomorrow. A campaign dated a day ahead is
                     approved, activated, and still serves nothing — which reads
                     as a broken integration rather than as a campaign that has
                     not begun. Anyone planning ahead can move the date; nobody
                     wants a default that guarantees silence on day one. */
                  required
                  defaultValue={isoLocal(0)}
                />
                <FieldError state={state} name="start_at" />
              </div>
              <div className="field">
                <label htmlFor="end_at">Ends</label>
                <input
                  type="datetime-local"
                  id="end_at"
                  name="end_at"
                  required
                  defaultValue={isoLocal(60)}
                />
                <FieldError state={state} name="end_at" />
              </div>
            </div>

            <div className="field-row">
              <div className="field">
                <label htmlFor="budget_major">Total budget</label>
                <input
                  id="budget_major"
                  name="budget_major"
                  type="number"
                  min="1"
                  step="0.01"
                  required
                  defaultValue="500000"
                />
                <div className="field-hint">
                  The most this campaign may spend in total, across every Data Partner.
                </div>
                <FieldError state={state} name="budget_major" />
              </div>
              <div className="field">
                <label htmlFor="currency">Currency</label>
                <select id="currency" name="currency" defaultValue="INR">
                  <option value="INR">INR</option>
                  <option value="USD">USD</option>
                  <option value="EUR">EUR</option>
                </select>
                <div className="field-hint">Fixed for the life of the campaign.</div>
              </div>
              <div className="field">
                <label htmlFor="geographies">Geographies</label>
                <input id="geographies" name="geographies" required defaultValue="IN" />
                <div className="field-hint">Comma separated. Must overlap the segment.</div>
                <FieldError state={state} name="geographies" />
              </div>
            </div>

            {selected?.landing ? (
              <div className="field">
                <label htmlFor="landing_url">Landing URL</label>
                <input
                  id="landing_url"
                  name="landing_url"
                  type="url"
                  required
                  defaultValue={brand ? `https://${brand.landing_domain}/quote` : ''}
                />
                <div className="field-hint">
                  HTTPS, on <code>{brand?.landing_domain ?? 'your verified domain'}</code>, and with
                  no personal data in the query string.
                </div>
                <FieldError state={state} name="landing_url" />
              </div>
            ) : null}
          </fieldset>

          {selected?.outcome ? (
            <fieldset>
              <legend>Step 8 · Lead and conversion definition</legend>
              <p className="faint" style={{ marginTop: 0 }}>
                This is what a Partner is paid on, so it is agreed before the campaign runs rather
                than argued about afterwards.
              </p>

              <div className="field">
                <label>Which lead states count as payable?</label>
                <label className="check">
                  <input type="checkbox" name="qualified_statuses" value="VALID" />
                  <span>
                    <strong>Valid</strong> — reachable contact, not a duplicate
                  </span>
                </label>
                <label className="check">
                  <input
                    type="checkbox"
                    name="qualified_statuses"
                    value="QUALIFIED"
                    defaultChecked
                  />
                  <span>
                    <strong>Qualified</strong> — confirmed interest and product qualification
                  </span>
                </label>
                <label className="check">
                  <input type="checkbox" name="qualified_statuses" value="CONVERTED" />
                  <span>
                    <strong>Converted</strong> — policy purchased or transaction completed
                  </span>
                </label>
                <FieldError state={state} name="lead_definition" />
              </div>

              <div className="field-row">
                <div className="field">
                  <label htmlFor="duplicate_window_days">Duplicate window (days)</label>
                  <input
                    id="duplicate_window_days"
                    name="duplicate_window_days"
                    type="number"
                    min="1"
                    max="365"
                    defaultValue="30"
                  />
                </div>
                <div className="field">
                  <label htmlFor="qualified_lead_rule">What makes a lead qualified?</label>
                  <input
                    id="qualified_lead_rule"
                    name="qualified_lead_rule"
                    maxLength={500}
                    placeholder="Contacted and confirmed travel in the next 90 days"
                  />
                </div>
              </div>

              <p className="faint" style={{ marginBottom: 0 }}>
                Your CRM reports these against an opaque click token. It never receives, and never
                needs, a Partner&rsquo;s customer identifier.
              </p>
            </fieldset>
          ) : null}

          <div className="btn-row">
            <SubmitButton pendingLabel="Creating draft…">
              Create draft and choose audiences
            </SubmitButton>
            <span className="faint">Steps 3–7 come next. Nothing is submitted yet.</span>
          </div>
        </>
      )}
    </ActionForm>
  );
}
