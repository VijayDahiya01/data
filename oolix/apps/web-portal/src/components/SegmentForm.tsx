'use client';

/**
 * Publish a segment (§38.1, §72).
 *
 * Read the fields below and notice what is missing: there is no member list, no
 * rule builder, no query. §38.1 — "Oolix receives only metadata. The exact
 * member list remains local" — means the audience itself is built and evaluated
 * inside the Partner's own systems. This form describes one that already exists
 * there.
 *
 * `internal_segment_id` is the entire link between the two worlds. The Agent
 * uses it to resolve membership locally; Oolix only ever passes it back inside
 * a signed manifest.
 */
import { createSegment, type ActionState } from '@/lib/actions';
import { ActionForm, FieldError, SubmitButton } from './FormState';

const CHANNELS = [
  { value: 'PARTNER_WEB', label: 'Your website' },
  { value: 'PARTNER_APP', label: 'Your app' },
  { value: 'META', label: 'Meta (external)' },
  { value: 'GOOGLE', label: 'Google (external)' },
];

const FREQUENCIES = ['15m', 'hourly', '6h', 'daily', 'weekly'];

export function SegmentForm() {
  return (
    <ActionForm action={createSegment}>
      {(state: ActionState) => (
        <>
          <fieldset>
            <legend>Link to your own segment</legend>

            <div className="field">
              <label htmlFor="internal_segment_id">Your segment key</label>
              <input
                id="internal_segment_id"
                name="internal_segment_id"
                required
                placeholder="RECENT_TRAVELLER_60D"
              />
              <div className="field-hint">
                The key your own systems already use. Your Agent resolves membership by this value
                against your database — Oolix never sees who is in it.
              </div>
              <FieldError state={state} name="internal_segment_id" />
            </div>

            <div className="field">
              <label htmlFor="reach_exact_local">Current member count</label>
              <input
                id="reach_exact_local"
                name="reach_exact_local"
                type="number"
                min="0"
                required
                placeholder="213418"
              />
              <div className="field-hint">
                <strong>Used once, then discarded.</strong> It only decides which published range
                Buyers see. It is not stored on the segment and never appears in any Buyer-facing
                response.
              </div>
              <FieldError state={state} name="reach_exact_local" />
            </div>
          </fieldset>

          <fieldset>
            <legend>What Buyers will see</legend>

            <div className="field-row">
              <div className="field">
                <label htmlFor="display_name">Display name</label>
                <input
                  id="display_name"
                  name="display_name"
                  required
                  placeholder="Recent Travellers"
                />
                <FieldError state={state} name="display_name" />
              </div>
              <div className="field">
                <label htmlFor="category">Category</label>
                <input id="category" name="category" required placeholder="travel_intent" />
                <FieldError state={state} name="category" />
              </div>
            </div>

            <div className="field">
              <label htmlFor="description">Description</label>
              <textarea
                id="description"
                name="description"
                rows={2}
                required
                placeholder="Completed a booking in the previous 60 days"
              />
              <div className="field-hint">
                Describe the group, not the people in it. This is Buyer-visible.
              </div>
              <FieldError state={state} name="description" />
            </div>

            <div className="field-row">
              <div className="field">
                <label htmlFor="geographies">Geographies</label>
                <input id="geographies" name="geographies" required defaultValue="IN" />
                <div className="field-hint">Comma separated.</div>
                <FieldError state={state} name="geographies" />
              </div>
              <div className="field">
                <label htmlFor="refresh_frequency">Refresh frequency</label>
                <select id="refresh_frequency" name="refresh_frequency" defaultValue="daily">
                  {FREQUENCIES.map((f) => (
                    <option key={f} value={f}>
                      {f}
                    </option>
                  ))}
                </select>
                <div className="field-hint">How often you recompute it on your side.</div>
              </div>
              <div className="field">
                <label htmlFor="consent_eligibility">Consent</label>
                <select id="consent_eligibility" name="consent_eligibility" defaultValue="ELIGIBLE">
                  <option value="ELIGIBLE">Eligible</option>
                  <option value="MIXED">Mixed</option>
                  <option value="UNAVAILABLE">Unavailable</option>
                </select>
                <div className="field-hint">
                  Your Agent re-checks consent per person at decision time regardless, and fails
                  closed.
                </div>
              </div>
            </div>
          </fieldset>

          <fieldset>
            <legend>What you allow</legend>

            <div className="field">
              <label>Channels this segment may be used on</label>
              {CHANNELS.map((c) => (
                <label className="check" key={c.value}>
                  <input
                    type="checkbox"
                    name="allowed_channels"
                    value={c.value}
                    defaultChecked={c.value === 'PARTNER_WEB'}
                  />
                  <span>
                    {c.label}
                    {c.value === 'META' || c.value === 'GOOGLE' ? (
                      <>
                        <br />
                        <span className="faint">
                          Listing it does not enable it. External channels stay behind a feature
                          flag and an eligibility check.
                        </span>
                      </>
                    ) : null}
                  </span>
                </label>
              ))}
              <FieldError state={state} name="allowed_channels" />
            </div>

            <div className="field-row">
              <div className="field">
                <label htmlFor="allowed_categories">Allowed advertiser categories</label>
                <input
                  id="allowed_categories"
                  name="allowed_categories"
                  placeholder="insurance, hotel"
                />
                <div className="field-hint">Comma separated. Leave blank to allow any.</div>
              </div>
              <div className="field">
                <label htmlFor="blocked_categories">Blocked categories</label>
                <input
                  id="blocked_categories"
                  name="blocked_categories"
                  placeholder="direct_travel_competitor"
                />
                <div className="field-hint">Checked on every request against your policy.</div>
              </div>
            </div>
          </fieldset>

          <fieldset>
            <legend>Listing and price</legend>
            <p className="faint" style={{ marginTop: 0 }}>
              Buyers find an audience through its listing, not simply because it is published.
              Without one it exists and nobody can see it — so this is required. The price is a
              guide: you still approve or refuse every request yourself.
            </p>

            <div className="field-row">
              <div className="field">
                <label htmlFor="pricing_model">Pricing model</label>
                <select id="pricing_model" name="pricing_model" required defaultValue="CPQL">
                  {['CPM', 'CPC', 'CPL', 'CPQL', 'FIXED'].map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor="unit_price_major">Unit price</label>
                <input
                  id="unit_price_major"
                  name="unit_price_major"
                  type="number"
                  min="0"
                  step="0.01"
                  required
                  placeholder="4500"
                />
              </div>
              <div className="field">
                <label htmlFor="currency">Currency</label>
                <select id="currency" name="currency" defaultValue="INR">
                  <option value="INR">INR</option>
                  <option value="USD">USD</option>
                  <option value="EUR">EUR</option>
                </select>
              </div>
              <div className="field">
                <label htmlFor="visibility">Visible to</label>
                <select id="visibility" name="visibility" defaultValue="MARKETPLACE">
                  <option value="MARKETPLACE">Any verified Buyer</option>
                  <option value="CURATED">Curated Buyers</option>
                  <option value="PRIVATE_NETWORK">My private network only</option>
                </select>
                <div className="field-hint">
                  Who can find it. Narrower is always available — this only decides discovery, never
                  approval.
                </div>
              </div>
            </div>
          </fieldset>

          <div className="btn-row">
            <SubmitButton pendingLabel="Saving…">Save as draft</SubmitButton>
            <span className="faint">
              Saved as a draft. It becomes discoverable only once you report a refresh and publish
              it.
            </span>
          </div>
        </>
      )}
    </ActionForm>
  );
}
