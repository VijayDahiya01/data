'use client';

/**
 * Campaign builder screen 1: objective, basics, audience and the outcome
 * definition (§40.1, §40.2, §40.8; v6 §9 step 3).
 *
 * These are one form rather than several screens because the API creates the
 * draft in a single call, and because §40.8's lead definition is only
 * meaningful once the objective is known.
 *
 * A Buyer decides five things here: a name, the goal, who it is for, the
 * budget and the dates. Everything else -- brand, landing page, category,
 * purpose, currency, countries, what counts as a qualified lead -- has a
 * working default under "More options". Showing all sixteen fields up front
 * made the first screen read like a contract.
 *
 * The outcome fields appear only for objectives that settle on outcomes. §50
 * forbids paying a Partner on unverified clicks, so a CPQL campaign with no
 * definition of "qualified" has no settleable basis and the API rejects it.
 *
 * Fields under "More options" are required like the rest. A browser cannot
 * point at an empty field inside a closed <details>, but ActionForm's
 * CheckedForm does: it opens the section, moves to the field and says what to
 * fill in.
 */
import { useState } from 'react';
import Link from 'next/link';
import { createCampaign, type ActionState } from '@/lib/actions';
import { ActionForm, FieldError, SubmitButton } from './FormState';

export interface BrandOption {
  id: string;
  name: string;
  category?: string;
  landing_domain: string;
}

export interface AudienceOption {
  id: string;
  name: string;
}

const OBJECTIVES = [
  {
    value: 'QUALIFIED_LEADS',
    label: 'Qualified leads',
    hint: 'Pay for leads your CRM confirms',
    outcome: true,
    landing: true,
  },
  {
    value: 'CONVERSIONS',
    label: 'Conversions',
    hint: 'Pay for completed sales',
    outcome: true,
    landing: true,
  },
  {
    value: 'CLICKS',
    label: 'Website visits',
    hint: 'Send people to your site',
    outcome: false,
    landing: true,
  },
  {
    value: 'AWARENESS',
    label: 'Awareness',
    hint: 'Be seen by the right people',
    outcome: false,
    landing: false,
  },
] as const;

/** Fields under "More options" -- open it when the server objects to one. */
const MORE = [
  'brand_id',
  'landing_url',
  'category',
  'purpose_id',
  'currency',
  'geographies',
  'lead_definition',
];

