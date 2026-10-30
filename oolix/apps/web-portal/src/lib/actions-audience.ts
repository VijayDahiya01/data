'use server';

/**
 * Audience Builder actions — v6 §6, §7, §8, §9, §5.1.
 *
 * The parsing here is the point of the whole file. §17 forbids arbitrary SQL,
 * JavaScript or regex rules, so a Buyer never types an expression: they pick an
 * attribute from the taxonomy, pick an operator that attribute supports, and
 * type a value that the API re-validates against the taxonomy's allowed values.
 * Everything below turns form fields into that fixed shape and nothing else.
 */
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { api, ApiError, NotAuthenticatedError } from './api';
import type { ActionState } from './actions';

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

interface ParsedRule {
  attribute: string;
  operator: string;
  value: unknown;
  required: boolean;
  weight: number;
}

/**
 * Read the conditions the builder composed.
 *
 * They arrive as JSON from a hidden field, because the controls are typed per
 * attribute — a multi-select, a range, a yes/no — and flattening those into
 * indexed text inputs is what produced a builder that accepted "tru" as a
 * boolean.
 *
 * A hidden field is still user input, so every rule is re-checked here for
 * shape, and the API re-validates the whole set against the live taxonomy
 * afterwards. Nothing about this file is the last line of defence.
 */
function collectRules(fd: FormData): { rules: ParsedRule[] } | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(str(fd, 'rules') || '[]');
  } catch {
    return { error: 'Those conditions could not be read. Reload the page and try again.' };
  }
  if (!Array.isArray(parsed)) {
    return { error: 'Those conditions could not be read. Reload the page and try again.' };
  }

  const rules: ParsedRule[] = [];
  const seen = new Set<string>();

  for (const raw of parsed) {
    if (typeof raw !== 'object' || raw === null) continue;
    const r = raw as Record<string, unknown>;

    const attribute = typeof r.attribute === 'string' ? r.attribute : '';
    const operator = typeof r.operator === 'string' ? r.operator : '';
    if (!attribute || !operator) continue;

    // The builder cannot offer an attribute twice, so a duplicate here means
    // the payload was edited. One rule per attribute is what the API enforces
    // too -- two rules on one attribute either contradict or repeat, and a
    // Partner reviewing them should not have to work out which.
    if (seen.has(attribute)) {
      return { error: `${attribute} appears more than once.` };
    }
    seen.add(attribute);

    const weight = Number(r.weight);
    rules.push({
      attribute,
      operator,
      value: r.value,
      required: r.required === true,
      weight: Number.isFinite(weight) && weight >= 1 && weight <= 5 ? Math.round(weight) : 3,
    });
  }

  if (rules.length < 4) {
    // A one-condition audience matches almost every Partner and tells a Data
    // Partner very little about what they are being asked to serve.
    return { error: 'An audience needs at least four conditions.' };
  }
  return { rules };
}

export async function createAudience(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const collected = collectRules(fd);
  if ('error' in collected) return collected;

  let id: string;
  try {
    const created = await api<{ id: string }>('/v1/audiences', {
      method: 'POST',
      body: {
        name: str(fd, 'name'),
        description: str(fd, 'description') || undefined,
        rules: collected.rules,
      },
    });
    id = created.id;
  } catch (err) {
    return toState(err);
  }

  revalidatePath('/audiences');

  // The point of describing an audience is to find out who can serve it, so
  // the primary action finishes it and asks every Partner that can evaluate it
  // for an estimate (§8.1) -- the Buyer arrives at the answers rather than at
  // a page of checkboxes for requesting them. "Save draft" stops at the
  // audience for a Buyer who is still composing.
  if (str(fd, 'intent') !== 'draft') {
    try {
      await api(`/v1/audiences/${id}/publish`, { method: 'POST', body: {} });
      await askCompatiblePartners(id);
    } catch {
      // The audience is saved either way; its page shows what is left to do.
    }
  }
  redirect(`/audiences/${id}`);
}

