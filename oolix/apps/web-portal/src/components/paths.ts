/** Whether a navigation path covers the current one: itself, or a page under it. */
export function covers(candidate: string, pathname: string): boolean {
  return pathname === candidate || (candidate !== '/' && pathname.startsWith(`${candidate}/`));
}

/** The longest of the candidates that covers the current path, if any. */
export function bestMatch(pathname: string, candidates: string[]): string | undefined {
  return candidates
    .filter((c) => covers(c, pathname))
    .reduce<string | undefined>(
      (best, c) => (best && best.length >= c.length ? best : c),
      undefined,
    );
}
