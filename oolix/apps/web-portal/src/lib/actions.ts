'use server';

/**
 * Server actions -- every mutation the portal performs.
 *
 * These run on the server, so the access token never crosses to the browser
 * (§82). They also mean the screens work without client JavaScript: each one is
 * a plain `<form action={...}>`.
 *
 * §53 requires an `Idempotency-Key` on submit, approval and mark-paid. A key is
 * generated per action invocation rather than per form render, so a double
 * click sends the same key twice and the API replays instead of acting twice
 * (§99).
 */
import { createHash, randomUUID } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { api, ApiError, NotAuthenticatedError } from './api';

export interface ActionState {
  error?: string;
  fieldErrors?: Record<string, string>;
  ok?: boolean;
}

function toState(err: unknown): ActionState {
  // The API ended the sign-in (signed out elsewhere, password changed): the
  // same dead session as below, reached one step later.
  if (err instanceof ApiError && err.isAuthFailure) redirect('/login?error=session');
  if (err instanceof ApiError) {
    const fieldErrors: Record<string, string> = {};
    for (const fe of err.fieldErrors) fieldErrors[fe.field] = fe.message;
    return {
      error: err.correlationId ? `${err.message} (ref ${err.correlationId})` : err.message,
      fieldErrors,
    };
  }
  // A dead session is not a form error. Page loads already redirect to login
  // for this; a form submit used to print the raw Error text instead, leaving
  // the user on a page that could never succeed.
  if (err instanceof NotAuthenticatedError) redirect('/login?error=session');

  return { error: err instanceof Error ? err.message : 'Something went wrong.' };
}

const str = (fd: FormData, key: string): string => String(fd.get(key) ?? '').trim();
const opt = (fd: FormData, key: string): string | undefined => str(fd, key) || undefined;
const all = (fd: FormData, key: string): string[] => fd.getAll(key).map(String).filter(Boolean);

/** Rupees (or any major unit) typed by a human -> integer minor units (§53). */
function toMinor(major: string): number {
  const n = Number(major);
  if (!Number.isFinite(n)) return NaN;
  // Rounded rather than truncated: 1234.565 must not silently become 1234.56.
  return Math.round(n * 100);
}

/* --- brands (§36 step 4) --------------------------------------------------- */

export async function createBrand(_prev: ActionState, fd: FormData): Promise<ActionState> {
  try {
    await api('/v1/brands', {
      method: 'POST',
      body: {
        name: str(fd, 'name'),
        category: str(fd, 'category'),
        website: str(fd, 'website'),
        landing_domain: str(fd, 'landing_domain'),
        ...(opt(fd, 'logo_uri') ? { logo_uri: opt(fd, 'logo_uri') } : {}),
      },
    });
  } catch (err) {
    return toState(err);
  }
  revalidatePath('/campaigns/new');
  return { ok: true };
}

/* --- organization setup (§35.2) -------------------------------------------- */

