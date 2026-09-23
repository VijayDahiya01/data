/**
 * Shared display primitives.
 *
 * The money and reach helpers here are not cosmetic. §53 stores money as
 * integer minor units and §72 publishes reach as a BUCKET, so formatting is
 * the one place a float or an exact count could sneak into the UI. Doing it in
 * one place means it is done the same way everywhere.
 */
import type { ReactNode } from 'react';

export function PageHeader({
  title,
  lead,
  actions,
}: {
  title: string;
  lead?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="page-header">
      <div
        style={{
          display: 'flex',
          gap: '1rem',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
        }}
      >
        <div>
          <h1>{title}</h1>
          {lead ? <p>{lead}</p> : null}
        </div>
        {actions ? (
          <div className="btn-row" style={{ marginTop: 0 }}>
            {actions}
          </div>
        ) : null}
      </div>
    </header>
  );
}

export function Card({ title, children }: { title?: ReactNode; children: ReactNode }) {
  return (
    <section className="card">
      {title ? <h2>{title}</h2> : null}
      {children}
    </section>
  );
}

export function Stat({
  label,
  value,
  note,
}: {
  label: string;
  value: ReactNode;
  note?: ReactNode;
}) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {note ? <div className="stat-note">{note}</div> : null}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return (
    <p className="muted" style={{ margin: '0.5rem 0' }}>
      {children}
    </p>
  );
}

export function Notice({
  tone = 'info',
  children,
}: {
  tone?: 'info' | 'warn' | 'danger' | 'plain';
  children: ReactNode;
}) {
  const cls = tone === 'plain' ? 'notice' : `notice notice-${tone}`;
  return <div className={cls}>{children}</div>;
}

/* --- status ---------------------------------------------------------------- */

const OK = new Set([
  'ACTIVE',
  'APPROVED',
  'LIVE',
  'PAID',
  'READY',
  'PUBLISHED',
  'BUSINESS_VERIFIED',
  'READY_FOR_CAMPAIGNS',
  'VERIFIED',
  'QUALIFIED',
  'CONVERTED',
  'PASS',
  'AVAILABLE',
  'ELIGIBLE',
  'HEALTHY',
]);

const WARN = new Set([
  'DRAFT',
  'PARTNER_REVIEW',
  'CHANGE_REQUESTED',
  'PENDING_CHANNEL_CHECK',
  'SYNCING',
  'PAUSED',
  'CALCULATED',
  'REVIEWED',
  'ADJUSTED',
  'REVIEW_REQUIRED',
  'CONDITIONAL',
  'PARTIALLY_LIVE',
  'BUSINESS_VERIFICATION_PENDING',
  'MIXED',
  'RECEIVED',
  'ENDING',
]);

const DANGER = new Set([
  'REJECTED',
  'REVOKED',
  'EXPIRED',
  'FAILED',
  'SUSPENDED',
  'DISPUTED',
  'BLOCKED',
  'UNAVAILABLE',
  'STALE',
]);

export function StatusBadge({ status }: { status: string | null | undefined }) {
  if (!status) return <span className="badge">—</span>;

  const tone = OK.has(status)
    ? 'badge badge-ok'
    : WARN.has(status)
      ? 'badge badge-warn'
      : DANGER.has(status)
        ? 'badge badge-danger'
        : 'badge';

  return <span className={tone}>{status.replaceAll('_', ' ').toLowerCase()}</span>;
}

/* --- money and reach -------------------------------------------------------- */

/**
 * §53: money is integer minor units plus an ISO-4217 code. It is converted to a
 * decimal exactly once, here, for display -- never for arithmetic.
 */
export function money(amountMinor: number | string | null | undefined, currency = 'INR'): string {
  if (amountMinor === null || amountMinor === undefined) return '—';
  const minor = typeof amountMinor === 'string' ? Number(amountMinor) : amountMinor;
  if (!Number.isFinite(minor)) return '—';

  try {
    return new Intl.NumberFormat(currency === 'INR' ? 'en-IN' : 'en-US', {
      style: 'currency',
      currency,
      minimumFractionDigits: 2,
    }).format(minor / 100);
  } catch {
    return `${(minor / 100).toFixed(2)} ${currency}`;
  }
}

export function Money({
  minor,
  currency,
}: {
  minor: number | string | null | undefined;
  currency?: string;
}) {
  return <span style={{ fontVariantNumeric: 'tabular-nums' }}>{money(minor, currency)}</span>;
}

const REACH_LABELS: Record<string, string> = {
  UNDER_10K: 'under 10K',
  '10K_50K': '10K – 50K',
  '50K_100K': '50K – 100K',
  '100K_250K': '100K – 250K',
  '250K_500K': '250K – 500K',
  '500K_1M': '500K – 1M',
  OVER_1M: 'over 1M',
};

/**
 * §72: reach is ALWAYS a bucket. There is deliberately no component that
 * renders an exact count, because the API never returns one.
 */
export function Reach({ bucket }: { bucket: string | null | undefined }) {
  if (!bucket) return <span className="muted">not published</span>;
  return <span className="badge badge-info">{REACH_LABELS[bucket] ?? bucket}</span>;
}

export function dateTime(value: string | null | undefined): string {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  // §53: UTC over the API, local in the UI.
  return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export function dateOnly(value: string | null | undefined): string {
  if (!value) return '—';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString(undefined, { dateStyle: 'medium' });
}

/**
 * A number of seconds, said the way a person would say it.
 *
 * The Agent reports config age as a plain count of seconds, and a table cell
 * reading "347s" asks the reader to do arithmetic before they can tell whether
 * anything is wrong.
 */
export function duration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return '—';
  if (seconds < 60) return 'under a minute';

  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;

  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'}`;

  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'}`;
}

/** "in 3 days" / "2 hours ago" — used for approval SLA clocks (§101). */
export function relative(value: string | null | undefined): string {
  if (!value) return '—';
  const ms = new Date(value).getTime() - Date.now();
  if (Number.isNaN(ms)) return '—';

  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  const abs = Math.abs(ms);
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ['day', 86_400_000],
    ['hour', 3_600_000],
    ['minute', 60_000],
  ];
  for (const [unit, size] of units) {
    if (abs >= size) return rtf.format(Math.round(ms / size), unit);
  }
  return rtf.format(Math.round(ms / 1000), 'second');
}
