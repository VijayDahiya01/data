/**
 * The application shell — one responsive app for every persona (§34).
 *
 * The sidebar is built from the caller's PERMISSIONS, not their role name
 * (§4.2). The organization switcher exists because §34 requires role switching
 * without a second account: a person who works for a Buyer and a Data Partner
 * signs in once and moves between them here.
 */
import Link from 'next/link';
import type { ReactNode } from 'react';
import { itemPaths, navigationFor, restrictionNotice } from '@/lib/navigation';
import type { MeContext } from '@/lib/context';
import { OrgSwitcher } from './OrgSwitcher';
import { NavLink } from './NavLink';
import { SectionTabs } from './SectionTabs';

export function Shell({ ctx, children }: { ctx: MeContext; children: ReactNode }) {
  const groups = navigationFor(ctx);
  const notice = restrictionNotice(ctx);
  // Every path the rail covers, so each link can tell whether a more specific
  // one also matches the current path.
  const allPaths = groups.flatMap((g) => g.items.flatMap(itemPaths));
  // A heading per persona only helps someone who has more than one.
  const labelled = groups.filter((g) => g.persona).length > 1;
  const tabbed = groups
    .flatMap((g) => g.items)
    .filter((i) => (i.tabs?.length ?? 0) > 1)
    .map((i) => ({ tabs: i.tabs ?? [] }));

  return (
    <div className="shell">
      <nav className="sidebar" aria-label="Primary">
        <Link href="/" className="brand">
          <span className="brand-mark" aria-hidden="true">
            OX
          </span>
          Oolix
        </Link>

        <OrgSwitcher ctx={ctx} />

        {groups.map((group) => (
          <div className="nav-group" key={group.persona || 'settings'}>
            {labelled && group.persona ? (
              <div className="nav-group-label">{group.persona}</div>
            ) : null}
            {group.items.map((item) => (
              <NavLink key={item.href} href={item.href} paths={itemPaths(item)} siblings={allPaths}>
                {item.label}
              </NavLink>
            ))}
          </div>
        ))}

        <div className="rail-footer">
          <div className="rail-identity">
            <strong>{ctx.user.name}</strong>
            <span>{ctx.user.email}</span>
          </div>
          <form action="/api/auth/logout" method="post">
            <button type="submit">Sign out</button>
          </form>
        </div>
      </nav>

      <main className="content">
        {notice ? <div className="notice notice-warn">{notice}</div> : null}
        <SectionTabs items={tabbed} />
        {children}
      </main>
    </div>
  );
}
