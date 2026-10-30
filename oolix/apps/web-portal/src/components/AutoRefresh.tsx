'use client';

/**
 * Re-renders the page from the server every few seconds, for a while.
 *
 * Rendered only while something is still on its way -- a Partner working out a
 * reach estimate -- so the answer appears without a reload. It gives up after
 * `times` refreshes: an Agent that is down should not keep a page polling
 * forever. `router.refresh()` keeps client state, so a half-filled form on the
 * same page is left alone.
 */
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

export function AutoRefresh({ every = 3000, times = 20 }: { every?: number; times?: number }) {
  const router = useRouter();
  useEffect(() => {
    let n = 0;
    const timer = setInterval(() => {
      n += 1;
      if (n > times) clearInterval(timer);
      else router.refresh();
    }, every);
    return () => clearInterval(timer);
  }, [router, every, times]);
  return null;
}
