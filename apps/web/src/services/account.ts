import { z } from 'zod';
import {
  authResponseSchema,
  safeUserSchema,
  travellerListSchema,
  travellerSchema,
  type CreateTravellerRequest,
  type LoginRequest,
  type RegisterRequest,
  type SafeUser,
  type Traveller,
  type UpdateProfileRequest,
  type UpdateTravellerRequest,
} from '@wayora/contracts';
import { ApiClientError } from '../lib/api-client';
import { api } from './api';

/*
 * Account API calls (Phase 8). The session lives in an HttpOnly cookie that
 * the browser attaches by itself; nothing here reads, stores or forwards a
 * token.
 */

/** The signed-in user, or `null` when this browser has no valid session. */
export async function fetchCurrentUser(signal?: AbortSignal): Promise<SafeUser | null> {
  try {
    const { user } = await api.request('/auth/me', {
      schema: authResponseSchema,
      signal,
      reportsSessionEnd: false,
    });
    return user;
  } catch (error) {
    if (error instanceof ApiClientError && error.status === 401) return null;
    throw error;
  }
}

export async function signIn(body: LoginRequest): Promise<SafeUser> {
  const { user } = await api.request('/auth/login', {
    method: 'POST',
    body,
    schema: authResponseSchema,
    reportsSessionEnd: false,
  });
  return user;
}

export async function createAccount(body: RegisterRequest): Promise<SafeUser> {
  const { user } = await api.request('/auth/register', {
    method: 'POST',
    body,
    schema: authResponseSchema,
    reportsSessionEnd: false,
  });
  return user;
}

export async function signOut(): Promise<void> {
  await api.request('/auth/logout', {
    method: 'POST',
    schema: z.object({ signedOut: z.literal(true) }),
    reportsSessionEnd: false,
  });
}

export async function signOutEverywhere(): Promise<number> {
  const { sessionsRevoked } = await api.request('/auth/logout-all', {
    method: 'POST',
    schema: z.object({ signedOut: z.literal(true), sessionsRevoked: z.number().int() }),
  });
  return sessionsRevoked;
}

export function updateProfile(body: UpdateProfileRequest): Promise<SafeUser> {
  return api.request('/users/me', { method: 'PATCH', body, schema: safeUserSchema });
}

export function listTravellers(signal?: AbortSignal): Promise<Traveller[]> {
  return api.request('/users/me/travellers', { schema: travellerListSchema, signal });
}

export function createTraveller(body: CreateTravellerRequest): Promise<Traveller> {
  return api.request('/users/me/travellers', { method: 'POST', body, schema: travellerSchema });
}

export function updateTraveller(id: string, body: UpdateTravellerRequest): Promise<Traveller> {
  return api.request(`/users/me/travellers/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body,
    schema: travellerSchema,
  });
}

export async function deleteTraveller(id: string): Promise<void> {
  await api.request(`/users/me/travellers/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    schema: z.object({ id: z.string(), deleted: z.literal(true) }),
  });
}
