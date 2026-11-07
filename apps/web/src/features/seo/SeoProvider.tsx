import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { useLocation } from 'react-router';
import { publicEnv } from '../../lib/env';
import { DEFAULT_DESCRIPTION, headTags, type HeadTag, type PageMeta } from './meta';
import { canonicalPathFor, robotsFor } from './policy';

/*
 * Applies each page's metadata to document.head (docs/seo.md#metadata).
 * Pages describe themselves with usePageMeta(); pages that don't still get
 * the policy's robots directive and canonical link, and keep the title they
 * set with useDocumentTitle. The prerendered HTML carries the same tags.
 */

type SetMeta = (path: string, meta: PageMeta | null) => void;
const SeoContext = createContext<SetMeta | null>(null);

function apply(tags: HeadTag[], keepTitle: boolean) {
  const head = document.head;
  for (const el of head.querySelectorAll('[data-seo]')) el.remove();
  for (const t of tags) {
    if (t.tag === 'title') {
      if (!keepTitle) document.title = t.text;
      continue;
    }
    const el = document.createElement(t.tag);
    for (const [k, v] of Object.entries(t.attrs)) el.setAttribute(k, v);
    if (t.tag === 'script') el.textContent = t.text;
    el.setAttribute('data-seo', '');
    head.appendChild(el);
  }
}

export function SeoProvider({
  children,
  site = publicEnv.siteUrl,
}: {
  children: ReactNode;
  site?: string;
}) {
  const { pathname, search } = useLocation();
  const [page, setPage] = useState<{ path: string; meta: PageMeta } | null>(null);
  const set = useCallback<SetMeta>((path, meta) => {
    setPage((current) => (meta ? { path, meta } : current?.path === path ? null : current));
  }, []);

  useEffect(() => {
    const own = page && page.path === pathname ? page.meta : null;
    const policyRobots = robotsFor(pathname, search);
    const meta: PageMeta = own
      ? {
          ...own,
          // A query string makes any page a variant of its canonical path.
          robots:
            own.robots === 'index, follow' && policyRobots !== 'index, follow'
              ? policyRobots
              : own.robots,
        }
      : {
          title: null,
          description: DEFAULT_DESCRIPTION,
          canonicalPath: canonicalPathFor(pathname),
          robots: policyRobots,
        };
    apply(headTags(meta, site), !own);
  }, [page, pathname, search, site]);

  return <SeoContext.Provider value={set}>{children}</SeoContext.Provider>;
}

/**
 * Describes the current page (title, description, canonical, image, JSON-LD).
 * Pass the result of a builder from ./pages so the prerender and the page agree.
 */
export function usePageMeta(meta: PageMeta | null): void {
  const set = useContext(SeoContext);
  const { pathname } = useLocation();
  const key = useMemo(() => JSON.stringify(meta), [meta]);
  useEffect(() => {
    if (!set) return;
    set(pathname, meta);
    return () => set(pathname, null);
    // `key` captures the meta's content; the object identity changes every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [set, pathname, key]);
}

export const siteUrl = () => publicEnv.siteUrl;
