import { Link, useMatches, type Params, type UIMatch } from 'react-router';
import type { BreadcrumbItem } from '@wayora/ui';

/**
 * Per-route layout options, set with `handle` in app/routes.tsx. Layouts read
 * them from `useMatches()`, so pages don't repeat shell markup.
 */
export interface RouteHandle {
  /** The page opens with a full-bleed dark hero; float the header over it. */
  headerOverlay?: boolean;
  /**
   * Breadcrumb label for this route level. A function receives the URL params
   * (e.g. a destination slug) and may return `undefined` to end the trail (an
   * unknown slug gets no breadcrumb rather than a guessed label).
   */
  crumb?: string | ((params: Params) => string | undefined);
}

const handleOf = (m: UIMatch) => m.handle as RouteHandle | undefined;

export function wantsHeaderOverlay(matches: UIMatch[]): boolean {
  return matches.some((m) => handleOf(m)?.headerOverlay === true);
}

export interface Crumb {
  label: string;
  /** Pathname of the matched route: always a real, routed URL. */
  path: string;
}

/**
 * Breadcrumb trail for the current location, built from route handles:
 * Home, then every matched route that declares a `crumb`. Returns [] when no
 * route opts in (the homepage, top-level pages), so trails are never automatic.
 * If any level can't name itself (unknown slug), the trail is dropped.
 */
export function crumbsFor(matches: UIMatch[]): Crumb[] {
  const crumbs: Crumb[] = [];
  for (const m of matches) {
    const crumb = handleOf(m)?.crumb;
    if (crumb === undefined) continue;
    const label = typeof crumb === 'function' ? crumb(m.params) : crumb;
    if (!label) return [];
    // Pathless/index children share their parent's pathname; keep one entry.
    if (crumbs.at(-1)?.path === m.pathname) crumbs.pop();
    crumbs.push({ label, path: m.pathname });
  }
  return crumbs.length ? [{ label: 'Home', path: '/' }, ...crumbs] : [];
}

/** `crumbsFor` as `Breadcrumbs` items: ancestors are router links, the last item is the current page. */
export function useRouteBreadcrumbs(): BreadcrumbItem[] {
  const crumbs = crumbsFor(useMatches());
  return crumbs.map((c, i) =>
    i === crumbs.length - 1 ? { label: c.label } : { label: c.label, link: <Link to={c.path} /> },
  );
}
