'use client';

/**
 * Creative upload — campaign builder screen 2 (§40.7, §70, §93).
 *
 * Every upload creates a VERSION. §70: "Every edit creates creative version;
 * Partner approval binds to version." So a Partner who approved v1 has not
 * approved v2, and replacing an image after approval cannot quietly change what
 * runs on their property.
 *
 * Up front: the image and the words on the ad. The format, where it links and
 * a legal disclaimer have defaults -- the link is the campaign's landing page
 * -- and sit under "More options", unless there is no landing page to default
 * to. A saved ad goes straight on to the Partners.
 */
import { useState } from 'react';
import { uploadCreative, type ActionState } from '@/lib/actions';
import { ActionForm, FieldError, SubmitButton } from './FormState';

export function CreativeUploadForm({
  campaignId,
  landingUrl,
  submitLabel = 'Save ad and continue',
}: {
  campaignId: string;
  landingUrl?: string;
  submitLabel?: string;
}) {
  const [type, setType] = useState<'NATIVE_CARD' | 'IMAGE'>('NATIVE_CARD');
  const action = uploadCreative.bind(null, campaignId);

  const destination = (state: ActionState) => (
    <div className="field">
      <label htmlFor="destination_url">Where the ad links to</label>
      <input
        id="destination_url"
        name="destination_url"
        type="url"
        required={!landingUrl}
        defaultValue={landingUrl ?? ''}
      />
      <div className="field-hint">
        On your brand&rsquo;s domain, with no personal data in the address.
      </div>
      <FieldError state={state} name="destination_url" />
    </div>
  );

  return (
    <ActionForm action={action}>
      {(state: ActionState) => (
        <>
          <div className="field">
            <label htmlFor="file">Image</label>
            <input
              id="file"
              name="file"
              type="file"
              required
              accept="image/png,image/jpeg,image/webp"
            />
            <div className="field-hint">PNG, JPEG or WebP, up to 5 MB.</div>
          </div>

          {type === 'NATIVE_CARD' ? (
            <>
              <div className="field">
                <label htmlFor="headline">Headline</label>
                <input id="headline" name="headline" required maxLength={120} />
                <FieldError state={state} name="headline" />
              </div>
              <div className="field-row">
                <div className="field">
                  <label htmlFor="body">Text</label>
                  <input id="body" name="body" maxLength={500} />
                </div>
                <div className="field">
                  <label htmlFor="cta">Button</label>
                  <input id="cta" name="cta" maxLength={40} defaultValue="Learn more" />
                </div>
              </div>
            </>
          ) : null}

          {landingUrl ? null : destination(state)}

          <details
            className="more"
            open={
              Boolean(state.fieldErrors?.destination_url || state.fieldErrors?.width) || undefined
            }
          >
            <summary>More options</summary>
            <div className="field">
              <label htmlFor="creative_type">Format</label>
              <select
                id="creative_type"
                name="creative_type"
                value={type}
                onChange={(e) => setType(e.target.value as 'NATIVE_CARD' | 'IMAGE')}
              >
                <option value="NATIVE_CARD">Card: image, headline and text</option>
                <option value="IMAGE">Image only</option>
              </select>
            </div>

            {type === 'IMAGE' ? (
              <div className="field-row">
                <div className="field">
                  <label htmlFor="width">Width (px)</label>
                  <input id="width" name="width" type="number" min="1" defaultValue="1200" />
                  <FieldError state={state} name="width" />
                </div>
                <div className="field">
                  <label htmlFor="height">Height (px)</label>
                  <input id="height" name="height" type="number" min="1" defaultValue="628" />
                </div>
              </div>
            ) : null}

            {landingUrl ? destination(state) : null}

            <div className="field">
              <label htmlFor="legal_disclaimer">Legal disclaimer</label>
              <input id="legal_disclaimer" name="legal_disclaimer" maxLength={500} />
              <div className="field-hint">Some categories and Partners require one.</div>
            </div>
          </details>

          <div className="btn-row">
            <SubmitButton pendingLabel="Uploading…">{submitLabel}</SubmitButton>
          </div>
        </>
      )}
    </ActionForm>
  );
}