export async function createOrganization(_prev: ActionState, fd: FormData): Promise<ActionState> {
  try {
    await api('/v1/organizations', {
      method: 'POST',
      body: {
        name: str(fd, 'name'),
        domain: str(fd, 'domain')
          .replace(/^https?:\/\//, '')
          .replace(/\/.*$/, ''),
        type: str(fd, 'type'),
        country: str(fd, 'country').toUpperCase(),
        ...(opt(fd, 'industry') ? { industry: opt(fd, 'industry') } : {}),
        ...(opt(fd, 'tax_id') ? { tax_id: opt(fd, 'tax_id') } : {}),
      },
    });
  } catch (err) {
    return toState(err);
  }

  // The new organization becomes the active one on the next request, once
  // /v1/me/context reports the membership.
  revalidatePath('/');
  redirect('/');
}

/* --- campaign builder (§40) ------------------------------------------------ */

/** §40.1, §40.2, §40.8 -- objective, basics and the outcome definition. */
export async function createCampaign(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const objective = str(fd, 'objective');
  const budgetMinor = toMinor(str(fd, 'budget_major'));
  if (!Number.isFinite(budgetMinor) || budgetMinor <= 0) {
    return {
      error: 'Enter a budget greater than zero.',
      fieldErrors: { budget_major: 'required' },
    };
  }

  // §40.8: an outcome campaign with no definition of the outcome cannot be
  // settled or disputed, so the API rejects it. Build it only when it applies.
  const needsLeadDefinition = objective === 'QUALIFIED_LEADS' || objective === 'CONVERSIONS';
  const qualified = all(fd, 'qualified_statuses');

  let campaignId: string;
  try {
    const created = await api<{ id: string }>('/v1/campaigns', {
      method: 'POST',
      idempotencyKey: randomUUID(),
      body: {
        name: str(fd, 'name'),
        objective,
        brand_id: str(fd, 'brand_id'),
        category: str(fd, 'category'),
        purpose_id: str(fd, 'purpose_id'),
        budget: { amount_minor: budgetMinor, currency: str(fd, 'currency') || 'INR' },
        start_at: new Date(str(fd, 'start_at')).toISOString(),
        end_at: new Date(str(fd, 'end_at')).toISOString(),
        geographies: str(fd, 'geographies')
          .split(',')
          .map((g) => g.trim())
          .filter(Boolean),
        ...(opt(fd, 'landing_url') ? { landing_url: opt(fd, 'landing_url') } : {}),
        ...(needsLeadDefinition
          ? {
              lead_definition: {
                qualified_statuses: qualified.length ? qualified : ['QUALIFIED'],
                duplicate_window_days: Number(str(fd, 'duplicate_window_days') || '30'),
                ...(opt(fd, 'valid_lead_rule')
                  ? { valid_lead_rule: opt(fd, 'valid_lead_rule') }
                  : {}),
                ...(opt(fd, 'qualified_lead_rule')
                  ? { qualified_lead_rule: opt(fd, 'qualified_lead_rule') }
                  : {}),
              },
            }
          : {}),
      },
    });
    campaignId = created.id;
  } catch (err) {
    return toState(err);
  }

  redirect(`/campaigns/${campaignId}/creative`);
}

/** §40.4-40.7 -- one Partner request, with its channels, budget and creative. */
export async function addPartnerRequest(
  campaignId: string,
  _prev: ActionState,
  fd: FormData,
): Promise<ActionState> {
  const allocationMinor = toMinor(str(fd, 'allocation_major'));
  if (!Number.isFinite(allocationMinor) || allocationMinor <= 0) {
    return { error: 'Enter an allocation greater than zero.' };
  }

  const channels = all(fd, 'channels');
  if (channels.length === 0) return { error: 'Select at least one channel.' };

  // §40.5: each requested channel becomes its own activation, never one
  // ambiguous activation spanning several. The budget is split evenly here;
  // §40.6 requires an explicit allocation, which this satisfies.
  const per = Math.floor(allocationMinor / channels.length);
  const placements = all(fd, 'placement_ids');

  try {
    await api(`/v1/campaigns/${campaignId}/partner-requests`, {
      method: 'POST',
      idempotencyKey: randomUUID(),
      body: {
        partner_org_id: str(fd, 'partner_org_id'),
        // v6 §19: omitted entirely on the audience path. Sending an empty
        // string would read as "a segment I could not name" rather than "no
        // segment", and the API would reject it as a malformed uuid.
        ...(opt(fd, 'segment_id') ? { segment_id: str(fd, 'segment_id') } : {}),
        // §9: the estimate the Buyer was looking at when they chose this
        // Partner, frozen onto the request.
        ...(opt(fd, 'reach_estimate_id')
          ? { reach_estimate_id: str(fd, 'reach_estimate_id') }
          : {}),
        channels: channels.map((channel, i) => ({
          channel,
          placement_ids: placements,
          // The remainder lands on the first channel so the allocations sum
          // exactly to what the Buyer typed (§40.6).
          allocation_minor: i === 0 ? allocationMinor - per * (channels.length - 1) : per,
          frequency_cap: {
            max_impressions: Number(str(fd, 'freq_max') || '2'),
            window: str(fd, 'freq_window') || 'P1D',
          },
        })),
        creative_version_ids: all(fd, 'creative_version_ids'),
        audience_expansion_allowed: fd.get('audience_expansion_allowed') === 'on',
        ...(opt(fd, 'payout_model')
          ? {
              partner_payout: {
                model: str(fd, 'payout_model'),
                unit_price_minor: toMinor(str(fd, 'payout_unit_price_major') || '0'),
              },
            }
          : {}),
      },
    });
  } catch (err) {
    return toState(err);
  }

  revalidatePath(`/campaigns/${campaignId}/audience`);
  return { ok: true };
}

/** §40.9 -- freeze the request version and start each Partner's review clock. */
export async function submitCampaign(
  campaignId: string,
  _prev: ActionState,
  _fd: FormData,
): Promise<ActionState> {
  try {
    await api(`/v1/campaigns/${campaignId}/submit`, {
      method: 'POST',
      // §53 makes the key MANDATORY here: a retried submit must not start a
      // second review.
      idempotencyKey: randomUUID(),
      body: {},
    });
  } catch (err) {
    return toState(err);
  }

  revalidatePath(`/campaigns/${campaignId}`);
  redirect(`/campaigns/${campaignId}`);
}

/* --- creative (§40.7, §70, §93) -------------------------------------------- */

/**
 * Upload a creative version (§93).
 *
 * The bytes are relayed by THIS server rather than sent from the browser to
 * object storage. §93.1 uses a pre-signed URL so the Oolix API never proxies a
 * 5 MiB upload, and that still holds -- the API is not in this path. Relaying
 * here instead of from the browser avoids depending on the storage bucket's
 * CORS configuration, which is deployment-specific and easy to get wrong.
 *
 * §93.3: the hash is computed from the bytes actually uploaded, so `finalize`
 * is verifying real content rather than a number the client asserted. §70 then
 * binds the Partner's approval to that content hash.
 */
export async function uploadCreative(
  campaignId: string,
  _prev: ActionState,
  fd: FormData,
): Promise<ActionState> {
  const file = fd.get('file');
  if (!(file instanceof File) || file.size === 0) return { error: 'Choose an image to upload.' };

  const bytes = Buffer.from(await file.arrayBuffer());
  const contentSha256 = createHash('sha256').update(bytes).digest('hex');

  const creativeType = str(fd, 'creative_type') || 'NATIVE_CARD';

  try {
    const session = await api<{
      creative_version_id: string;
      upload_url: string;
      upload_headers?: Record<string, string>;
    }>('/v1/creatives/upload-session', {
      method: 'POST',
      idempotencyKey: randomUUID(),
      body: {
        campaign_id: campaignId,
        file_name: file.name,
        mime_type: file.type,
        file_size_bytes: bytes.byteLength,
        creative_type: creativeType,
        destination_url: str(fd, 'destination_url'),
        ...(creativeType === 'IMAGE'
          ? {
              width: Number(str(fd, 'width') || '1200'),
              height: Number(str(fd, 'height') || '628'),
            }
          : {
              headline: str(fd, 'headline'),
              ...(opt(fd, 'body') ? { body: opt(fd, 'body') } : {}),
              ...(opt(fd, 'cta') ? { cta: opt(fd, 'cta') } : {}),
            }),
        ...(opt(fd, 'legal_disclaimer') ? { legal_disclaimer: opt(fd, 'legal_disclaimer') } : {}),
      },
    });

    const put = await fetch(session.upload_url, {
      method: 'PUT',
      headers: { 'Content-Type': file.type, ...(session.upload_headers ?? {}) },
      body: new Uint8Array(bytes),
    });
    if (!put.ok) {
      return { error: `Upload to storage failed (${put.status}). The link may have expired.` };
    }

    await api(`/v1/creatives/${session.creative_version_id}/finalize`, {
      method: 'POST',
      body: { content_sha256: contentSha256 },
    });
  } catch (err) {
    return toState(err);
  }

  revalidatePath(`/campaigns/${campaignId}/creative`);
  return { ok: true };
}

/* --- Partner decisions (§41) ----------------------------------------------- */

export async function approveRequest(
  requestId: string,
  _prev: ActionState,
  fd: FormData,
): Promise<ActionState> {
  const channels = all(fd, 'approved_channels');
  const creatives = all(fd, 'approved_creative_version_ids');

  if (channels.length === 0) return { error: 'Approve at least one channel, or reject instead.' };
  if (creatives.length === 0) {
    // §70: approval binds to specific creative VERSIONS and their content
    // hashes. Approving none would leave nothing an Agent could legitimately
    // serve.
    return { error: 'Approve at least one creative version.' };
  }

  try {
    await api(`/v1/partner-requests/${requestId}/approve`, {
      method: 'POST',
      idempotencyKey: randomUUID(),
      body: {
        approved_channels: channels,
        approved_placement_ids: all(fd, 'approved_placement_ids'),
        approved_creative_version_ids: creatives,
        // §40.4, §41: off unless the Partner explicitly grants it.
        audience_expansion_allowed: fd.get('audience_expansion_allowed') === 'on',
        ...(opt(fd, 'approval_note') ? { approval_note: opt(fd, 'approval_note') } : {}),
      },
    });
  } catch (err) {
    return toState(err);
  }

  revalidatePath('/partner/requests');
  redirect('/partner/requests?decided=approved');
}

export async function requestChange(
  requestId: string,
  _prev: ActionState,
  fd: FormData,
): Promise<ActionState> {
  const reason = str(fd, 'reason');
  if (reason.length < 3) return { error: 'Say what needs to change.' };

  // §41 requires the Partner to NAME the fields, and the API enforces at least
  // one. Checking here turns "Validation error." into something the Partner can
  // act on -- and this form used to send an empty list, so every request-change
  // failed.
  const fields = all(fd, 'fields');
  if (fields.length === 0) {
    return { error: 'Tick at least one thing that needs to change.' };
  }

  try {
    await api(`/v1/partner-requests/${requestId}/request-change`, {
      method: 'POST',
      body: { reason, fields },
    });
  } catch (err) {
    return toState(err);
  }

  revalidatePath('/partner/requests');
  redirect('/partner/requests?decided=change');
}

export async function rejectRequest(
  requestId: string,
  _prev: ActionState,
  fd: FormData,
): Promise<ActionState> {
  const reason = str(fd, 'reason');
  // §76: a REJECTED request never becomes APPROVED without a new version, so
  // the reason is the only thing the Buyer has to work from.
  if (reason.length < 3) return { error: 'A reason is required.' };

  try {
    await api(`/v1/partner-requests/${requestId}/reject`, { method: 'POST', body: { reason } });
  } catch (err) {
    return toState(err);
  }

  revalidatePath('/partner/requests');
  redirect('/partner/requests?decided=rejected');
}

export async function revokeRequest(
  requestId: string,
  _prev: ActionState,
  fd: FormData,
): Promise<ActionState> {
  const reason = str(fd, 'reason');
  if (reason.length < 3) return { error: 'A reason is required.' };

  try {
    await api(`/v1/partner-requests/${requestId}/revoke`, { method: 'POST', body: { reason } });
  } catch (err) {
    return toState(err);
  }

  revalidatePath('/partner/activations');
  return { ok: true };
}

/** §101: one extension of up to 7 days, with an audited reason. */
export async function extendReview(
  requestId: string,
  _prev: ActionState,
  fd: FormData,
): Promise<ActionState> {
  const reason = str(fd, 'reason');
  if (reason.length < 3) return { error: 'A reason is required.' };

  try {
    await api(`/v1/partner-requests/${requestId}/extend`, {
      method: 'POST',
      body: { reason, extra_days: Number(str(fd, 'extra_days') || '7') },
    });
  } catch (err) {
    return toState(err);
  }

  revalidatePath(`/partner/requests/${requestId}`);
  return { ok: true };
}

/* --- Partner supply (§38, §72) --------------------------------------------- */

/**
 * Publish segment METADATA (§38.1).
 *
 * §38.1: "A segment is a Partner-defined, locally evaluated group. Oolix
 * receives only metadata. The exact member list remains local." So there is no
 * membership field here and never will be — the audience itself lives in the
 * Partner's own database, and `internal_segment_id` is the only link between
 * the two.
 *
 * `reach_exact_local` is the one exception, and a deliberate one: §72 uses it
 * to derive the published BUCKET and then discards it. It is not stored on the
 * segment row and never appears in a Buyer-facing response.
 */
export async function createSegment(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const reach = Number(str(fd, 'reach_exact_local'));
  if (!Number.isInteger(reach) || reach < 0) {
    return { error: 'Enter the current member count as a whole number.' };
  }

  const list = (key: string) =>
    str(fd, key)
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean);

  const priceMajor = str(fd, 'unit_price_major');

  try {
    await api('/v1/partner/segments', {
      method: 'POST',
      body: {
        internal_segment_id: str(fd, 'internal_segment_id'),
        display_name: str(fd, 'display_name'),
        description: str(fd, 'description'),
        category: str(fd, 'category'),
        geographies: list('geographies'),
        refresh_frequency: str(fd, 'refresh_frequency'),
        consent_eligibility: str(fd, 'consent_eligibility') || 'ELIGIBLE',
        allowed_channels: all(fd, 'allowed_channels'),
        allowed_categories: list('allowed_categories'),
        blocked_categories: list('blocked_categories'),
        reach_exact_local: reach,
        ...(opt(fd, 'pricing_model')
          ? {
              pricing: {
                model: str(fd, 'pricing_model'),
                unit_price_minor: toMinor(priceMajor || '0'),
                currency: str(fd, 'currency') || 'INR',
                visibility: str(fd, 'visibility') || 'PRIVATE_NETWORK',
              },
            }
          : {}),
      },
    });
  } catch (err) {
    return toState(err);
  }

  revalidatePath('/partner/segments');
  return { ok: true };
}

