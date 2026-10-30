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
import { bestMatch } from './paths';

export function NavLink({
  href,
  paths,
  siblings,
  children,
}: {
  href: string;
  /** The pages this link covers: its own, or those of its tabs. */
  paths: string[];
  /** Every path the navigation covers, so the most specific one can win. */
  siblings: string[];
  children: ReactNode;
}) {
  const pathname = usePathname();

  // The MOST SPECIFIC matching path wins, and only the link that covers it is
  // current.
  //
  // A plain prefix test lights up every ancestor: on /partner/requests both
  // "Home" (/partner) and "Campaigns" (/partner/requests) matched, so the rail
  // showed two current pages and neither could be trusted.
  const best = bestMatch(pathname, siblings);
  const active = best !== undefined && paths.includes(best);

  return (
    <Link href={href} className="nav-link" aria-current={active ? 'page' : undefined}>
      <NavIcon href={href} />
      <span>{children}</span>
    </Link>
  );
}
