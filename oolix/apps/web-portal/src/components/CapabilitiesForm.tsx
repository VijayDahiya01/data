'use client';

/**
 * Publish what this Data Partner can evaluate — v6 §5.1, §18.2.
 *
 * Read the fields and notice what is absent: there is no box for a column
 * name, a table name, or a query. §5.2 keeps the translation from
 * `payment_method` to whatever this Partner actually stores inside the Agent's
 * own config file, and §17 says Oolix holds capability metadata, "not Partner
 * customer records or Partner local field names".
 *
 * So ticking a box here says "we can answer questions about payment method".
 * It never says how, and there is nowhere on this form to say it.
 */
import { useState } from 'react';
import type { ActionState } from '@/lib/actions';
import { publishCapabilities } from '@/lib/actions-audience';
import { ActionForm, FieldError, SubmitButton } from './FormState';
import type { TaxonomyAttribute } from './AudienceBuilder';

const CATEGORY_LABELS: Record<string, string> = {
  DEMOGRAPHIC: 'Demographic',
  GEOGRAPHY: 'Geography',
  COMMERCE: 'Commerce',
  PAYMENT_BEHAVIOUR: 'Payment behaviour',
  TRAVEL: 'Travel',
  ENGAGEMENT: 'Engagement',
};

const CHANNELS = [
  { value: 'PARTNER_WEB', label: 'Your website' },
  { value: 'PARTNER_APP', label: 'Your app' },
];

export function CapabilitiesForm({
  attributes,
  selectedKeys,
  geographies,
  channels,
  mappingVersion,
}: {
  attributes: TaxonomyAttribute[];
  selectedKeys: string[];
  geographies: string[];
  channels: string[];
  mappingVersion: number | null;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set(selectedKeys));

  const byCategory = attributes.reduce<Record<string, TaxonomyAttribute[]>>((acc, a) => {
    (acc[a.category] ??= []).push(a);
    return acc;
  }, {});

  return (
    <ActionForm action={publishCapabilities}>
      {(state: ActionState) => (
        <>
          {state.ok ? (
            <div className="notice notice-info">
              Published. Buyers matching an audience will now see you for these attributes.
            </div>
          ) : null}

          <fieldset>
            <legend>Attributes you can evaluate</legend>
            <div className="field-hint">
              Tick only what you can actually answer. Claiming more causes failed estimates.
            </div>

            {Object.entries(byCategory).map(([category, list]) => (
              <div key={category} className="field">
                <strong>{CATEGORY_LABELS[category] ?? category}</strong>
                {list.map((a) => (
                  <label key={a.key} className="check">
                    <input
                      type="checkbox"
                      name="attributes"
                      // The operators ride along so a Partner cannot claim one
                      // the taxonomy does not define for that attribute.
                      value={`${a.key}|${a.operators.join(',')}`}
                      checked={selected.has(a.key)}
                      onChange={(e) => {
                        const next = new Set(selected);
                        if (e.target.checked) next.add(a.key);
                        else next.delete(a.key);
                        setSelected(next);
                      }}
                    />
                    {a.display_name}
                    <span className="faint small"> · {a.operators.join(', ')}</span>
                  </label>
                ))}
              </div>
            ))}
            <FieldError state={state} name="attributes" />
          </fieldset>

          <fieldset>
            <legend>Where and how</legend>

            <div className="field">
              <label htmlFor="geographies">Geographies</label>
              <input
                id="geographies"
                name="geographies"
                defaultValue={geographies.join(', ')}
                placeholder="IN"
              />
              <div className="field-hint">Comma separated, e.g. IN, AE.</div>
            </div>

            <div className="field">
              <label>Channels you can serve</label>
              {CHANNELS.map((c) => (
                <label key={c.value} className="check">
                  <input
                    type="checkbox"
                    name="channels"
                    value={c.value}
                    defaultChecked={channels.includes(c.value)}
                  />
                  {c.label}
                </label>
              ))}
              <div className="field-hint">External channels are not available yet.</div>
            </div>

            <div className="field">
              <label htmlFor="mapping_version">Local mapping version</label>
              <input
                id="mapping_version"
                name="mapping_version"
                type="number"
                min="1"
                defaultValue={mappingVersion ?? 1}
              />
              <div className="field-hint">Must match the value in your Agent&apos;s config.</div>
            </div>
          </fieldset>

          <SubmitButton pendingLabel="Publishing…">Publish capabilities</SubmitButton>
          <div className="field-hint">Earlier versions are kept for your records.</div>
        </>
      )}
    </ActionForm>
  );
}