/**
 * Report a completed refresh (§38.1, §72).
 *
 * This is how the published bucket stays honest as the audience changes. The
 * count is used to re-derive the bucket and is then discarded; §72 rate-limits
 * republication so repeated refreshes cannot be differenced back into an exact
 * size.
 */
export async function reportSegmentFreshness(
  segmentId: string,
  _prev: ActionState,
  fd: FormData,
): Promise<ActionState> {
  const reach = Number(str(fd, 'reach_exact_local'));
  if (!Number.isInteger(reach) || reach < 0) {
    return { error: 'Enter the current member count as a whole number.' };
  }

  try {
    await api(`/v1/partner/segments/${segmentId}/freshness`, {
      method: 'POST',
      body: { freshness_at: new Date().toISOString(), reach_exact_local: reach },
    });
  } catch (err) {
    return toState(err);
  }

  revalidatePath('/partner/segments');
  return { ok: true };
}

/** §38.1: a segment cannot be published until it has reported a real refresh. */
export async function publishSegment(
  segmentId: string,
  _prev: ActionState,
  _fd: FormData,
): Promise<ActionState> {
  try {
    await api(`/v1/partner/segments/${segmentId}/publish`, { method: 'POST', body: {} });
  } catch (err) {
    return toState(err);
  }

  revalidatePath('/partner/segments');
  return { ok: true };
}

