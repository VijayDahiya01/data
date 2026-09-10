/**
 * Navigation icons — flat 2D vector, drawn on a 24-unit grid.
 *
 * Inline SVG rather than an icon package: the whole set is twenty small shapes,
 * and a dependency would add a build step, a bundle and a licence for something
 * that fits in one file. It also means the stroke inherits `currentColor`, so
 * an icon is always exactly the colour of the label beside it — including the
 * accent when its page is current.
 *
 * One geometric language throughout: 1.75 stroke, round caps and joins, no
 * fills, no gradients. Each glyph says what its section IS rather than being
 * decoration — overlapping circles for Audiences because that is literally what
 * matching two audiences looks like; a stack for prebuilt ones because they
 * arrive ready-made in layers.
 */

type Glyph = (typeof GLYPHS)[keyof typeof GLYPHS];

/** Paths only. The wrapper supplies size, stroke and colour. */
const GLYPHS = {
  home: <path d="M3 10.5 12 3l9 7.5M5.5 9v11h13V9" />,
  campaigns: <path d="M4 9v6h4l6 4V5L8 9H4Zm13.5-1.5a6 6 0 0 1 0 9" />,
  audiences: (
    <>
      <circle cx="9.5" cy="12" r="5.5" />
      <circle cx="14.5" cy="12" r="5.5" />
    </>
  ),
  layers: <path d="m12 3 9 5-9 5-9-5 9-5Zm9 11-9 5-9-5" />,
  image: (
    <>
      <rect x="3" y="4.5" width="18" height="15" rx="2.5" />
      <circle cx="8.5" cy="10" r="1.75" />
      <path d="m3.5 17 5-4.5 4 3.5 3-2.5 5 4" />
    </>
  ),
  person: (
    <>
      <circle cx="12" cy="8" r="3.75" />
      <path d="M4.5 20a7.5 7.5 0 0 1 15 0" />
    </>
  ),
  chart: <path d="M4 20V10m5 10V4m5 16v-7m5 7V8" />,
  card: (
    <>
      <rect x="2.5" y="5" width="19" height="14" rx="2.5" />
      <path d="M2.5 10h19M6 15h4" />
    </>
  ),
  link: (
    <path d="M10 14a4.5 4.5 0 0 0 6.5 0l3-3a4.6 4.6 0 0 0-6.5-6.5l-1.5 1.5m-1.5 4a4.5 4.5 0 0 0-6.5 0l-3 3a4.6 4.6 0 0 0 6.5 6.5L8.5 18" />
  ),
  team: (
    <>
      <circle cx="9" cy="8.5" r="3.25" />
      <path d="M2.5 19.5a6.5 6.5 0 0 1 13 0M16 5.6a3.25 3.25 0 0 1 0 5.8m2 2.2a6.5 6.5 0 0 1 3.5 5.9" />
    </>
  ),
  grid: (
    <>
      <rect x="3.5" y="3.5" width="7" height="7" rx="1.5" />
      <rect x="13.5" y="3.5" width="7" height="7" rx="1.5" />
      <rect x="3.5" y="13.5" width="7" height="7" rx="1.5" />
      <rect x="13.5" y="13.5" width="7" height="7" rx="1.5" />
    </>
  ),
  sliders: <path d="M5 21v-7m0-4V3m7 18v-9m0-4V3m7 18v-5m0-4V3M2.5 14h5m4-6h5m4 8h5" />,
  frame: (
    <>
      <rect x="3.5" y="3.5" width="17" height="17" rx="2.5" />
      <path d="M8.5 3.5v17M3.5 8.5h17" />
    </>
  ),
  inbox: (
    <path d="M3.5 13.5h4l1.5 3h6l1.5-3h4M3.5 13.5 6 5h12l2.5 8.5v5a1.5 1.5 0 0 1-1.5 1.5H5a1.5 1.5 0 0 1-1.5-1.5v-5Z" />
  ),
  signal: (
    <path d="M12 13.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Zm4-5.5a5.5 5.5 0 0 1 0 8M8 16a5.5 5.5 0 0 1 0-8m11 11a9.5 9.5 0 0 0 0-14M5 5a9.5 9.5 0 0 0 0 14" />
  ),
  wallet: (
    <>
      <path d="M3.5 7.5A2.5 2.5 0 0 1 6 5h11a2 2 0 0 1 2 2v1.5M3.5 7.5v10A2.5 2.5 0 0 0 6 20h12.5a2 2 0 0 0 2-2v-8a2 2 0 0 0-2-2H6a2.5 2.5 0 0 1-2.5-2.5Z" />
      <circle cx="16.5" cy="14" r="1.25" />
    </>
  ),
  shield: <path d="M12 3 5 6v6c0 4.5 3 7.8 7 9 4-1.2 7-4.5 7-9V6l-7-3Z" />,
  doc: (
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Zm0 0v5h5M8.5 13h7m-7 3.5h4.5" />
  ),
  nodes: (
    <>
      <circle cx="12" cy="5" r="2.25" />
      <circle cx="5.5" cy="18" r="2.25" />
      <circle cx="18.5" cy="18" r="2.25" />
      <path d="m10.8 7 -4 8.8M13.2 7l4 8.8M7.8 18h8.4" />
    </>
  ),
  gauge: <path d="M4 18a8.5 8.5 0 1 1 16 0M12 13.5 15.5 9" />,
} as const;

/**
 * Which glyph belongs to which route.
 *
 * Keyed by href because the route IS the identity of a nav entry — the label
 * is presentation and has been renamed twice already, while the path is what
 * the rest of the application links to.
 */
const BY_HREF: Record<string, Glyph> = {
  '/dashboard': GLYPHS.home,
  '/campaigns': GLYPHS.campaigns,
  '/audiences': GLYPHS.audiences,
  '/discover': GLYPHS.layers,
  '/creatives': GLYPHS.image,
  '/leads': GLYPHS.person,
  '/reports': GLYPHS.chart,
  '/billing': GLYPHS.card,
  '/connections': GLYPHS.link,
  '/team': GLYPHS.team,

  '/partner': GLYPHS.grid,
  '/partner/capabilities': GLYPHS.sliders,
  '/partner/segments': GLYPHS.layers,
  '/partner/placements': GLYPHS.frame,
  '/partner/requests': GLYPHS.inbox,
  '/partner/activations': GLYPHS.signal,
  '/partner/integrations': GLYPHS.link,
  '/partner/reports': GLYPHS.chart,
  '/partner/payouts': GLYPHS.wallet,
  '/partner/policies': GLYPHS.shield,

  '/network': GLYPHS.nodes,
  '/network/members': GLYPHS.team,
  '/network/reports': GLYPHS.chart,
  '/network/policy': GLYPHS.shield,

  '/admin': GLYPHS.gauge,
  '/admin/organizations': GLYPHS.grid,
  '/admin/audit': GLYPHS.doc,
};

export function NavIcon({ href }: { href: string }) {
  // A route with no glyph gets a neutral one rather than a gap, so adding a
  // nav entry never leaves a ragged column of labels.
  const glyph = BY_HREF[href] ?? GLYPHS.doc;

  return (
    <svg
      className="nav-icon"
      viewBox="0 0 24 24"
      width="17"
      height="17"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {glyph}
    </svg>
  );
}
