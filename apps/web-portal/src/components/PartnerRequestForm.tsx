'use client';

/**
 * Campaign builder steps 4, 5 and 6 for ONE Partner (§40.4–40.6).
 *
 * §40.4: "One parent campaign may contain 1-N Partner requests" and "every
 * Partner receives only its own request". So this form is repeated per chosen
 * segment rather than collecting every Partner into one submission — the
 * requests really are separate objects with separate decisions.
 *
 * §40.5: each selected channel becomes its own activation. Selecting web and
 * app here produces two activations, never one that spans both.
 */
import { useState } from 'react';
import { addPartnerRequest, type ActionState } from '@/lib/actions';
import { ActionForm, SubmitButton } from './FormState';

export interface SegmentChoice {
  segment_id: string;
  display_name: string;
  partner: { id: string; display_name: string };
  reach_bucket: string | null;
  channels: { type: string; status: string; reason?: string | null }[];
  placements?: { placement_id: string; display_name: string; surface: string; format: string }[];
  pricing?: { model?: string; indicative_unit_price_minor?: number; currency?: string } | null;
}

export interface CreativeChoice {
  creative_version_id: string;
  version: number;
  type: string;
}

const CHANNEL_LABELS: Record<string, string> = {
  PARTNER_WEB: 'Partner website',
  PARTNER_APP: 'Partner app',
  META: 'Meta',
  GOOGLE: 'Google',
};

export function PartnerRequestForm({
  campaignId,
  segment,
  creatives,
  currency,
}: {
  campaignId: string;
  segment: SegmentChoice;
  creatives: CreativeChoice[];
  currency: string;
}) {
  const action = addPartnerRequest.bind(null, campaignId);
  const [expansion, setExpansion] = useState(false);

  // §40.5: an external channel is CONDITIONAL until the eligibility gate
  // passes, and NOT_OFFERED while its feature flag is off (§84). Neither is
  // selectable, and saying why is more useful than hiding the row.
  const selectable = segment.channels.filter((c) => c.status === 'AVAILABLE');
  const gated = segment.channels.filter((c) => c.status !== 'AVAILABLE');

  return (
    <ActionForm action={action}>
      {(_state: ActionState) => (
        <>
          <input type="hidden" name="segment_id" value={segment.segment_id} />
          <input type="hidden" name="partner_org_id" value={segment.partner.id} />

          <div className="field">
            <label>Step 5 · Channels</label>
            {selectable.map((c) => (
              <label className="check" key={c.type}>
                <input
                  type="checkbox"
                  name="channels"
                  value={c.type}
                  defaultChecked={c.type === 'PARTNER_WEB'}
                />
                <span>{CHANNEL_LABELS[c.type] ?? c.type}</span>
              </label>
            ))}
            {gated.map((c) => (
              <label className="check" key={c.type} style={{ opacity: 0.65 }}>
                <input type="checkbox" disabled />
                <span>
                  {CHANNEL_LABELS[c.type] ?? c.type}{' '}
                  <span className="badge badge-warn">{c.status.toLowerCase()}</span>
                  <br />
                  <span className="faint">
                    {c.status === 'NOT_OFFERED'
                      ? 'Disabled until account eligibility is proven for this Partner and Buyer.'
                      : 'Available only once the eligibility check passes — approval alone does not enable it.'}
                  </span>
                </span>
              </label>
            ))}
          </div>

          {segment.placements?.length ? (
            <div className="field">
              <label>Placements</label>
              {segment.placements.map((p) => (
                <label className="check" key={p.placement_id}>
                  <input
                    type="checkbox"
                    name="placement_ids"
                    value={p.placement_id}
                    defaultChecked
                  />
                  <span>
                    {p.display_name}{' '}
                    <span className="faint">
                      · {p.surface} · {p.format.replaceAll('_', ' ')}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          ) : null}

          <div className="field-row">
            <div className="field">
              <label htmlFor={`alloc-${segment.segment_id}`}>
                Step 6 · Budget for this Partner
              </label>
              <input
                id={`alloc-${segment.segment_id}`}
                name="allocation_major"
                type="number"
                min="1"
                step="0.01"
                required
                defaultValue="100000"
              />
              <div className="field-hint">
                {currency}. Every Partner needs a budget of its own before you can submit.
              </div>
            </div>

            <div className="field">
              <label htmlFor={`freq-${segment.segment_id}`}>Frequency cap</label>
              <div style={{ display: 'flex', gap: '0.4rem' }}>
                <input
                  id={`freq-${segment.segment_id}`}
                  name="freq_max"
                  type="number"
                  min="1"
                  max="100"
                  defaultValue="2"
                />
                <select name="freq_window" defaultValue="P1D">
                  <option value="P1D">per day</option>
                  <option value="P7D">per week</option>
                  <option value="PT1H">per hour</option>
                </select>
              </div>
              <div className="field-hint">Enforced inside the Partner, per activation.</div>
            </div>
          </div>

          <div className="field">
            <label>Creative versions to request</label>
            {creatives.map((c) => (
              <label className="check" key={c.creative_version_id}>
                <input
                  type="checkbox"
                  name="creative_version_ids"
                  value={c.creative_version_id}
                  defaultChecked
                />
                <span>
                  v{c.version}{' '}
                  <span className="faint">· {c.type.replaceAll('_', ' ').toLowerCase()}</span>
                </span>
              </label>
            ))}
            <div className="field-hint">The Partner may approve a subset of these.</div>
          </div>

          {segment.pricing?.model ? (
            <div className="field-row">
              <div className="field">
                <label htmlFor={`payout-model-${segment.segment_id}`}>Payout basis</label>
                <select
                  id={`payout-model-${segment.segment_id}`}
                  name="payout_model"
                  defaultValue={segment.pricing.model}
                >
                  {['CPM', 'CPC', 'CPL', 'CPQL', 'FIXED'].map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
                <div className="field-hint">
                  What this Partner is paid on. Proposed from their published price.
                </div>
              </div>
              <div className="field">
                <label htmlFor={`payout-price-${segment.segment_id}`}>Unit price</label>
                <input
                  id={`payout-price-${segment.segment_id}`}
                  name="payout_unit_price_major"
                  type="number"
                  min="0"
                  step="0.01"
                  defaultValue={
                    segment.pricing.indicative_unit_price_minor
                      ? segment.pricing.indicative_unit_price_minor / 100
                      : undefined
                  }
                />
                <div className="field-hint">
                  The Partner still has to accept it. Nothing is paid out without an agreed basis.
                </div>
              </div>
            </div>
          ) : null}

          <label className="check">
            <input
              type="checkbox"
              name="audience_expansion_allowed"
              checked={expansion}
              onChange={(e) => setExpansion(e.target.checked)}
            />
            <span>
              Request audience expansion / lookalikes
              <br />
              <span className="faint">
                Off unless the Partner explicitly grants it. Asking does not make it happen.
              </span>
            </span>
          </label>

          <div className="btn-row">
            <SubmitButton pendingLabel="Adding…">Add {segment.partner.display_name}</SubmitButton>
          </div>
        </>
      )}
    </ActionForm>
  );
}
