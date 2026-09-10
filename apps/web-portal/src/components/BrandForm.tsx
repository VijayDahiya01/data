'use client';

/**
 * Create a brand profile (§36 step 4, §40.2).
 *
 * The landing domain is not decoration: §40.7 only lets a campaign link to a
 * domain recorded here, so this is the allow-list itself.
 */
import { createBrand, type ActionState } from '@/lib/actions';
import { ActionForm, FieldError, SubmitButton } from './FormState';

export function BrandForm() {
  return (
    <ActionForm action={createBrand}>
      {(state: ActionState) => (
        <>
          <div className="field-row">
            <div className="field">
              <label htmlFor="brand_name">Brand name</label>
              <input id="brand_name" name="name" required minLength={2} maxLength={120} />
              <FieldError state={state} name="name" />
            </div>
            <div className="field">
              <label htmlFor="brand_category">Category</label>
              <input id="brand_category" name="category" required defaultValue="insurance" />
              <FieldError state={state} name="category" />
            </div>
          </div>

          <div className="field-row">
            <div className="field">
              <label htmlFor="website">Website</label>
              <input
                id="website"
                name="website"
                type="url"
                required
                placeholder="https://insurance.example"
              />
              <FieldError state={state} name="website" />
            </div>
            <div className="field">
              <label htmlFor="landing_domain">Landing domain</label>
              <input
                id="landing_domain"
                name="landing_domain"
                required
                placeholder="insurance.example"
              />
              <div className="field-hint">
                Bare domain, and it must belong to the website above. Campaign links may point
                nowhere else.
              </div>
              <FieldError state={state} name="landing_domain" />
            </div>
          </div>

          <div className="btn-row">
            <SubmitButton pendingLabel="Saving…">Save brand</SubmitButton>
          </div>
        </>
      )}
    </ActionForm>
  );
}
