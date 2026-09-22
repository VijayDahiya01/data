'use server';

/**
 * Operational server actions — money, people, supply and Agent identity.
 *
 * Split from `actions.ts`, which covers the campaign path. These are the
 * actions a Partner or Finance user performs to run the business rather than
 * to launch a campaign, and several of them move money or revoke credentials,
 * so they are worth reading together.
 *
 * Everything here runs on the server: the access token never crosses to the
 * browser (§82), and each screen calls these through a plain form, so they work
 * before hydration.
 */
import { randomUUID } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { api, ApiError, NotAuthenticatedError } from './api';

export interface ActionState {
  error?: string;
  fieldErrors?: Record<string, string>;
  ok?: boolean;
}

function toState(err: unknown): ActionState {
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
const list = (fd: FormData, key: string): string[] =>
  str(fd, key)
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);

/* --- payouts and settlement (§50, §76, §83.1, §102) ------------------------- */

/**
 * Move a payout along §76's state machine.
 *
 * CALCULATED to REVIEWED to APPROVED to PAID, and no shortcuts: §76 has no edge
 * from CALCULATED straight to PAID, and a DISPUTED payout cannot be paid at all
 * until the dispute resolves (§83.1). The API enforces that; this only asks.
 *
 * `mark-paid` carries a mandatory Idempotency-Key (§53), for the obvious
 * reason.
 */
export async function advancePayout(
  payoutId: string,
  step: 'review' | 'approve' | 'mark-paid',
  _prev: ActionState,
  _fd: FormData,
): Promise<ActionState> {
  try {
    await api(`/v1/billing/payouts/${payoutId}/${step}`, {
      method: 'POST',
      ...(step === 'mark-paid' ? { idempotencyKey: randomUUID() } : {}),
      body: {},
    });
  } catch (err) {
    return toState(err);
  }

  revalidatePath('/partner/payouts');
  revalidatePath('/billing');
  return { ok: true };
}

/** §83.1: either side may dispute, and the payout is HELD until it resolves. */
export async function disputePayout(
  payoutId: string,
  _prev: ActionState,
  fd: FormData,
): Promise<ActionState> {
  const reason = str(fd, 'reason');
  if (reason.length < 10) return { error: 'Describe the dispute in at least 10 characters.' };

  const claimed = str(fd, 'claimed_qualified_count');

  try {
    await api(`/v1/billing/payouts/${payoutId}/dispute`, {
      method: 'POST',
      body: {
        reason_code: str(fd, 'reason_code') || 'OTHER',
        reason,
        ...(claimed ? { claimed_qualified_count: Number(claimed) } : {}),
      },
    });
  } catch (err) {
    return toState(err);
  }

  revalidatePath('/partner/payouts');
  revalidatePath('/billing');
  return { ok: true };
}

/**
 * §83.1: "Corrections create adjustment FinancialEvents; never mutate
 * historical FinancialEvents."
 *
 * Resolving in the disputing party's favour APPENDS an adjustment. The original
 * accrual stays exactly as it was, which is what makes payout history auditable
 * rather than merely current.
 */
export async function resolvePayoutDispute(
  payoutId: string,
  _prev: ActionState,
  fd: FormData,
): Promise<ActionState> {
  const note = str(fd, 'resolution_note');
  if (note.length < 10) return { error: 'Record how this was resolved (10 characters or more).' };

  const outcome = str(fd, 'outcome') || 'REJECTED_DISPUTE';
  const corrected = str(fd, 'corrected_qualified_count');

  if (outcome === 'ADJUSTED' && !corrected) {
    return { error: 'An adjustment needs the corrected verified count.' };
  }

  try {
    await api(`/v1/billing/payouts/${payoutId}/resolve-dispute`, {
      method: 'POST',
      body: {
        outcome,
        resolution_note: note,
        ...(corrected ? { corrected_qualified_count: Number(corrected) } : {}),
      },
    });
  } catch (err) {
    return toState(err);
  }

  revalidatePath('/partner/payouts');
  revalidatePath('/billing');
  return { ok: true };
}