/** "Ask for estimates" on the audience page: every compatible Partner not yet asked. */
export async function requestAllEstimates(
  audienceId: string,
  _prev: ActionState,
  _fd: FormData,
): Promise<ActionState> {
  try {
    await askCompatiblePartners(audienceId);
  } catch (err) {
    return toState(err);
  }
  revalidatePath(`/audiences/${audienceId}`);
  return { ok: true };
}

/** §8.1 for every Partner that can evaluate the audience's current version. */
async function askCompatiblePartners(audienceId: string): Promise<void> {
  const matches = await api<{
    items: { partner_org_id: string; status: string; reach_estimate: unknown }[];
  }>(`/v1/audiences/${audienceId}/partner-matches`);
  const ids = matches.items
    .filter((m) => m.status !== 'INCOMPATIBLE' && !m.reach_estimate)
    .map((m) => m.partner_org_id);
  if (ids.length === 0) return;
  await api(`/v1/audiences/${audienceId}/reach-estimates`, {
    method: 'POST',
    body: { partner_org_ids: ids },
  });
}

export async function updateAudienceRules(
  audienceId: string,
  _prev: ActionState,
  fd: FormData,
): Promise<ActionState> {
  const collected = collectRules(fd);
  if ('error' in collected) return collected;

  try {
    await api(`/v1/audiences/${audienceId}`, {
      method: 'PATCH',
      // §16: editing a READY audience FORKS a new version rather than changing
      // the one live campaigns are running on. The Buyer sees the new version
      // number appear; nothing they approved moves.
      body: { rules: collected.rules },
    });
  } catch (err) {
    return toState(err);
  }

  revalidatePath(`/audiences/${audienceId}`);
  return { ok: true };
}

/** Finish a draft (§6), and ask the Partners that can evaluate it (§8.1). */
export async function publishAudience(
  audienceId: string,
  _prev: ActionState,
  _fd: FormData,
): Promise<ActionState> {
  try {
    await api(`/v1/audiences/${audienceId}/publish`, { method: 'POST', body: {} });
  } catch (err) {
    return toState(err);
  }
  try {
    await askCompatiblePartners(audienceId);
  } catch {
    // Finished either way; the page offers "Ask for estimates" again.
  }

  revalidatePath(`/audiences/${audienceId}`);
  revalidatePath('/audiences');
  return { ok: true };
}

/* --- §9: the campaign's audience ------------------------------------------ */

export async function linkCampaignAudience(
  campaignId: string,
  _prev: ActionState,
  fd: FormData,
): Promise<ActionState> {
  const audienceGroupId = str(fd, 'audience_group_id');
  if (!audienceGroupId) return { error: 'Choose an audience.' };

  try {
    await api(`/v1/campaigns/${campaignId}/audience-link`, {
      method: 'POST',
      // §9 freezes the version and rule hash at this moment. Sending no version
      // means "whatever is current now", which is then fixed.
      body: { audience_group_id: audienceGroupId },
      idempotencyKey: `link-${campaignId}-${audienceGroupId}`,
    });
  } catch (err) {
    return toState(err);
  }

  revalidatePath(`/campaigns/${campaignId}/audience`);
  revalidatePath(`/campaigns/${campaignId}`);
  return { ok: true };
}

export async function unlinkCampaignAudience(
  campaignId: string,
  _prev: ActionState,
  _fd: FormData,
): Promise<ActionState> {
  try {
    await api(`/v1/campaigns/${campaignId}/audience-link`, { method: 'DELETE' });
  } catch (err) {
    return toState(err);
  }

  revalidatePath(`/campaigns/${campaignId}/audience`);
  return { ok: true };
}

/* --- §5.1: Partner capabilities ------------------------------------------- */

