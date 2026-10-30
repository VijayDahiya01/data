'use client';

/**
 * Choose the Partners for a campaign and submit -- v6 §9 steps 5-7 and 10 in
 * one screen.
 *
 * Every Partner that can evaluate the audience is listed and ticked, with the
 * budget split evenly between the ticked ones. Untick a Partner and the split
 * follows; type a budget and it stays as typed. Channels, placements,
 * frequency and payment take the defaults `submitWithPartners` documents;
 * anyone who wants different ones customises a Partner below this form.
 *
 * Reach shows per Partner and is never added up (§17): the same person can be
 * in two Partners' audiences.
 */
import { useState } from 'react';
import { submitWithPartners } from '@/lib/actions';
import { ActionForm, SubmitButton } from './FormState';
import { reachLabel } from './reach';

export interface PickablePartner {
  partner_org_id: string;
  partner_name: string;
  reach_bucket: string | null;
  estimate_status: string | null;
}

function split(totalMinor: number, ids: string[]): Record<string, string> {
  if (ids.length === 0) return {};
  const each = Math.floor(totalMinor / ids.length / 100);
  return Object.fromEntries(ids.map((id) => [id, String(each)]));
}

export function PartnerPicker({
  campaignId,
  partners,
  alreadyAdded,
  unallocatedMinor,
  currency,
  payment,
  blocked,
}: {
  campaignId: string;
  partners: PickablePartner[];
  /** Partners already on the campaign: submitting sends to them as well. */
  alreadyAdded: number;
  unallocatedMinor: number;
  currency: string;
  /** How the Partners are paid, in words: "₹4,000 per qualified lead". */
  payment: string;
  /** Why nothing can be submitted yet, if something stands in the way. */
  blocked: string | null;
}) {
  const action = submitWithPartners.bind(null, campaignId);
  const [ticked, setTicked] = useState<string[]>(partners.map((p) => p.partner_org_id));
  const [budgets, setBudgets] = useState<Record<string, string>>(() =>
    split(unallocatedMinor, ticked),
  );
  const [typed, setTyped] = useState(false);

  const toggle = (id: string, on: boolean) => {
    const next = on ? [...ticked, id] : ticked.filter((t) => t !== id);
    setTicked(next);
    if (!typed) setBudgets(split(unallocatedMinor, next));
  };

  const totalMajor = ticked.reduce((s, id) => s + (Number(budgets[id]) || 0), 0);
  const sending = ticked.length + alreadyAdded;
  const fmt = new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency,
    maximumFractionDigits: 0,
  });

  return (
    <ActionForm action={action}>
      {() => (
        <>
          {partners.length > 0 ? (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Partner</th>
                    <th>Can reach</th>
                    <th>Budget ({currency})</th>
                  </tr>
                </thead>
                <tbody>
                  {partners.map((p) => {
                    const on = ticked.includes(p.partner_org_id);
                    return (
                      <tr key={p.partner_org_id}>
                        <td>
                          <label className="check" style={{ margin: 0 }}>
                            <input
                              type="checkbox"
                              name="partner_org_ids"
                              value={p.partner_org_id}
                              checked={on}
                              onChange={(e) => toggle(p.partner_org_id, e.target.checked)}
                            />
                            <span>{p.partner_name}</span>
                          </label>
                        </td>
                        <td className="muted">{reachLabel(p.reach_bucket, p.estimate_status)}</td>
                        <td>
                          <input
                            name={`budget_${p.partner_org_id}`}
                            type="number"
                            min="1"
                            step="0.01"
                            disabled={!on}
                            required={on}
                            value={on ? (budgets[p.partner_org_id] ?? '') : ''}
                            onChange={(e) => {
                              setTyped(true);
                              setBudgets({ ...budgets, [p.partner_org_id]: e.target.value });
                            }}
                            aria-label={`Budget for ${p.partner_name}`}
                            style={{ maxWidth: '10rem' }}
                          />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : null}

          {typed && ticked.length > 1 ? (
            <button
              type="button"
              className="btn-ghost btn-sm"
              onClick={() => {
                setTyped(false);
                setBudgets(split(unallocatedMinor, ticked));
              }}
            >
              Split evenly again
            </button>
          ) : null}

          <p className="muted" style={{ margin: '1rem 0 0.25rem' }}>
            {sending === 0
              ? 'Tick at least one Partner.'
              : `Sending to ${sending} Partner${sending === 1 ? '' : 's'}` +
                (ticked.length
                  ? ` · ${fmt.format(totalMajor)}${alreadyAdded ? ' more' : ' in total'}`
                  : '') +
                ` · paid ${payment}. Each decides on its own within 7 days.`}
          </p>
          <p className="faint small" style={{ marginTop: 0 }}>
            Reach is a range per Partner and is never added up: one person can be with two Partners.
          </p>

          {blocked ? <div className="notice notice-warn">{blocked}</div> : null}

          <div className="btn-row">
            {blocked || sending === 0 ? (
              <button type="button" className="btn-primary" disabled>
                Submit for Partner review
              </button>
            ) : (
              <SubmitButton pendingLabel="Submitting…">Submit for Partner review</SubmitButton>
            )}
          </div>
        </>
      )}
    </ActionForm>
  );
}