/* --- team (§35.3, §66) ------------------------------------------------------ */

export async function inviteMember(_prev: ActionState, fd: FormData): Promise<ActionState> {
  try {
    await api('/v1/organizations/members/invite', {
      method: 'POST',
      body: { email: str(fd, 'email'), role: str(fd, 'role') },
    });
  } catch (err) {
    return toState(err);
  }

  revalidatePath('/team');
  return { ok: true };
}

export async function removeMember(
  userId: string,
  _prev: ActionState,
  _fd: FormData,
): Promise<ActionState> {
  try {
    await api(`/v1/organizations/members/${userId}`, { method: 'DELETE' });
  } catch (err) {
    return toState(err);
  }

  revalidatePath('/team');
  return { ok: true };
}

/* --- placements (§43) ------------------------------------------------------- */

export async function createPlacement(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const width = str(fd, 'width');
  const height = str(fd, 'height');

  try {
    await api('/v1/partner/placements', {
      method: 'POST',
      body: {
        placement_key: str(fd, 'placement_key'),
        display_name: str(fd, 'display_name'),
        surface: str(fd, 'surface'),
        format: str(fd, 'format'),
        context_tags: list(fd, 'context_tags'),
        allowed_categories: list(fd, 'allowed_categories'),
        blocked_categories: list(fd, 'blocked_categories'),
        max_frequency_default: Number(str(fd, 'max_frequency_default') || '2'),
        // §43: what the slot shows when no ad is served. It must never be
        // blank — an empty slot on a booking page is a broken page.
        fallback: str(fd, 'fallback') || 'HOUSE_CONTENT',
        ...(width && height
          ? { dimensions: { width: Number(width), height: Number(height) } }
          : {}),
      },
    });
  } catch (err) {
    return toState(err);
  }

  revalidatePath('/partner/placements');
  return { ok: true };
}

/** §43: the Partner may disable any placement unilaterally. */
export async function setPlacementStatus(
  placementId: string,
  status: 'ACTIVE' | 'DISABLED',
  _prev: ActionState,
  _fd: FormData,
): Promise<ActionState> {
  try {
    await api(`/v1/partner/placements/${placementId}/status`, {
      method: 'POST',
      body: { status },
    });
  } catch (err) {
    return toState(err);
  }

  revalidatePath('/partner/placements');
  return { ok: true };
}

/* --- Partner Agent identity (§92) ------------------------------------------- */

export interface TokenState extends ActionState {
  token?: string;
  expiresAt?: string;
}

/**
 * Mint a bootstrap token (§92.1).
 *
 * Returned in plaintext ONCE and stored only as a SHA-256, so the value is
 * handed straight back to the caller and saved nowhere. Single-use, 15 minutes.
 */
export async function createBootstrapToken(_prev: TokenState, _fd: FormData): Promise<TokenState> {
  try {
    const res = await api<{ bootstrap_token: string; expires_at: string }>(
      '/v1/partner/agents/bootstrap-tokens',
      { method: 'POST', body: {} },
    );
    revalidatePath('/partner/integrations');
    return { ok: true, token: res.bootstrap_token, expiresAt: res.expires_at };
  } catch (err) {
    return toState(err);
  }
}

export async function revokeBootstrapTokens(
  _prev: ActionState,
  _fd: FormData,
): Promise<ActionState> {
  try {
    await api('/v1/partner/agents/bootstrap-tokens/revoke', { method: 'POST', body: {} });
  } catch (err) {
    return toState(err);
  }

  revalidatePath('/partner/integrations');
  return { ok: true };
}

/**
 * §69.3: "Oolix may revoke an Agent immediately during incident response."
 *
 * Effective at once, not at token expiry — the guard re-reads Agent status on
 * every call. A reason is mandatory and audited (§83).
 */
