import { deletePushSubscription, savePushSubscription } from '../services/notifications';
import { currentRegistration, serviceWorkerSupported } from './register';

/*
 * Browser push on this device (Phase 30, docs/pwa.md#push).
 *
 * - Permission is asked only when the person presses "Turn on" on the
 *   notifications page, after we've said what they'll get. Never on load.
 * - The subscription is saved on the server against the signed-in session;
 *   turning push off, or signing out, removes it there and in the browser.
 * - Unsupported browsers (and iPhone/iPad Safari outside an installed app)
 *   are told so; nothing pretends to work.
 */

export type PushAvailability =
  /** No Push API (or no service worker, or not a secure origin). */
  | 'unsupported'
  /** iPhone or iPad: only works once Wayora is added to the home screen. */
  | 'ios-needs-install'
  /** The person blocked notifications for this site in the browser. */
  | 'denied'
  | 'available';

export function pushAvailability(w: Window = window): PushAvailability {
  const nav = w.navigator as Navigator & { standalone?: boolean };
  const iOS = /iPhone|iPad|iPod/.test(nav.userAgent);
  if (iOS && nav.standalone !== true) return 'ios-needs-install';
  if (!serviceWorkerSupported(w) || !('PushManager' in w) || !('Notification' in w)) {
    return 'unsupported';
  }
  if ((w as Window & typeof globalThis).Notification.permission === 'denied') return 'denied';
  return 'available';
}

/** The service worker that receives pushes (production builds register it at start-up). */
async function readyRegistration(): Promise<ServiceWorkerRegistration | null> {
  const known = currentRegistration();
  if (known) return known;
  if (!('serviceWorker' in navigator)) return null;
  const existing = await navigator.serviceWorker.getRegistration();
  return existing ?? null;
}

/** This browser's push subscription, if it has one. */
export async function currentPushSubscription(): Promise<PushSubscription | null> {
  const registration = await readyRegistration();
  return (await registration?.pushManager.getSubscription()) ?? null;
}

/** "BASE64URL" → bytes, for `applicationServerKey`. */
export function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const padded = value
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(Math.ceil(value.length / 4) * 4, '=');
  const raw = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

export type EnableResult = 'enabled' | 'denied' | 'dismissed' | 'unavailable';

/**
 * Asks for permission (call from a click), subscribes this browser with the
 * server's VAPID key and saves the subscription. If saving fails, the browser
 * subscription is removed again so the two never disagree.
 */
export async function enablePush(publicKey: string): Promise<EnableResult> {
  if (pushAvailability() !== 'available') return 'unavailable';
  const permission = await Notification.requestPermission();
  if (permission === 'denied') return 'denied';
  if (permission !== 'granted') return 'dismissed';
  const registration = await readyRegistration();
  if (!registration) return 'unavailable';
  const subscription =
    (await registration.pushManager.getSubscription()) ??
    (await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: base64UrlToBytes(publicKey),
    }));
  const json = subscription.toJSON();
  try {
    await savePushSubscription({
      endpoint: subscription.endpoint,
      expirationTime: json.expirationTime ?? null,
      keys: { p256dh: json.keys?.p256dh ?? '', auth: json.keys?.auth ?? '' },
    });
  } catch (error) {
    await subscription.unsubscribe().catch(() => undefined);
    throw error;
  }
  return 'enabled';
}

/** Turns push off on this device: removes it on the server, then in the browser. */
export async function disablePush(): Promise<void> {
  const subscription = await currentPushSubscription();
  if (!subscription) return;
  await deletePushSubscription(subscription.endpoint).catch(() => undefined);
  await subscription.unsubscribe().catch(() => undefined);
}

/**
 * Before signing out: this device stops receiving the account's
 * notifications (a shared device). Best effort and quick; the server also
 * stops sending once the session is signed out.
 */
export async function removePushBeforeSignOut(): Promise<void> {
  try {
    await Promise.race([disablePush(), new Promise((r) => setTimeout(r, 3000))]);
  } catch {
    // Signing out must not depend on this.
  }
}
