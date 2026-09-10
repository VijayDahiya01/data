'use client';

/**
 * A sidebar link that knows whether it is the current page.
 *
 * Client component purely for `usePathname`. It renders no data of its own, so
 * nothing sensitive crosses to the browser.
 */
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { NavIcon } from './NavIcon';

export function NavLink({
  href,
  siblings,
  children,
}: {
  href: string;
  /** Every href the navigation offers, so the most specific one can win. */
  siblings: string[];
  children: ReactNode;
}) {
  const pathname = usePathname();

  // The MOST SPECIFIC matching link wins, and only that one.
  //
  // A plain prefix test lights up every ancestor: on /partner/requests both
  // "Dashboard" (/partner) and "Campaign requests" (/partner/requests) matched,
  // so the rail showed two current pages and neither could be trusted. Asking
  // whether any sibling is a longer match settles it without per-item flags.
  const matches = (candidate: string) =>
    pathname === candidate || (candidate !== '/' && pathname.startsWith(`${candidate}/`));

  const active =
    matches(href) &&
    !siblings.some((other) => other !== href && other.length > href.length && matches(other));

  return (
    <Link href={href} className="nav-link" aria-current={active ? 'page' : undefined}>
      <NavIcon href={href} />
      <span>{children}</span>
    </Link>
  );
}