/* --- activations and kill switches (§24, §52.3) ---------------------------- */

export async function activationAction(
  activationId: string,
  action: 'pause' | 'resume' | 'end',
  _prev: ActionState,
  fd: FormData,
): Promise<ActionState> {
  const reason = str(fd, 'reason');
  // §83: ending is irreversible under §76, so it always carries a reason.
  if (action === 'end' && reason.length < 3) return { error: 'A reason is required to end.' };

  try {
    await api(`/v1/activations/${activationId}/${action}`, {
      method: 'POST',
      body: reason ? { reason } : {},
    });
  } catch (err) {
    return toState(err);
  }

  revalidatePath('/partner/activations');
  revalidatePath('/campaigns');
  return { ok: true };
}

/**
 * §24, §6: unilateral and immediate. No Buyer agreement, no Oolix approval, no
 * notice period -- and enforced locally by the Agent so it works even while
 * Oolix is unreachable.
 */
export async function activateKillSwitch(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const reason = str(fd, 'reason');
  if (reason.length < 3) return { error: 'A reason is required.' };

  try {
    await api('/v1/partner/kill-switches', {
      method: 'POST',
      body: {
        scope: str(fd, 'scope'),
        target_id: opt(fd, 'target_id') ?? null,
        reason,
      },
    });
  } catch (err) {
    return toState(err);
  }

  revalidatePath('/partner/activations');
  return { ok: true };
}

export async function releaseKillSwitch(
  killSwitchId: string,
  _prev: ActionState,
  _fd: FormData,
): Promise<ActionState> {
  try {
    await api(`/v1/partner/kill-switches/${killSwitchId}/release`, { method: 'POST', body: {} });
  } catch (err) {
    return toState(err);
  }

  revalidatePath('/partner/activations');
  return { ok: true };
}
