import { publicContentSchema, type PublicContent } from '@wayora/contracts';

/*
 * The prerendered HTML of a guide, collection or landing page carries the
 * published entry as JSON (scripts/prerender.ts). The page starts from it
 * instead of showing a loading state and fetching it again, so the content
 * doesn't jump (layout shift) when the app takes over; it's then refreshed
 * from the API in the background (docs/pwa.md#performance).
 */

export const PRERENDERED_CONTENT_ID = 'wayora-prerendered-content';

/** The embedded entry when it's for this path and matches the contract. */
export function prerenderedContent(
  path: string,
  doc: Document = document,
): PublicContent | undefined {
  const el = doc.getElementById(PRERENDERED_CONTENT_ID);
  if (!el?.textContent) return undefined;
  try {
    const parsed = publicContentSchema.safeParse(JSON.parse(el.textContent));
    return parsed.success && parsed.data.path === path ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}