export async function revokeAgent(
  agentId: string,
  _prev: ActionState,
  fd: FormData,
): Promise<ActionState> {
  const reason = str(fd, 'reason');
  if (reason.length < 3) return { error: 'A reason is required, and it is recorded.' };

  try {
    await api(`/v1/partner/agents/${agentId}/revoke`, { method: 'POST', body: { reason } });
  } catch (err) {
    return toState(err);
  }

  revalidatePath('/partner/integrations');
  return { ok: true };
}

/* --- CRM connection (§71) --------------------------------------------------- */

export interface KeyState extends ActionState {
  apiKey?: string;
}

/** §71: the plaintext key is returned ONCE; only its hash is stored. */
export async function issueCrmKey(_prev: KeyState, _fd: FormData): Promise<KeyState> {
  try {
    const res = await api<{ api_key: string }>('/v1/buyer/crm-keys', { method: 'POST', body: {} });
    revalidatePath('/connections');
    return { ok: true, apiKey: res.api_key };
  } catch (err) {
    return toState(err);
  }
}

/* --- reconciliation (§77.3) -------------------------------------------------- */

export interface ReconcileState extends ActionState {
  result?: {
    agent_count: number;
    central_count: number;
    difference: number;
    tolerance: number;
    status: string;
    note: string | null;
  };
}

/**
 * §77.3: tolerance is max(10 events, 0.5% of the Agent count). A difference
 * beyond it raises a review and explicitly does NOT alter Partner payout.
 */
export async function reconcileActivation(
  activationId: string,
  _prev: ReconcileState,
  fd: FormData,
): Promise<ReconcileState> {
  const agentCount = Number(str(fd, 'agent_count'));
  if (!Number.isInteger(agentCount) || agentCount < 0) {
    return { error: 'Enter the count your Agent recorded.' };
  }

  const date = str(fd, 'date');

  try {
    const result = await api<ReconcileState['result']>(
      `/v1/reports/reconcile/${activationId}${date ? `?date=${date}` : ''}`,
      { method: 'POST', body: { agent_count: agentCount } },
    );
    revalidatePath('/partner/reports');
    return { ok: true, result };
  } catch (err) {
    return toState(err);
  }
}

/* --- platform organization administration (§35.2, §66, §98.1) -------------- */

/**
 * Record that an organization is a real legal entity.
 *
 * §66.3 gates campaign submission and supply publication on BUSINESS_VERIFIED,
 * and until this existed nothing in the running system could grant it: the
 * only writer of that state was the development seed, which refuses to run
 * against production. A deployment could onboard an organization and then
 * refuse everything it tried to do.
 *
 * §66's limit is untouched. Verifying a business says it is who it claims to
 * be. It does not approve a campaign on a Data Partner's behalf, and
 * OOLIX_ADMIN still holds no permission that could.
 */
export async function verifyOrganization(
  orgId: string,
  _prev: ActionState,
  fd: FormData,
): Promise<ActionState> {
  const note = str(fd, 'note');

  try {
    await api(`/v1/admin/organizations/${orgId}/verify`, {
      method: 'POST',
      body: { ...(note ? { note } : {}) },
    });
  } catch (err) {
    return toState(err);
  }

  revalidatePath('/admin/organizations');
  return { ok: true };
}

/**
 * Put a verified organization back to pending.
 *
 * A reason is required by the API, and asked for here rather than sent empty:
 * this is the action somebody will be asked to explain months later.
 */
export async function revokeOrganizationVerification(
  orgId: string,
  _prev: ActionState,
  fd: FormData,
): Promise<ActionState> {
  const reason = str(fd, 'reason');
  if (reason.length < 3) return { error: 'Give a reason — it is written to the audit trail.' };

  try {
    await api(`/v1/admin/organizations/${orgId}/revoke-verification`, {
      method: 'POST',
      body: { reason },
    });
  } catch (err) {
    return toState(err);
  }

  revalidatePath('/admin/organizations');
  return { ok: true };
}