/**
 * Publish what this Partner can evaluate.
 *
 * Note what the form cannot submit: a column name. §5.2 keeps the mapping from
 * `payment_method` to whatever this Partner actually stores inside the Agent's
 * own config file, and §17 says Oolix holds capability metadata, "not Partner
 * customer records or Partner local field names". Ticking a box here says "we
 * can answer questions about payment method" — never how.
 */
/**
 * §66.2 marketplace listing: let every verified Buyer find this Partner by its
 * published capabilities, or stop. The API checks the permission and that the
 * business is verified; this only carries the choice.
 */
export async function setMarketplaceListing(
  _prev: ActionState,
  fd: FormData,
): Promise<ActionState> {
  try {
    await api('/v1/partner/listing', {
      method: 'PUT',
      body: { listed: str(fd, 'listed') === 'true' },
    });
  } catch (err) {
    return toState(err);
  }

  revalidatePath('/partner/capabilities');
  return { ok: true };
}

export async function publishCapabilities(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const selected = fd.getAll('attribute_keys').map(String).filter(Boolean);
  if (selected.length === 0) {
    return { error: 'Select at least one attribute you can evaluate.' };
  }

  const attributes = selected.map((entry) => {
    // "key|OP,OP,OP" — the operators come from the taxonomy, so a Partner
    // cannot claim one the attribute does not support.
    const [attribute_key, ops] = entry.split('|');
    return { attribute_key, operators: (ops ?? '').split(',').filter(Boolean) };
  });

  const geographies = str(fd, 'geographies')
    .split(',')
    .map((g) => g.trim())
    .filter(Boolean);
  const channels = fd.getAll('channels').map(String).filter(Boolean);
  const mappingVersion = Number(str(fd, 'mapping_version'));

  try {
    await api('/v1/partner/capabilities', {
      // v6 §14 specifies PUT. It is not interchangeable with POST here: the
      // route is declared @Put, so a POST is simply not routed and the publish
      // button silently failed.
      method: 'PUT',
      body: {
        attributes,
        geographies: geographies.length > 0 ? geographies : ['IN'],
        channels: channels.length > 0 ? channels : ['PARTNER_WEB'],
        ...(Number.isInteger(mappingVersion) && mappingVersion > 0
          ? { mapping_version: mappingVersion }
          : {}),
      },
    });
  } catch (err) {
    return toState(err);
  }

  revalidatePath('/partner/capabilities');
  return { ok: true };
}

/**
 * The cross-Partner clean room (docs/DESIGN-PARTNER-DATA.md phase 7): take
 * part, ask another Partner for a run, or answer one. The API checks that
 * both Partners take part, and that only the asked Partner decides.
 */
export async function setCleanRoomParticipation(
  _prev: ActionState,
  fd: FormData,
): Promise<ActionState> {
  try {
    await api('/v1/partner/cleanroom/participation', {
      method: 'PUT',
      body: { enabled: str(fd, 'enabled') === 'true' },
    });
  } catch (err) {
    return toState(err);
  }
  revalidatePath('/partner/cleanroom');
  return { ok: true };
}

export async function requestCleanRoomRun(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const withOrg = str(fd, 'with_org_id');
  if (!withOrg) return { error: 'Choose the Partner to ask.' };
  try {
    await api('/v1/partner/cleanroom/runs', {
      method: 'POST',
      body: { kind: str(fd, 'kind') === 'JOINT' ? 'JOINT' : 'OVERLAP', with_org_id: withOrg },
    });
  } catch (err) {
    return toState(err);
  }
  revalidatePath('/partner/cleanroom');
  return { ok: true };
}

export async function decideCleanRoomRun(
  runId: string,
  _prev: ActionState,
  fd: FormData,
): Promise<ActionState> {
  try {
    await api(`/v1/partner/cleanroom/runs/${runId}/decision`, {
      method: 'POST',
      body: { approve: str(fd, 'approve') === 'true' },
    });
  } catch (err) {
    return toState(err);
  }
  revalidatePath('/partner/cleanroom');
  return { ok: true };
}
