'use client';

/**
 * Creative upload — step 7 (§40.7, §70, §93).
 *
 * Every upload creates a VERSION. §70: "Every edit creates creative version;
 * Partner approval binds to version." So a Partner who approved v1 has not
 * approved v2, and replacing an image after approval cannot quietly change what
 * runs on their property.
 */
import { useState } from 'react';
import { uploadCreative, type ActionState } from '@/lib/actions';
import { ActionForm, FieldError, SubmitButton } from './FormState';

export function CreativeUploadForm({
  campaignId,
  landingUrl,
}: {
  campaignId: string;
  landingUrl?: string;
}) {
  const [type, setType] = useState<'NATIVE_CARD' | 'IMAGE'>('NATIVE_CARD');
  const action = uploadCreative.bind(null, campaignId);

  return (
    <ActionForm action={action}>
      {(state: ActionState) => (
        <>
          <div className="field-row">
            <div className="field">
              <label htmlFor="creative_type">Format</label>
              <select
                id="creative_type"
                name="creative_type"
                value={type}
                onChange={(e) => setType(e.target.value as 'NATIVE_CARD' | 'IMAGE')}
              >
                <option value="NATIVE_CARD">Native card</option>
                <option value="IMAGE">Image</option>
              </select>
              <div className="field-hint">Must be supported by the placement you choose next.</div>
            </div>

            <div className="field">
              <label htmlFor="file">Image file</label>
              <input
                id="file"
                name="file"
                type="file"
                required
                accept="image/png,image/jpeg,image/webp"
              />
              <div className="field-hint">
                PNG, JPEG or WebP, up to 5 MB. We check the file itself, not what it is named.
              </div>
            </div>
          </div>

          {type === 'NATIVE_CARD' ? (
            <>
              <div className="field">
                <label htmlFor="headline">Headline</label>
                <input id="headline" name="headline" required maxLength={120} />
                <FieldError state={state} name="headline" />
              </div>
              <div className="field">
                <label htmlFor="body">Body</label>
                <textarea id="body" name="body" rows={2} maxLength={500} />
              </div>
              <div className="field-row">
                <div className="field">
                  <label htmlFor="cta">Call to action</label>
                  <input id="cta" name="cta" maxLength={40} defaultValue="Get a quote" />
                </div>
              </div>
            </>
          ) : (
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
          )}

          <div className="field">
            <label htmlFor="destination_url">Destination URL</label>
            <input
              id="destination_url"
              name="destination_url"
              type="url"
              required
              defaultValue={landingUrl ?? ''}
            />
            <div className="field-hint">
              HTTPS and on your brand&rsquo;s allow-listed domain, with no personal data in the
              query string.
            </div>
            <FieldError state={state} name="destination_url" />
          </div>

          <div className="field">
            <label htmlFor="legal_disclaimer">Legal disclaimer</label>
            <input id="legal_disclaimer" name="legal_disclaimer" maxLength={500} />
            <div className="field-hint">Some categories and Partner policies require one.</div>
          </div>

          <div className="btn-row">
            <SubmitButton pendingLabel="Uploading…">Upload creative version</SubmitButton>
          </div>
        </>
      )}
    </ActionForm>
  );
}
