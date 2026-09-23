'use client';

/**
 * Request one Partner against the campaign's linked audience — v6 §9 steps 5–7.
 *
 * The v5 form for this is `PartnerRequestForm`, which is built around a
 * Partner's prebuilt segment. This one carries no segment at all: the campaign
 * already names the audience, so what a Buyer chooses here is the Partner, the
 * channels, the budget and the creative.
 *
 * The reach estimate id is carried through as a hidden field. §9 freezes it
 * onto the request so the Partner approves against the same range the Buyer was
 * looking at when they chose them — not a fresher one computed later.
 */
import { useState } from 'react';
import { addPartnerRequest, type ActionState } from '@/lib/actions';
import { ActionForm, SubmitButton } from './FormState';
import type { CreativeChoice } from './PartnerRequestForm';

export interface AudienceMatchChoice {
  partner_org_id: string;
  partner_name: string;
  match_score: number;
  channels: { channel: string; status: string }[];
  reach_estimate: { reach_estimate_id: string; status: string; reach_bucket: string | null } | null;
}

const CHANNEL_LABELS: Record<string, string> = {
  PARTNER_WEB: 'Partner website',
  PARTNER_APP: 'Partner app',
  META: 'Meta',
  GOOGLE: 'Google',
};

export function AudiencePartnerRequestForm({
  campaignId,
  match,
  placements,
  creatives,
  currency,
}: {
  campaignId: string;
  match: AudienceMatchChoice;
  placements: { placement_id: string; display_name: string; surface: string; format: string }[];
  creatives: CreativeChoice[];
  currency: string;
}) {
  const action = addPartnerRequest.bind(null, campaignId);
  const [expansion, setExpansion] = useState(false);

  const selectable = match.channels.filter((c) => c.status === 'AVAILABLE');
  const gated = match.channels.filter((c) => c.status !== 'AVAILABLE');

  return (
    <ActionForm action={action}>
      {(_state: ActionState) => (
        <>
          <input type="hidden" name="partner_org_id" value={match.partner_org_id} />
          {/* No segment_id: §19's audience path. The campaign's frozen audience
              is the target, and the API resolves it from the campaign. */}
          {match.reach_estimate?.status === 'READY' ? (
            <input
              type="hidden"
              name="reach_estimate_id"
              value={match.reach_estimate.reach_estimate_id}
            />
          ) : null}

          <div className="field">
            <label>Channels</label>
            {selectable.length === 0 ? (
              <div className="faint small">
                This Partner has published no usable channel for an audience campaign.
              </div>
            ) : null}
            {selectable.map((c) => (
              <label className="check" key={c.channel}>
                <input
                  type="checkbox"
                  name="channels"
                  value={c.channel}
                  defaultChecked={c.channel === 'PARTNER_WEB'}
                />
                <span>{CHANNEL_LABELS[c.channel] ?? c.channel}</span>
              </label>
            ))}
            {gated.map((c) => (
              <label className="check" key={c.channel} style={{ opacity: 0.65 }}>
                <input type="checkbox" disabled />
                <span>
                  {CHANNEL_LABELS[c.channel] ?? c.channel}{' '}
                  <span className="badge badge-warn">{c.status.toLowerCase()}</span>
                  <br />
                  <span className="faint">
                    Available only once the eligibility check passes — a Partner declaring the
                    channel does not enable it.
                  </span>
                </span>
              </label>
            ))}
          </div>

          {placements.length > 0 ? (
            <div className="field">
              <label>Placements</label>
              {placements.map((p) => (
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
          ) : (
            <div className="notice notice-warn">
              This Partner has published no active placement, so a partner-owned channel cannot be
              requested yet.
            </div>
          )}

          <div className="field-row">
            <div className="field">
              <label htmlFor={`alloc-${match.partner_org_id}`}>Budget for this Partner</label>
              <input
                id={`alloc-${match.partner_org_id}`}
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
              <label htmlFor={`freq-${match.partner_org_id}`}>Frequency cap</label>
              <div style={{ display: 'flex', gap: '0.4rem' }}>
                <input
                  id={`freq-${match.partner_org_id}`}
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

          <div className="field-row">
            <div className="field">
              <label htmlFor={`payout-model-${match.partner_org_id}`}>Payout basis</label>
              <select
                id={`payout-model-${match.partner_org_id}`}
                name="payout_model"
                defaultValue="CPQL"
              >
                {['CPM', 'CPC', 'CPL', 'CPQL', 'FIXED'].map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
              <div className="field-hint">What this Partner is paid on.</div>
            </div>
            <div className="field">
              <label htmlFor={`payout-price-${match.partner_org_id}`}>Unit price</label>
              <input
                id={`payout-price-${match.partner_org_id}`}
                name="payout_unit_price_major"
                type="number"
                min="0"
                step="0.01"
                defaultValue="4000"
              />
              <div className="field-hint">
                The Partner still has to accept it. Nothing is paid out without an agreed basis.
              </div>
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
              Request audience expansion / lookalikes
              <br />
              <span className="faint">
                Off unless the Partner explicitly grants it. Your audience rules define who is
                targeted; expansion asks the Partner to go beyond them.
              </span>
            </span>
          </label>

          <SubmitButton pendingLabel="Adding…">Add {match.partner_name}</SubmitButton>
        </>
      )}
    </ActionForm>
  );
}
