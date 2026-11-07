/** Customer support and Help Center paths (Phase 27, docs/support.md#web). Icon-free. */

export const SUPPORT_PATH = '/support';
export const NEW_TICKET_PATH = '/support/new';
export const ticketPath = (reference: string) => `/support/${encodeURIComponent(reference)}`;

/** /support/new, optionally about a booking, a topic, or from a help article. */
export function newTicketPath(
  options: { booking?: string; category?: string; article?: string } = {},
): string {
  const q = new URLSearchParams();
  if (options.booking) q.set('booking', options.booking);
  if (options.category) q.set('category', options.category);
  if (options.article) q.set('article', options.article);
  const s = q.toString();
  return s ? `${NEW_TICKET_PATH}?${s}` : NEW_TICKET_PATH;
}

export const HELP_PATH = '/help';
export const helpSearchPath = (q: string) => `${HELP_PATH}?q=${encodeURIComponent(q)}`;
export const helpTopicPath = (category: string) =>
  `${HELP_PATH}/topics/${encodeURIComponent(category)}`;
export const helpArticlePath = (slug: string) =>
  `${HELP_PATH}/articles/${encodeURIComponent(slug)}`;
