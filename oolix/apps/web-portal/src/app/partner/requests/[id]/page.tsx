/**
 * Partner Campaign Approval Center — one request (§41).
 *
 * §41 lists exactly what a Partner must see before deciding, and why each item
 * matters. Every row in that table is on this page, in that order, because the
 * decision this screen supports is the one thing Oolix can never make on a
 * Partner's behalf (§31).
 */
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireContext, can } from '@/lib/nav-entry';
import { apiOptional } from '@/lib/api';
import { Shell } from '@/components/Shell';
import {
  Card,
  Money,
  Notice,
  PageHeader,
  Reach,
  StatusBadge,
  dateTime,
  relative,
} from '@/components/ui';
import {
  ApproveForm,
  ExtendForm,
  RejectForm,
  RequestChangeForm,
  type DecisionChannel,
  type DecisionCreative,
} from '@/components/DecisionForms';

interface RequestDetail {
  request_id: string;
  status: string;
  request_version: number;
  submitted_at: string;
  expires_at: string | null;
  extension_count: number;
  /** §66.2: whether the person viewing this created the campaign. */
  viewer_created_this_campaign?: boolean;
  buyer: {
    organization_id: string;
    name: string;
    domain: string;
    verification_status: string;
    brand?: { name: string; website: string } | null;
  };
  campaign: {
    name: string;
    objective: string;
    category: string;
    purpose_id: string;
    start_at: string;
    end_at: string;
    geographies: string[];
    landing_url?: string | null;
    lead_definition?: { qualified_statuses?: string[]; duplicate_window_days?: number } | null;
  };
  // v6 §19: one of these two, never both. A prebuilt segment is the legacy
  // shape; an audience is the Buyer's own rule set (§10).
  segment: {
    id: string;
    display_name: string;
    internal_key: string;
    reach_bucket: string | null;
  } | null;
  targeting_source?: string;
  audience: {
    audience_group_id: string;
    name: string;
    description: string | null;
    audience_version: number;
    rule_hash: string;
    rules: {
      attribute: string;
      operator: string;
      value: unknown;
      required: boolean;
      weight: number;
    }[];
    reach_estimate: {
      status: string;
      reach_bucket: string | null;
      freshness_at: string | null;
      mapping_version: number | null;
    } | null;
  } | null;
  channels: (DecisionChannel & { frequency_cap?: { max_impressions: number; window: string } })[];
  creatives: (DecisionCreative & {
    body?: string | null;
    cta?: string | null;
    destination_url: string;
    legal_disclaimer?: string | null;
    asset_url?: string | null;
    content_sha256: string;
    decision?: string | null;
  })[];
  commercial: {
    pricing_model: string;
    unit_price_minor: number;
    currency: string;
    platform_fee_bps: number;
  } | null;
  audience_expansion_requested: boolean;
  policy_version: string;
  decision_history: {
    decision: string;
    decision_version: number;
    reason: string | null;
    at: string;
  }[];
}

/** Render a stored rule value the way the Buyer wrote it. */
function renderRuleValue(value: unknown, operator: string): string {
  if (Array.isArray(value)) {
    return operator === 'BETWEEN' ? `${value[0]}–${value[1]}` : value.join(', ');
  }
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  return String(value ?? '');
}

