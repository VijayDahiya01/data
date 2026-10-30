'use client';

/**
 * The small write actions around an audience — v6 §6, §8, §9, §16.
 */
import { useState } from 'react';
import type { ReactNode } from 'react';
import type { ActionState } from '@/lib/actions';
import {
  linkCampaignAudience,
  publishAudience,
  requestAllEstimates,
  unlinkCampaignAudience,
  updateAudienceRules,
} from '@/lib/actions-audience';
import { AudienceBuilder, type ExistingRule, type TaxonomyAttribute } from './AudienceBuilder';
import { ActionForm, SubmitButton } from './FormState';

/**
 * Publish a draft version.
 *
 * §6: a DRAFT is still being written. Only a READY version can be linked to a
 * campaign, because §10 binds a Partner's approval to a rule hash and binding
 * one to rules the Buyer had not finished is how a Partner ends up serving
 * something they never agreed to.
 */
export function AudienceVersionActions({
  audienceId,
  versionStatus,
}: {
  audienceId: string;
  versionStatus: string;
}) {
  if (versionStatus !== 'DRAFT') return null;

  const action = publishAudience.bind(null, audienceId);

  return (
    <ActionForm action={action}>
      {() => (
        <div className="btn-row">
          <SubmitButton pendingLabel="Finishing…">Finish and find Partners</SubmitButton>
          <span className="faint small">This is a draft: no Partner sees it yet.</span>
        </div>
      )}
    </ActionForm>
  );
}

/**
 * Point 19: editing an audience that campaigns are already running on.
 *
 * The edit is safe — it forks, and every running campaign keeps the settings
 * its Partners approved — but "safe" is not the same as "expected". A Buyer who
 * believes they are fixing a live campaign needs to be told, before they start,
 * that they are not. Saying it afterwards would be too late to be useful.
 */
export function EditInUseConfirm({
  campaignCount,
  children,
}: {
  campaignCount: number;
  children: ReactNode;
}) {
  const [confirmed, setConfirmed] = useState(false);

  if (campaignCount === 0 || confirmed) return <>{children}</>;

  return (
    <div className="notice notice-warn">
      <p style={{ marginTop: 0 }}>
        This audience is already used by {campaignCount}{' '}
        {campaignCount === 1 ? 'campaign' : 'campaigns'}. Your changes will apply only to new
        campaigns. Existing campaigns will continue using their current audience settings.
      </p>
      <div className="btn-row">
        <a className="btn btn-secondary" href="./">
          Cancel
        </a>
        <button type="button" className="btn-primary" onClick={() => setConfirmed(true)}>
          Continue Editing
        </button>
      </div>
    </div>
  );
}

export function EditAudienceRulesForm({
  audienceId,
  attributes,
  rules,
  submitLabel = 'Save rules',
}: {
  audienceId: string;
  attributes: TaxonomyAttribute[];
  rules: ExistingRule[];
  submitLabel?: string;
}) {
  const action = updateAudienceRules.bind(null, audienceId);
  return (
    <AudienceBuilder
      action={action}
      attributes={attributes}
      initialRules={rules}
      showIdentity={false}
      submitLabel={submitLabel}
    />
  );
}

/**
 * §8.1: ask every compatible Partner not yet asked to evaluate the rules
 * locally. INCOMPATIBLE Partners are never asked: §7 already knows their data
 * cannot answer.
 */
export function AskPartnersForm({ audienceId }: { audienceId: string }) {
  const action = requestAllEstimates.bind(null, audienceId);
  return (
    <ActionForm action={action}>
      {() => (
        <SubmitButton className="btn-secondary" pendingLabel="Asking…">
          Ask for estimates
        </SubmitButton>
      )}
    </ActionForm>
  );
}

/**
 * §9 step 3: choose the campaign's audience.
 *
 * Linking freezes the version and its rule hash onto the campaign. Everything a
 * Partner is later asked to approve is measured against that frozen pair, so
 * this is the moment the campaign stops moving underneath them.
 */
export function LinkAudienceForm({
  campaignId,
  audiences,
  linkedId,
}: {
  campaignId: string;
  audiences: { id: string; name: string; status: string; current_version: number }[];
  linkedId?: string | null;
}) {
  const [choice, setChoice] = useState(linkedId ?? '');
  const action = linkCampaignAudience.bind(null, campaignId);
  const linkable = audiences.filter((a) => a.status !== 'ARCHIVED');

  return (
    <ActionForm action={action}>
      {(state: ActionState) => (
        <>
          {state.ok ? (
            <div className="notice notice-info">
              Audience linked. This campaign keeps this version even if the audience is edited
              later.
            </div>
          ) : null}
          <div className="field">
            <label htmlFor="audience_group_id">Audience</label>
            <select
              id="audience_group_id"
              name="audience_group_id"
              value={choice}
              onChange={(e) => setChoice(e.target.value)}
              required
            >
              <option value="">— choose —</option>
              {linkable.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
            <div className="field-hint">
              One campaign uses one audience. This campaign keeps the settings as they are today —
              later edits to the audience will not change it.
            </div>
          </div>
          <SubmitButton pendingLabel="Linking…">
            {linkedId ? 'Change audience' : 'Link audience'}
          </SubmitButton>
        </>
      )}
    </ActionForm>
  );
}

export function UnlinkAudienceForm({ campaignId }: { campaignId: string }) {
  const action = unlinkCampaignAudience.bind(null, campaignId);
  return (
    <ActionForm action={action}>
      {(state: ActionState) => (
        <>
          {state.error ? null : null}
          <SubmitButton className="btn-secondary" pendingLabel="Removing…">
            Remove audience
          </SubmitButton>
        </>
      )}
    </ActionForm>
  );
}
