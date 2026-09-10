'use client';

/**
 * The Audience Builder.
 *
 * A Buyer describes the people they want to reach. They are not editing a
 * schema, so there is no operator column, no weight numbers, no empty rows
 * waiting to be filled and no free-text value box that can hold "tru".
 *
 * Three rules shape the whole design:
 *
 *   The attribute decides the control. A yes/no attribute gets Yes/No; a list
 *   attribute gets its real options; an age range gets two number boxes. There
 *   is no path here that produces a value the API would reject.
 *
 *   The attribute decides the operator. Every attribute in the taxonomy
 *   supports exactly one, so asking the Buyer to choose is asking them to make
 *   a decision that was never theirs — and leaving it unset makes an invalid
 *   rule reachable.
 *
 *   Required vs optional is a business decision, not a checkbox. It decides
 *   which Data Partners can serve the campaign at all, so it is stated in full
 *   on every condition.
 */
import { useMemo, useState } from 'react';
import type { ActionState } from '@/lib/actions';
import {
  CATEGORY_LABELS,
  CATEGORY_ORDER,
  GEOGRAPHY_KEYS,
  IMPORTANCE,
  defaultValueFor,
  describeRule,
  importanceLabel,
  isRuleComplete,
  operatorFor,
  operatorPhrase,
  valueLabel,
  type TaxonomyAttribute,
} from '@/lib/audience-vocabulary';
import { ActionForm, FieldError, SubmitButton } from './FormState';

export type { TaxonomyAttribute };

export interface ExistingRule {
  attribute: string;
  operator: string;
  value: unknown;
  required: boolean;
  weight: number;
}

interface Row {
  attribute: string;
  value: unknown;
  required: boolean;
  weight: number;
}

/* --- value editors --------------------------------------------------------- */

function BooleanValue({
  attr,
  value,
  onChange,
}: {
  attr: TaxonomyAttribute;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  return (
    <select
      value={value === false ? 'no' : 'yes'}
      onChange={(e) => onChange(e.target.value === 'yes')}
      aria-label={`${attr.display_name} value`}
    >
      <option value="yes">Yes</option>
      <option value="no">No</option>
    </select>
  );
}

function ChoiceValue({
  attr,
  value,
  onChange,
}: {
  attr: TaxonomyAttribute;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  const selected = Array.isArray(value) ? value.map(String) : [];
  const options = attr.allowed_values ?? [];

  // No allowed_values means the taxonomy accepts open text for this attribute.
  // Rare, but it must not silently render an empty picker.
  if (options.length === 0) {
    return (
      <input
        value={selected.join(', ')}
        onChange={(e) =>
          onChange(
            e.target.value
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean),
          )
        }
        placeholder="Type values, separated by commas"
        aria-label={`${attr.display_name} value`}
      />
    );
  }

  return (
    <div className="chips" role="group" aria-label={`${attr.display_name} value`}>
      {options.map((opt) => {
        const on = selected.includes(opt);
        return (
          <button
            type="button"
            key={opt}
            className={on ? 'chip chip-on' : 'chip'}
            aria-pressed={on}
            onClick={() => onChange(on ? selected.filter((s) => s !== opt) : [...selected, opt])}
          >
            {valueLabel(opt)}
          </button>
        );
      })}
    </div>
  );
}

function RangeValue({
  attr,
  value,
  onChange,
}: {
  attr: TaxonomyAttribute;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  // Falls back to EMPTY, never to the attribute's own bounds. A range
  // pre-filled with 13-120 reads like a decision the Buyer made and matches
  // everyone; the placeholders below show the same numbers as a hint without
  // committing to them.
  const pair = Array.isArray(value) ? value : ['', ''];
  const set = (i: number, raw: string) => {
    const next = [...pair];
    next[i] = raw === '' ? '' : Number(raw);
    onChange(next);
  };

  return (
    <span className="value-inline">
      <input
        type="number"
        value={String(pair[0] ?? '')}
        min={attr.min_value ?? undefined}
        max={attr.max_value ?? undefined}
        placeholder={attr.min_value != null ? String(attr.min_value) : 'from'}
        onChange={(e) => set(0, e.target.value)}
        aria-label={`${attr.display_name} from`}
      />
      <span className="faint">to</span>
      <input
        type="number"
        value={String(pair[1] ?? '')}
        min={attr.min_value ?? undefined}
        max={attr.max_value ?? undefined}
        placeholder={attr.max_value != null ? String(attr.max_value) : 'to'}
        onChange={(e) => set(1, e.target.value)}
        aria-label={`${attr.display_name} to`}
      />
      {attr.unit ? <span className="faint">{attr.unit}</span> : null}
    </span>
  );
}

function NumberValue({
  attr,
  value,
  onChange,
}: {
  attr: TaxonomyAttribute;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  return (
    <span className="value-inline">
      <input
        type="number"
        value={String(value ?? '')}
        min={attr.min_value ?? undefined}
        max={attr.max_value ?? undefined}
        placeholder={attr.unit === 'days' ? 'days' : 'number'}
        onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))}
        aria-label={`${attr.display_name} value`}
      />
      {attr.unit ? <span className="faint">{attr.unit}</span> : null}
    </span>
  );
}