export default async function PartnerRequestDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const ctx = await requireContext(`/partner/requests/${id}`);

  const req = await apiOptional<RequestDetail>(`/v1/partner-requests/${id}`);
  if (!req) notFound();

  // v6 §10 asks the review to show "field coverage" — whether THIS Partner can
  // actually evaluate each rule. That answer comes from their own published
  // capabilities, not from anything the Buyer sent.
  const [taxonomy, capabilities] = await Promise.all([
    req.audience
      ? apiOptional<{ items: { key: string; display_name: string }[] }>('/v1/audiences/taxonomy')
      : Promise.resolve(null),
    req.audience
      ? apiOptional<{ attributes: { attribute_key: string }[] }>('/v1/partner/capabilities')
      : Promise.resolve(null),
  ]);

  const attributeName = (key: string) =>
    taxonomy?.items.find((a) => a.key === key)?.display_name ?? key;
  const coveredKeys = new Set((capabilities?.attributes ?? []).map((a) => a.attribute_key));
  const uncoveredRequired = (req.audience?.rules ?? [])
    .filter((r) => r.required && !coveredKeys.has(r.attribute))
    .map((r) => r.attribute);

  const open = req.status === 'PARTNER_REVIEW';
  const mayApprove = can(ctx, 'request:approve');
  const mayReject = can(ctx, 'request:reject');
  const mayChange = can(ctx, 'request:change');
  const mayExtend = can(ctx, 'request:extend');

  const totalAllocation = req.channels.reduce((s, c) => s + Number(c.allocation_minor), 0);

  // A request can legitimately arrive with no proposed payout terms. §41 lists
  // the commercial basis among the things a Partner decides on, so the absence
  // has to be stated rather than rendered as a blank row -- approving a
  // campaign with no agreed basis is exactly the mistake that would cause.
  const currency = req.commercial?.currency ?? 'INR';

  return (
    <Shell ctx={ctx}>
      <PageHeader
        title={req.campaign.name}
        lead={
          <>
            <StatusBadge status={req.status} />{' '}
            <span className="faint">v{req.request_version}</span>
            {open && req.expires_at ? (
              <span className="faint"> · decision due {relative(req.expires_at)}</span>
            ) : null}
          </>
        }
      />

      <Card title="Who is advertising">
        <div className="table-wrap">
          <table>
            <tbody>
              <tr>
                <th>Buyer</th>
                <td>
                  {req.buyer.name} <StatusBadge status={req.buyer.verification_status} />
                  <br />
                  <span className="faint">{req.buyer.domain}</span>
                </td>
              </tr>
              <tr>
                <th>Brand</th>
                <td>
                  {req.buyer.brand?.name ?? '—'}
                  {req.buyer.brand?.website ? (
                    <>
                      <br />
                      <span className="faint">{req.buyer.brand.website}</span>
                    </>
                  ) : null}
                </td>
              </tr>
              <tr>
                <th>Category</th>
                <td>
                  {req.campaign.category}
                  <div className="field-hint">
                    Checked against your policy {req.policy_version}.
                  </div>
                </td>
              </tr>
              <tr>
                <th>Purpose</th>
                <td>
                  <code>{req.campaign.purpose_id}</code>
                  <div className="field-hint">
                    Your Agent checks consent against this purpose locally, and fails closed if it
                    cannot confirm eligibility.
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </Card>

      {req.audience ? (
        <Card title={`Audience rules · ${req.audience.name}`}>
          <p className="faint small">
            You are approving a <strong>set of conditions</strong>, not an audience you already
            published. Your Agent applies these conditions to your own data and builds the matching
            list inside your systems. Nothing about who matched ever leaves them.
          </p>

          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Attribute</th>
                  <th>Condition</th>
                  <th>Requirement</th>
                  <th>Your coverage</th>
                </tr>
              </thead>
              <tbody>
                {[...req.audience.rules]
                  .sort((a, b) => Number(b.required) - Number(a.required))
                  .map((r) => {
                    const covered = coveredKeys.has(r.attribute);
                    return (
                      <tr key={r.attribute}>
                        <td>{attributeName(r.attribute)}</td>
                        <td>
                          <code className="small">
                            {r.operator} {renderRuleValue(r.value, r.operator)}
                          </code>
                        </td>
                        <td>
                          {r.required ? (
                            <strong>Required</strong>
                          ) : (
                            <span className="faint">Optional</span>
                          )}
                        </td>
                        <td>
                          {covered ? (
                            <span className="badge badge-ok">can evaluate</span>
                          ) : r.required ? (
                            <span className="badge badge-danger">not declared</span>
                          ) : (
                            <span className="faint">not applied</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </div>

          <div className="table-wrap" style={{ marginTop: '1rem' }}>
            <table>
              <tbody>
                <tr>
                  <th>Reach</th>
                  <td>
                    {!req.audience.reach_estimate ? (
                      <span className="faint">not estimated yet</span>
                    ) : req.audience.reach_estimate.status === 'BELOW_THRESHOLD' ? (
                      <span className="faint">too small to report</span>
                    ) : (
                      <>
                        <Reach bucket={req.audience.reach_estimate.reach_bucket} />
                        <div className="faint">Worked out by your own systems.</div>
                      </>
                    )}
                  </td>
                </tr>
                <tr>
                  <th>Applies to</th>
                  <td>
                    These exact conditions.
                    <div className="faint">
                      If the Buyer changes them, your approval stops applying and they must ask
                      again.
                    </div>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          {uncoveredRequired.length > 0 ? (
            <Notice tone="danger">
              This request contains a <strong>required</strong> rule you have not declared:{' '}
              {uncoveredRequired.map(attributeName).join(', ')}. Your Agent cannot evaluate it, so
              approving would serve people who do not meet a condition the Buyer called mandatory.
              Publish the capability first, or request a change.
            </Notice>
          ) : null}
        </Card>
      ) : null}

      <Card title="Audience and where it runs">
        <div className="table-wrap">
          <table>
            <tbody>
              {req.segment ? (
                <tr>
                  <th>Segment</th>
                  <td>
                    {req.segment.display_name} <Reach bucket={req.segment.reach_bucket} />
                    <br />
                    <span className="faint">
                      Your key: <code>{req.segment.internal_key}</code>. Membership is resolved
                      inside your systems — Oolix never receives the list.
                    </span>
                  </td>
                </tr>
              ) : req.audience ? (
                <tr>
                  <th>Audience</th>
                  <td>
                    <strong>{req.audience.name}</strong>{' '}
                    <span className="faint">v{req.audience.audience_version}</span>
                    <br />
                    <span className="faint">
                      A rule set the Buyer wrote. Your Agent evaluates it against your own data —
                      the rules travel to you, your customers never travel to them.
                    </span>
                  </td>
                </tr>
              ) : null}
              <tr>
                <th>Channels</th>
                <td>
                  {req.channels.map((c) => (
                    <div key={c.channel}>
                      {c.channel.replaceAll('_', ' ').toLowerCase()}
                      {c.channel === 'META' || c.channel === 'GOOGLE' ? (
                        <span className="badge badge-warn"> external</span>
                      ) : null}{' '}
                      · <Money minor={c.allocation_minor} currency={currency} />
                      {c.frequency_cap ? (
                        <span className="faint">
                          {' '}
                          · cap {c.frequency_cap.max_impressions} per {c.frequency_cap.window}
                        </span>
                      ) : null}
                    </div>
                  ))}
                </td>
              </tr>
              <tr>
                <th>Dates</th>
                <td>
                  {dateTime(req.campaign.start_at)} – {dateTime(req.campaign.end_at)}
                  <br />
                  <span className="faint">{req.campaign.geographies.join(', ')}</span>
                </td>
              </tr>
              <tr>
                <th>Audience expansion</th>
                <td>
                  {req.audience_expansion_requested ? (
                    <span className="badge badge-warn">requested</span>
                  ) : (
                    <span className="badge">not requested</span>
                  )}
                  <div className="field-hint">
                    Stays off unless you grant it. Requesting it does not enable it.
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </Card>

      <Card title="Creative and destination">
        {req.creatives.map((c) => (
          <div key={c.creative_version_id} style={{ marginBottom: '1rem' }}>
            <strong>
              v{c.version} · {c.type.replaceAll('_', ' ').toLowerCase()}
            </strong>
            {c.decision ? (
              <>
                {' '}
                <StatusBadge status={c.decision} />
              </>
            ) : null}
            {c.asset_url ? (
              <div style={{ margin: '0.5rem 0' }}>
                {/*
                  A plain <img>, not next/image: the creative lives in object
                  storage whose host differs per environment, and the Partner
                  must see the exact bytes their approval will bind to —
                  not a re-encoded, resized version of them.
                */}
                <img
                  src={c.asset_url}
                  alt={c.headline ?? `Creative version ${c.version}`}
                  style={{ maxWidth: '320px', border: '1px solid var(--border)', borderRadius: 8 }}
                />
              </div>
            ) : null}
            {c.headline ? (
              <div>
                <strong>{c.headline}</strong>
              </div>
            ) : null}
            {c.body ? <div className="muted">{c.body}</div> : null}
            {c.cta ? (
              <div className="faint">CTA: {c.cta.replaceAll('_', ' ').toLowerCase()}</div>
            ) : null}
            {c.legal_disclaimer ? <div className="faint">{c.legal_disclaimer}</div> : null}
            <div className="faint">
              Destination: <code>{c.destination_url}</code>
            </div>
            <div className="faint">
              Your approval covers this exact creative. If any part of it is changed, it becomes a
              new version that you have not approved.
            </div>
          </div>
        ))}
      </Card>

      <Card title="Commercial basis">
        {!req.commercial ? (
          <Notice tone="warn">
            This request proposes <strong>no payout terms</strong>. Approving it would let the
            campaign run without an agreed basis for what you are paid. Ask for a change before
            approving.
          </Notice>
        ) : null}
        <div className="table-wrap">
          <table>
            <tbody>
              <tr>
                <th>Pricing</th>
                <td>
                  {req.commercial ? (
                    <>
                      {req.commercial.pricing_model} ·{' '}
                      <Money minor={req.commercial.unit_price_minor} currency={currency} /> per unit
                    </>
                  ) : (
                    <span className="muted">none proposed</span>
                  )}
                </td>
              </tr>
              <tr>
                <th>Requested budget</th>
                <td>
                  <Money minor={totalAllocation} currency={currency} />
                </td>
              </tr>
              <tr>
                <th>Platform fee</th>
                <td>
                  {req.commercial ? `${(req.commercial.platform_fee_bps / 100).toFixed(2)}%` : '—'}
                </td>
              </tr>
              {req.campaign.lead_definition?.qualified_statuses?.length ? (
                <tr>
                  <th>You are paid on</th>
                  <td>
                    {req.campaign.lead_definition.qualified_statuses.join(', ').toLowerCase()}
                    <div className="field-hint">
                      Verified by the Buyer&rsquo;s CRM, not by click counts.
                    </div>
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </Card>

      {req.decision_history.length ? (
        <Card title="Decision history">
          <ul className="muted" style={{ margin: 0, paddingLeft: '1.1rem' }}>
            {req.decision_history.map((d, i) => (
              <li key={`${d.decision}-${i}`}>
                <strong>{d.decision.toLowerCase()}</strong> · v{d.decision_version} ·{' '}
                {dateTime(d.at)}
                {d.reason ? ` — ${d.reason}` : ''}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {open ? (
        <>
          <Notice tone="plain">
            This decision is yours. Neither Oolix nor the network sponsor can override it, and
            letting the clock run out is not approval — the request simply expires and the Buyer may
            resubmit.
          </Notice>

          {/* §66.2 separation of duties. Saying this before the decision
              beats failing after it: the rule is not obvious, and the error it
              produces reads like something went wrong rather than like a
              control doing its job. Deliberately does not name who created the
              campaign — only that it was this viewer. */}
          {mayApprove && req.viewer_created_this_campaign ? (
            <Notice tone="warn">
              You created this campaign, so you cannot also approve it. Someone else at{' '}
              {ctx.active_organization?.name ?? 'your organization'} with approval rights has to
              make this decision.
            </Notice>
          ) : null}

          {mayApprove && !req.viewer_created_this_campaign ? (
            <Card title="Approve">
              <ApproveForm
                requestId={id}
                channels={req.channels}
                creatives={req.creatives}
                expansionRequested={req.audience_expansion_requested}
              />
            </Card>
          ) : null}

          {mayChange ? (
            <Card title="Request a change">
              <RequestChangeForm requestId={id} />
            </Card>
          ) : null}

          {mayReject ? (
            <Card title="Reject">
              <RejectForm requestId={id} />
            </Card>
          ) : null}

          {mayExtend ? (
            <Card title="Need more time?">
              <ExtendForm requestId={id} alreadyExtended={req.extension_count > 0} />
            </Card>
          ) : null}

          {!mayApprove && !mayReject && !mayChange ? (
            <Notice tone="warn">
              Your role can view this request but not decide on it. A Partner campaign approver or
              admin must act.
            </Notice>
          ) : null}
        </>
      ) : (
        <Notice tone="plain">
          This request is {req.status.replaceAll('_', ' ').toLowerCase()}. Approved activations can
          still be stopped at any time from{' '}
          <Link href="/partner/activations">Active activations</Link> — that right is unilateral and
          immediate.
        </Notice>
      )}
    </Shell>
  );
}
