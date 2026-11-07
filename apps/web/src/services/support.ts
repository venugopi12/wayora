import {
  adminSupportMessagePageSchema,
  adminSupportTicketListSchema,
  adminSupportTicketSchema,
  supportAiSuggestionSchema,
  supportMessagePageSchema,
  supportMetricsSchema,
  supportStaffSchema,
  supportTicketListSchema,
  supportTicketSchema,
  type AdminSupportAssign,
  type AdminSupportEscalate,
  type AdminSupportListQuery,
  type AdminSupportMessagePage,
  type AdminSupportPriorityChange,
  type AdminSupportReply,
  type AdminSupportStatusChange,
  type AdminSupportTicket,
  type AdminSupportTicketList,
  type CreateSupportTicket,
  type SupportAiSuggestion,
  type SupportListQuery,
  type SupportMessagePage,
  type SupportMetrics,
  type SupportStaff,
  type SupportTicket,
  type SupportTicketList,
} from '@wayora/contracts';
import { z } from 'zod';
import { API_V1_PREFIX } from '@wayora/contracts';
import { publicEnv } from '../lib/env';
import { api } from './api';

/*
 * Customer support (Phase 27, docs/support.md#api). The client sends what
 * the customer or agent wrote and a request key; the server decides owners,
 * statuses, permissions and booking context.
 */

const query = (params: Record<string, unknown>) => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (typeof v === 'string' || typeof v === 'number') q.set(k, String(v));
  }
  const s = q.toString();
  return s ? `?${s}` : '';
};
const sig = (signal?: AbortSignal) => (signal ? { signal } : {});
const ticketPath = (reference: string) => `/support/tickets/${encodeURIComponent(reference)}`;
const adminPath = (reference: string) => `/admin/support/tickets/${encodeURIComponent(reference)}`;

// ─── Customer ────────────────────────────────────────────────────────────

export const getSupportTickets = (
  params: SupportListQuery,
  signal?: AbortSignal,
): Promise<SupportTicketList> =>
  api.request(`/support/tickets${query(params)}`, {
    schema: supportTicketListSchema,
    ...sig(signal),
  });

export const getSupportTicket = (reference: string, signal?: AbortSignal): Promise<SupportTicket> =>
  api.request(ticketPath(reference), { schema: supportTicketSchema, ...sig(signal) });

export const createSupportTicket = (body: CreateSupportTicket): Promise<SupportTicket> =>
  api.request('/support/tickets', { method: 'POST', body, schema: supportTicketSchema });

export const getSupportMessages = (
  reference: string,
  params: { before?: number; limit?: number },
  signal?: AbortSignal,
): Promise<SupportMessagePage> =>
  api.request(`${ticketPath(reference)}/messages${query(params)}`, {
    schema: supportMessagePageSchema,
    ...sig(signal),
  });

export const sendSupportMessage = (
  reference: string,
  body: { body: string; clientKey: string },
): Promise<SupportTicket> =>
  api.request(`${ticketPath(reference)}/messages`, {
    method: 'POST',
    body,
    schema: supportTicketSchema,
  });

export const markSupportRead = (reference: string, seq: number) =>
  api.request(`${ticketPath(reference)}/read`, {
    method: 'POST',
    body: { seq },
    schema: z.object({ unread: z.number().int() }),
  });

export const closeSupportTicket = (reference: string): Promise<SupportTicket> =>
  api.request(`${ticketPath(reference)}/close`, {
    method: 'POST',
    body: {},
    schema: supportTicketSchema,
  });

export const supportEventsUrl = (reference: string) =>
  `${publicEnv.apiBaseUrl}${API_V1_PREFIX}${ticketPath(reference)}/events`;

// ─── Staff ───────────────────────────────────────────────────────────────

export const adminSupportMetrics = (range: string, signal?: AbortSignal): Promise<SupportMetrics> =>
  api.request(`/admin/support/metrics${query({ range })}`, {
    schema: supportMetricsSchema,
    ...sig(signal),
  });

export const adminSupportStaff = (signal?: AbortSignal): Promise<SupportStaff[]> =>
  api
    .request('/admin/support/staff', {
      schema: z.object({ items: z.array(supportStaffSchema) }),
      ...sig(signal),
    })
    .then((d) => d.items);

export const adminSupportTickets = (
  params: AdminSupportListQuery,
  signal?: AbortSignal,
): Promise<AdminSupportTicketList> =>
  api.request(`/admin/support/tickets${query(params)}`, {
    schema: adminSupportTicketListSchema,
    ...sig(signal),
  });

export const adminSupportTicket = (
  reference: string,
  signal?: AbortSignal,
): Promise<AdminSupportTicket> =>
  api.request(adminPath(reference), { schema: adminSupportTicketSchema, ...sig(signal) });

export const adminSupportMessages = (
  reference: string,
  params: { before?: number; limit?: number },
  signal?: AbortSignal,
): Promise<AdminSupportMessagePage> =>
  api.request(`${adminPath(reference)}/messages${query(params)}`, {
    schema: adminSupportMessagePageSchema,
    ...sig(signal),
  });

const post = <T>(reference: string, what: string, body: T): Promise<AdminSupportTicket> =>
  api.request(`${adminPath(reference)}/${what}`, {
    method: 'POST',
    body,
    schema: adminSupportTicketSchema,
  });

export const adminSupportReply = (reference: string, body: AdminSupportReply) =>
  post(reference, 'messages', body);
export const adminSupportStatus = (reference: string, body: AdminSupportStatusChange) =>
  post(reference, 'status', body);
export const adminSupportAssign = (reference: string, body: AdminSupportAssign) =>
  post(reference, 'assign', body);
export const adminSupportEscalate = (reference: string, body: AdminSupportEscalate) =>
  post(reference, 'escalate', body);
export const adminSupportPriority = (reference: string, body: AdminSupportPriorityChange) =>
  post(reference, 'priority', body);

export const adminSupportMarkRead = (reference: string, seq: number) =>
  api.request(`${adminPath(reference)}/read`, {
    method: 'POST',
    body: { seq },
    schema: z.object({ ok: z.boolean() }),
  });

export const adminSupportAi = (
  reference: string,
  kind: 'draft' | 'summary',
): Promise<SupportAiSuggestion> =>
  api.request(`${adminPath(reference)}/ai`, {
    method: 'POST',
    body: { kind },
    schema: supportAiSuggestionSchema,
  });

export const adminSupportEventsUrl = (reference: string) =>
  `${publicEnv.apiBaseUrl}${API_V1_PREFIX}${adminPath(reference)}/events`;