function ValueEditor(props: {
  attr: TaxonomyAttribute;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  const op = operatorFor(props.attr);
  if (props.attr.data_type === 'BOOLEAN') return <BooleanValue {...props} />;
  if (op === 'IN') return <ChoiceValue {...props} />;
  if (op === 'BETWEEN') return <RangeValue {...props} />;
  return <NumberValue {...props} />;
}

/* --- requirement ----------------------------------------------------------- */

function RequirementControl({
  row,
  onChange,
}: {
  row: Row;
  onChange: (patch: Partial<Row>) => void;
}) {
  return (
    <div className="requirement">
      <div className="segmented" role="group" aria-label="Requirement">
        <button
          type="button"
          className={row.required ? 'seg seg-on' : 'seg'}
          aria-pressed={row.required}
          onClick={() => onChange({ required: true })}
        >
          Required
        </button>
        <button
          type="button"
          className={!row.required ? 'seg seg-on' : 'seg'}
          aria-pressed={!row.required}
          onClick={() => onChange({ required: false })}
        >
          Optional
        </button>
      </div>

      {row.required ? (
        <p className="faint small">Only Partners who can match this can run your campaign.</p>
      ) : (
        <>
          <p className="faint small">Nice to have. Improves the match, never blocks it.</p>
          {/* Importance ranks optional conditions against each other. It has no
              effect on a required one, so it is not shown there — an earlier
              build showed a weight on every row, which implied it changed
              eligibility. */}
          <label className="importance">
            <span className="faint small">Importance</span>
            <select
              value={String(row.weight)}
              onChange={(e) => onChange({ weight: Number(e.target.value) })}
              aria-label="Importance"
            >
              {IMPORTANCE.map((i) => (
                <option key={i.value} value={i.value}>
                  {i.label}
                </option>
              ))}
            </select>
          </label>
        </>
      )}
    </div>
  );
}

/* --- attribute picker ------------------------------------------------------ */

function AddCondition({
  available,
  onAdd,
}: {
  available: TaxonomyAttribute[];
  onAdd: (key: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    return available.filter(
      (a) =>
        !q ||
        a.display_name.toLowerCase().includes(q) ||
        a.key.includes(q) ||
        (a.description ?? '').toLowerCase().includes(q) ||
        (a.allowed_values ?? []).some((v) => v.toLowerCase().includes(q)),
    );
  }, [available, query]);

  const grouped = useMemo(() => {
    const byCategory = new Map<string, TaxonomyAttribute[]>();
    for (const a of matches) {
      const list = byCategory.get(a.category) ?? [];
      list.push(a);
      byCategory.set(a.category, list);
    }
    return [...byCategory.entries()].sort(
      (a, b) => CATEGORY_ORDER.indexOf(a[0] as never) - CATEGORY_ORDER.indexOf(b[0] as never),
    );
  }, [matches]);

  if (available.length === 0) {
    return <p className="faint small">All conditions added.</p>;
  }

  if (!open) {
    return (
      <button type="button" className="btn-secondary" onClick={() => setOpen(true)}>
        + Add condition
      </button>
    );
  }

  return (
    <div className="picker">
      <div className="field">
        <label htmlFor="attribute-search">Find a condition</label>
        <input
          id="attribute-search"
          value={query}
          autoFocus
          onChange={(e) => setQuery(e.target.value)}
          placeholder="age, footwear, payment…"
        />
      </div>

      {grouped.length === 0 ? (
        <p className="faint small">Nothing matches “{query}”.</p>
      ) : (
        grouped.map(([category, list]) => (
          <div key={category} className="picker-group">
            <div className="picker-group-label">{CATEGORY_LABELS[category] ?? category}</div>
            {list.map((a) => (
              <button
                type="button"
                key={a.key}
                className="picker-item"
                onClick={() => {
                  onAdd(a.key);
                  setOpen(false);
                  setQuery('');
                }}
              >
                <strong>{a.display_name}</strong>
                {a.description ? <span className="faint small"> {a.description}</span> : null}
              </button>
            ))}
          </div>
        ))
      )}

      <button type="button" className="btn-secondary" onClick={() => setOpen(false)}>
        Cancel
      </button>
    </div>
  );
}

/* --- the builder ----------------------------------------------------------- */

export function AudienceBuilder({
  action,
  attributes,
  initialRules = [],
  initialName,
  initialDescription,
  showIdentity = true,
  submitLabel = 'Find Data Partners',
}: {
  action: (prev: ActionState, fd: FormData) => Promise<ActionState>;
  attributes: TaxonomyAttribute[];
  initialRules?: ExistingRule[];
  initialName?: string;
  initialDescription?: string;
  showIdentity?: boolean;
  submitLabel?: string;
}) {
  const byKey = useMemo(() => new Map(attributes.map((a) => [a.key, a])), [attributes]);

  const [rows, setRows] = useState<Row[]>(() =>
    initialRules.map((r) => ({
      attribute: r.attribute,
      value: r.value,
      required: r.required,
      weight: r.weight,
    })),
  );

  const patch = (index: number, p: Partial<Row>) =>
    setRows((rs) => rs.map((r, i) => (i === index ? { ...r, ...p } : r)));

  const add = (key: string) => {
    const attr = byKey.get(key);
    if (!attr) return;
    setRows((rs) => [
      ...rs,
      { attribute: key, value: defaultValueFor(attr), required: true, weight: 5 },
    ]);
  };

  const remove = (index: number) => setRows((rs) => rs.filter((_, i) => i !== index));

  // An attribute already in the audience is not offered again, so a duplicate
  // condition is impossible to create rather than merely rejected afterwards.
  const used = new Set(rows.map((r) => r.attribute));

  const geographyRows = rows
    .map((r, i) => ({ row: r, index: i }))
    .filter(({ row }) => (GEOGRAPHY_KEYS as readonly string[]).includes(row.attribute));
  const conditionRows = rows
    .map((r, i) => ({ row: r, index: i }))
    .filter(({ row }) => !(GEOGRAPHY_KEYS as readonly string[]).includes(row.attribute));

  const geographyAvailable = attributes.filter(
    (a) => (GEOGRAPHY_KEYS as readonly string[]).includes(a.key) && !used.has(a.key),
  );
  const conditionAvailable = attributes.filter(
    (a) => !(GEOGRAPHY_KEYS as readonly string[]).includes(a.key) && !used.has(a.key),
  );

  const complete = rows.filter((r) => isRuleComplete(byKey.get(r.attribute), r.value));
  const requiredCount = complete.filter((r) => r.required).length;
  const optionalCount = complete.length - requiredCount;
  const incomplete = rows.length - complete.length;

  // Only complete conditions are submitted. A half-filled row is a Buyer who
  // has not finished thinking, not a rule.
  const payload = JSON.stringify(
    complete.map((r) => ({
      attribute: r.attribute,
      operator: operatorFor(byKey.get(r.attribute)!),
      value: r.value,
      required: r.required,
      weight: r.required ? 5 : r.weight,
    })),
  );

  const renderRow = ({ row, index }: { row: Row; index: number }, ordinal: number) => {
    const attr = byKey.get(row.attribute);
    if (!attr) return null;

    return (
      <li key={row.attribute} className="condition">
        <div className="condition-head">
          <span className="condition-name">
            <span className="condition-n">{ordinal}</span>
            {attr.display_name}
          </span>
          <button
            type="button"
            className="link-danger"
            onClick={() => remove(index)}
            aria-label={`Remove ${attr.display_name}`}
          >
            Remove
          </button>
        </div>

        <div className="condition-body">
          <span className="faint">{operatorPhrase(attr)}</span>
          <ValueEditor attr={attr} value={row.value} onChange={(v) => patch(index, { value: v })} />
        </div>

        <RequirementControl row={row} onChange={(p) => patch(index, p)} />
      </li>
    );
  };

  return (
    <ActionForm action={action}>
      {(state: ActionState) => (
        <>
          <input type="hidden" name="rules" value={payload} />

          {showIdentity ? (
            <fieldset>
              <legend>Audience basics</legend>
              <div className="field">
                <label htmlFor="name">Audience name</label>
                <input
                  id="name"
                  name="name"
                  required
                  minLength={3}
                  defaultValue={initialName}
                  placeholder="Urban Shoe Shoppers"
                />
                <FieldError state={state} name="name" />
              </div>
              <div className="field">
                <label htmlFor="description">Description</label>
                <input
                  id="description"
                  name="description"
                  defaultValue={initialDescription}
                  placeholder="Young online shoppers likely to buy footwear"
                />
              </div>
            </fieldset>
          ) : null}

          <fieldset>
            <legend>Location</legend>
            <p className="field-hint">Optional. Leave blank to reach everywhere.</p>
            {geographyRows.length > 0 ? (
              <ol className="conditions">{geographyRows.map((r, i) => renderRow(r, i + 1))}</ol>
            ) : null}
            <AddCondition available={geographyAvailable} onAdd={add} />
          </fieldset>

          <fieldset>
            <legend>Audience conditions</legend>
            <p className="field-hint">Describe the people you want to reach.</p>

            {conditionRows.length === 0 ? (
              <p className="faint">Add at least four conditions.</p>
            ) : (
              <ol className="conditions">
                {conditionRows.map((r, i) => renderRow(r, geographyRows.length + i + 1))}
              </ol>
            )}

            <AddCondition available={conditionAvailable} onAdd={add} />

            <div className="notice notice-info">
              Matches people who meet <strong>all</strong> Required conditions. Picking several
              values in one condition means <strong>any</strong> of them.
            </div>
          </fieldset>

          <fieldset>
            <legend>Summary</legend>
            {complete.length === 0 ? (
              <p className="faint">Nothing to summarise yet.</p>
            ) : (
              <>
                <div className="summary-counts">
                  <span>
                    <strong>{requiredCount}</strong> required
                  </span>
                  <span>
                    <strong>{optionalCount}</strong> optional
                  </span>
                  {incomplete > 0 ? (
                    <span className="faint">{incomplete} unfinished, not included</span>
                  ) : null}
                </div>

                <ul className="summary-list">
                  {complete
                    .filter((r) => r.required)
                    .map((r) => (
                      <li key={r.attribute}>
                        <span className="tick">✓</span>
                        {describeRule(byKey.get(r.attribute), r.value, r.attribute)}
                      </li>
                    ))}
                  {complete
                    .filter((r) => !r.required)
                    .map((r) => (
                      <li key={r.attribute} className="faint">
                        <span className="tick">•</span>
                        {describeRule(byKey.get(r.attribute), r.value, r.attribute)}
                        <span className="faint small"> · {importanceLabel(r.weight)}</span>
                      </li>
                    ))}
                </ul>
              </>
            )}

            {complete.length < 4 ? (
              <div className="notice notice-warn">Add at least four conditions to continue.</div>
            ) : null}
          </fieldset>

          <div className="btn-row">
            <SubmitButton pendingLabel="Saving…">{submitLabel}</SubmitButton>
            {showIdentity ? (
              <button type="submit" name="intent" value="draft" className="btn-secondary">
                Save draft
              </button>
            ) : null}
          </div>
        </>
      )}
    </ActionForm>
  );
}