function isoLocal(daysFromNow: number): string {
  const d = new Date(Date.now() + daysFromNow * 86_400_000);
  // `datetime-local` wants a local ISO string with no zone suffix.
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

/** "insurance" + QUALIFIED_LEADS -> "insurance_qualified_leads". */
function purposeFor(category: string, objective: string): string {
  const slug = category
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
  return `${slug || 'general'}_${objective.toLowerCase()}`;
}

export function CampaignBasicsForm({
  brands,
  audiences,
  audienceId,
}: {
  brands: BrandOption[];
  audiences: AudienceOption[];
  /** Preselected when the Buyer came from an audience's "Use in a campaign". */
  audienceId?: string;
}) {
  const [objective, setObjective] = useState<string>('QUALIFIED_LEADS');
  const [brandId, setBrandId] = useState<string>(brands[0]?.id ?? '');
  const brand = brands.find((b) => b.id === brandId);
  const [category, setCategory] = useState<string>(brand?.category ?? 'general');
  // The purpose follows the goal and category until the Buyer writes their own.
  const [purpose, setPurpose] = useState<string | null>(null);

  const selected = OBJECTIVES.find((o) => o.value === objective);

  return (
    <ActionForm action={createCampaign}>
      {(state: ActionState) => (
        <>
          <div className="field">
            <label htmlFor="name">Campaign name</label>
            <input id="name" name="name" required minLength={3} maxLength={120} />
            <FieldError state={state} name="name" />
          </div>

          <div className="field">
            <label>Goal</label>
            <div className="choice-cards">
              {OBJECTIVES.map((o) => (
                <label key={o.value} className="choice-card">
                  <input
                    type="radio"
                    name="objective"
                    value={o.value}
                    checked={objective === o.value}
                    onChange={() => setObjective(o.value)}
                  />
                  <span>
                    <strong>{o.label}</strong>
                    <span className="faint small">{o.hint}</span>
                  </span>
                </label>
              ))}
            </div>
          </div>

          <div className="field">
            <label htmlFor="audience_group_id">Who it is for</label>
            <select id="audience_group_id" name="audience_group_id" defaultValue={audienceId ?? ''}>
              <option value="">Choose later</option>
              {audiences.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
            <div className="field-hint">
              {audiences.length === 0 ? 'You have no audiences yet. ' : null}
              <Link href="/audiences/new">Build a new audience</Link>
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
              <FieldError state={state} name="budget_major" />
            </div>
            <div className="field">
              <label htmlFor="start_at">Starts</label>
              <input
                type="datetime-local"
                id="start_at"
                name="start_at"
                /* Starts now, not tomorrow. A campaign dated a day ahead is
                   approved, activated, and still serves nothing -- which reads
                   as a broken integration rather than as a campaign that has
                   not begun. */
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

          <details className="more" open={MORE.some((f) => state.fieldErrors?.[f]) || undefined}>
            <summary>More options</summary>

            <div className="field-row">
              <div className="field">
                <label htmlFor="brand_id">Brand</label>
                <select
                  id="brand_id"
                  name="brand_id"
                  value={brandId}
                  onChange={(e) => {
                    setBrandId(e.target.value);
                    const next = brands.find((b) => b.id === e.target.value);
                    if (next?.category) setCategory(next.category);
                  }}
                >
                  {brands.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </select>
                <div className="field-hint">
                  Partners see it when they decide. <Link href="/connections">Add a brand</Link>
                </div>
                <FieldError state={state} name="brand_id" />
              </div>

              <div className="field">
                <label htmlFor="category">Product category</label>
                <input
                  id="category"
                  name="category"
                  required
                  value={category}
                  onChange={(e) => setCategory(e.target.value)}
                />
                <div className="field-hint">Checked against each Partner&rsquo;s rules.</div>
                <FieldError state={state} name="category" />
              </div>
            </div>

            {selected?.landing ? (
              <div className="field">
                <label htmlFor="landing_url">Landing page</label>
                <input
                  // Remounted per brand, so the default follows the brand.
                  key={brandId}
                  id="landing_url"
                  name="landing_url"
                  type="url"
                  required
                  defaultValue={brand ? `https://${brand.landing_domain}/` : ''}
                />
                <div className="field-hint">
                  On <code>{brand?.landing_domain ?? 'your verified domain'}</code>, with no
                  personal data in the address.
                </div>
                <FieldError state={state} name="landing_url" />
              </div>
            ) : null}

            <div className="field">
              <label htmlFor="purpose_id">What is this campaign for?</label>
              <input
                id="purpose_id"
                name="purpose_id"
                required
                minLength={2}
                value={purpose ?? purposeFor(category, objective)}
                onChange={(e) => setPurpose(e.target.value)}
              />
              <div className="field-hint">
                Partners see this, and check their customers&rsquo; consent against it.
              </div>
              <FieldError state={state} name="purpose_id" />
            </div>

            <div className="field-row">
              <div className="field">
                <label htmlFor="currency">Currency</label>
                <select id="currency" name="currency" defaultValue="INR">
                  <option value="INR">INR</option>
                  <option value="USD">USD</option>
                  <option value="EUR">EUR</option>
                </select>
              </div>
              <div className="field">
                <label htmlFor="geographies">Countries</label>
                <input id="geographies" name="geographies" required defaultValue="IN" />
                <div className="field-hint">Country codes, comma separated.</div>
                <FieldError state={state} name="geographies" />
              </div>
            </div>

            {selected?.outcome ? (
              <fieldset>
                <legend>What you pay for</legend>
                <div className="field">
                  <label>Which leads count</label>
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
                      <strong>Qualified</strong> — confirmed interest
                    </span>
                  </label>
                  <label className="check">
                    <input type="checkbox" name="qualified_statuses" value="CONVERTED" />
                    <span>
                      <strong>Converted</strong> — bought
                    </span>
                  </label>
                  <FieldError state={state} name="lead_definition" />
                </div>

                <div className="field-row">
                  <div className="field">
                    <label htmlFor="duplicate_window_days">Ignore repeats within (days)</label>
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
                      placeholder="Contacted and confirmed interest"
                    />
                  </div>
                </div>
              </fieldset>
            ) : null}
          </details>

          <div className="btn-row">
            <SubmitButton pendingLabel="Saving…">Continue to the ad</SubmitButton>
            <span className="faint">Nothing is sent to anyone yet.</span>
          </div>
        </>
      )}
    </ActionForm>
  );
}
