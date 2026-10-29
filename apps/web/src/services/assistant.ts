import {
  assistantApplyResultSchema,
  assistantConversationDetailSchema,
  assistantConversationListSchema,
  assistantConversationSchema,
  assistantExchangeSchema,
  assistantItineraryCheckSchema,
  assistantStatusSchema,
  assistantTripContextSchema,
  type ApplyAssistantProposalInput,
  type AssistantApplyResult,
  type AssistantConversation,
  type AssistantConversationDetail,
  type AssistantConversationList,
  type AssistantExchange,
  type AssistantItineraryCheck,
  type AssistantStatus,
  type AssistantTripContext,
  type CheckAssistantItineraryInput,
  type SendAssistantMessageInput,
} from '@wayora/contracts';
import { z } from 'zod';
import { api } from './api';

/*
 * Travel assistant (docs/assistant.md#api). Everything is the signed-in
 * user's own (session cookie). The provider is called by the API only: no
 * key, model or provider URL ever reaches the browser. Replies arrive whole
 * (no streaming). POSTs that create or change something take an
 * Idempotency-Key: reuse it when retrying the same attempt.
 */

const conversation = (id: string) => `/assistant/conversations/${encodeURIComponent(id)}`;
const opt = (signal?: AbortSignal) => (signal ? { signal } : {});
/** The API allows up to 45 s per reply; wait a little longer than that. */
const REPLY_TIMEOUT_MS = 55_000;

export function getAssistantStatus(signal?: AbortSignal): Promise<AssistantStatus> {
  return api.request('/assistant/status', { schema: assistantStatusSchema, ...opt(signal) });
}

export function listAssistantConversations(
  page = 1,
  signal?: AbortSignal,
): Promise<AssistantConversationList> {
  return api.request(`/assistant/conversations?page=${page}&pageSize=50`, {
    schema: assistantConversationListSchema,
    ...opt(signal),
  });
}

export function createAssistantConversation(
  tripId: string | null,
  idempotencyKey: string,
): Promise<AssistantConversation> {
  return api.request('/assistant/conversations', {
    method: 'POST',
    body: tripId ? { tripId } : {},
    schema: assistantConversationSchema,
    headers: { 'Idempotency-Key': idempotencyKey },
  });
}

export function getAssistantConversation(
  id: string,
  signal?: AbortSignal,
): Promise<AssistantConversationDetail> {
  return api.request(conversation(id), {
    schema: assistantConversationDetailSchema,
    ...opt(signal),
  });
}

export async function deleteAssistantConversation(id: string): Promise<void> {
  await api.request(conversation(id), {
    method: 'DELETE',
    schema: z.object({ deleted: z.literal(true) }),
  });
}

export function sendAssistantMessage(
  id: string,
  body: SendAssistantMessageInput,
  idempotencyKey: string,
): Promise<AssistantExchange> {
  return api.request(`${conversation(id)}/messages`, {
    method: 'POST',
    body,
    schema: assistantExchangeSchema,
    headers: { 'Idempotency-Key': idempotencyKey },
    timeoutMs: REPLY_TIMEOUT_MS,
  });
}

export function checkAssistantItinerary(
  id: string,
  messageId: string,
  body: CheckAssistantItineraryInput,
  signal?: AbortSignal,
): Promise<AssistantItineraryCheck> {
  return api.request(`${conversation(id)}/messages/${encodeURIComponent(messageId)}/check`, {
    method: 'POST',
    body,
    schema: assistantItineraryCheckSchema,
    ...opt(signal),
  });
}

export function applyAssistantProposal(
  id: string,
  messageId: string,
  body: ApplyAssistantProposalInput,
  idempotencyKey: string,
): Promise<AssistantApplyResult> {
  return api.request(`${conversation(id)}/messages/${encodeURIComponent(messageId)}/apply`, {
    method: 'POST',
    body,
    schema: assistantApplyResultSchema,
    headers: { 'Idempotency-Key': idempotencyKey },
  });
}

export function getAssistantTripContext(
  tripId: string,
  signal?: AbortSignal,
): Promise<AssistantTripContext> {
  return api.request(`/assistant/trips/${encodeURIComponent(tripId)}/context`, {
    schema: assistantTripContextSchema,
    ...opt(signal),
  });
}
