/**
 * A screen that exists in the navigation but has no interface yet.
 *
 * Deliberately explicit about WHY, and about what does work today. A blank page
 * or a 404 would leave someone wondering whether the feature is broken; this
 * says which capability is already in the API and what is not built, so nobody
 * mistakes "no screen" for "no such thing".
 */
import Link from 'next/link';
import type { ReactNode } from 'react';
import { Card, Notice, PageHeader } from './ui';

export function Placeholder({
  title,
  lead,
  works,
  missing,
  next: nextLink,
}: {
  title: string;
  lead: string;
  /** What this part of Oolix already does. */
  works: ReactNode[];
  /** What has no screen yet. */
  missing: ReactNode[];
  next?: { href: string; label: string };
}) {
  return (
    <>
      <PageHeader title={title} lead={lead} />

      <Card title="What already works">
        <ul className="muted" style={{ margin: 0, paddingLeft: '1.1rem' }}>
          {works.map((w, i) => (
            <li key={i}>{w}</li>
          ))}
        </ul>
      </Card>

      <Card title="What is not here yet">
        <ul className="muted" style={{ margin: 0, paddingLeft: '1.1rem' }}>
          {missing.map((m, i) => (
            <li key={i}>{m}</li>
          ))}
        </ul>
      </Card>

      <Notice tone="plain">
        This part of Oolix works today — it is the screen that is missing, not the capability.
        {nextLink ? (
          <>
            {' '}
            <Link href={nextLink.href}>{nextLink.label}</Link>
          </>
        ) : null}
      </Notice>
    </>
  );
}
