import type { EmailMessage } from './email.js';

/*
 * Transactional email templates (docs/notifications.md#email). The text comes
 * from the notification itself, which Wayora wrote (no provider text, no
 * traveller names). Demo notifications say so in the subject and body.
 * Everything is escaped for HTML.
 */

export interface TemplateInput {
  to: string;
  title: string;
  message: string;
  isDemo: boolean;
  /** Absolute link to the related page, if any (built from WEB_ORIGIN). */
  url: string | null;
}

const escapeHtml = (value: string) =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

export const DEMO_FOOTER =
  'This is a Wayora demo: no supplier reservation, ticket or real payment exists.';

export function renderEmail(input: TemplateInput): EmailMessage {
  const subject = `${input.isDemo ? '[Demo] ' : ''}${input.title} – Wayora`;
  const lines = [input.title, '', input.message];
  if (input.url) lines.push('', `View it in Wayora: ${input.url}`);
  if (input.isDemo) lines.push('', DEMO_FOOTER);
  const html = [
    '<!doctype html><html><body style="font-family:system-ui,sans-serif;color:#1d2340;line-height:1.5">',
    `<h1 style="font-size:20px">${escapeHtml(input.title)}</h1>`,
    `<p>${escapeHtml(input.message)}</p>`,
    input.url
      ? `<p><a href="${escapeHtml(input.url)}" style="color:#4f5bd5">View it in Wayora</a></p>`
      : '',
    input.isDemo ? `<p style="color:#5b6180;font-size:13px">${escapeHtml(DEMO_FOOTER)}</p>` : '',
    '</body></html>',
  ].join('');
  return { to: input.to, subject, text: lines.join('\n'), html };
}
