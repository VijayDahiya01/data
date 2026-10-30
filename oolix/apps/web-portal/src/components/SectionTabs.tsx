'use client';

/**
 * The tabs of the rail item the current page belongs to.
 *
 * Pages that serve one job -- a Partner's campaign requests and its running
 * activations, say -- are one item in the rail, and each shows its siblings
 * here. Only on the pages themselves: a request or a campaign step deeper down
 * has its own way back, and a row of tabs above a form step is noise.
 */
import Link from 'next/link';
import { usePathname } from 'next/navigation';

export function SectionTabs({ items }: { items: { tabs: { label: string; href: string }[] }[] }) {
  const pathname = usePathname();
  const current = items.find((i) => i.tabs.some((t) => t.href === pathname));
  if (!current) return null;

  return (
    <nav className="tabs" aria-label="Section">
      {current.tabs.map((t) => (
        <Link
          key={t.href}
          href={t.href}
          className="tab"
          aria-current={t.href === pathname ? 'page' : undefined}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}
