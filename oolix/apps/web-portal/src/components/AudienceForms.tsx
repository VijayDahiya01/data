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
  requestReachEstimates,
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
  if (versionStatus !== 'DRAFT') {
    return (
      <p className="faint small">These settings are finalized and can be used in a campaign.</p>
    );
  }

  const action = publishAudience.bind(null, audienceId);

  return (
    <ActionForm action={action}>
      {(state: ActionState) => (
        <>
          {state.ok ? <div className="notice notice-info">Audience finalized.</div> : null}
          <SubmitButton pendingLabel="Finalizing…">Finalize Audience</SubmitButton>
          <div className="field-hint">
            Finalizing locks these audience settings so they can be used in a campaign. It does not
            send anything to a Data Partner.
          </div>
        </>
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
        <a className="btn-secondary" href="./">
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
 * §8.1: ask compatible Partners to evaluate the rules locally.
 *
 * INCOMPATIBLE Partners are not offered. Asking one would spend their query on
 * a question their data cannot answer, and §7 already knows the answer is no.
 */
export function RequestEstimatesForm({
  audienceId,
  partners,
}: {
  audienceId: string;
  partners: { partner_org_id: string; partner_name: string; status: string }[];
}) {
  const eligible = partners.filter((p) => p.status !== 'INCOMPATIBLE');
  const action = requestReachEstimates.bind(null, audienceId);

  if (eligible.length === 0) {
    return (
      <p className="faint small">
        No compatible Partner yet. Relax a required rule, or check back once more Partners publish
        their capabilities.
      </p>
    );
  }

  return (
    <ActionForm action={action}>
      {(state: ActionState) => (
        <>
          {state.ok ? (
            <div className="notice notice-info">
              Requested. Each Partner&apos;s Agent evaluates the rules locally and returns a range;
              this can take a few minutes.
            </div>
          ) : null}
          <fieldset>
            <legend>Ask for a reach estimate</legend>
            {eligible.map((p) => (
              <label key={p.partner_org_id} className="check">
                <input type="checkbox" name="partner_org_ids" value={p.partner_org_id} />
                {p.partner_name}
              </label>
            ))}
          </fieldset>
          <SubmitButton pendingLabel="Requesting…">Request estimates</SubmitButton>
          <div className="field-hint">
            The Partner runs these rules inside their own systems and returns a{' '}
            <strong>range</strong>. Oolix never receives the number behind it.
          </div>
        </>
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
