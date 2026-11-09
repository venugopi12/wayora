import { useSyncExternalStore } from 'react';

/*
 * Installing Wayora as an app (docs/pwa.md#install). Browsers differ:
 * - Chromium browsers (Chrome, Edge, Samsung Internet…) fire
 *   `beforeinstallprompt`; we keep the event and show our own button, which
 *   calls its `prompt()`. Nothing is shown when the event never fires.
 * - Safari (iOS and macOS) and Firefox have no install API: we show the
 *   manual steps where they exist (iOS: Share → Add to Home Screen).
 * - Already installed (standalone display mode): nothing is offered.
 * A dismissed offer stays hidden for 30 days (this browser only).
 */

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export type InstallMethod =
  /** The browser's own install dialog, through our button. */
  | 'prompt'
  /** iPhone or iPad Safari: Share → Add to Home Screen. */
  | 'ios-share'
  /** Safari on a Mac (17+): File → Add to Dock. */
  | 'mac-safari'
  /** Already running as an installed app. */
  | 'installed'
  /** No install support we know of (or not offered yet): offer nothing. */
  | 'unsupported';

const DISMISS_KEY = 'wayora.install.dismissedAt';
export const DISMISS_DAYS = 30;

let deferred: BeforeInstallPromptEvent | null = null;
let installedNow = false;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

/** Call once at start-up, before the browser can fire the event. */
export function captureInstallPrompt(target: Window = window): void {
  target.addEventListener('beforeinstallprompt', (event) => {
    // Keep the browser's own mini-infobar from appearing; we offer it in context instead.
    event.preventDefault();
    deferred = event as BeforeInstallPromptEvent;
    emit();
  });
  target.addEventListener('appinstalled', () => {
    deferred = null;
    installedNow = true;
    emit();
  });
}

export function isStandalone(w: Window = window): boolean {
  const nav = w.navigator as Navigator & { standalone?: boolean };
  return (
    nav.standalone === true ||
    w.matchMedia?.('(display-mode: standalone)').matches === true ||
    w.matchMedia?.('(display-mode: minimal-ui)').matches === true
  );
}

/** Which way to install in this browser (the user agent is only used to pick instructions). */
export function installMethod(w: Window = window, hasPrompt = deferred !== null): InstallMethod {
  if (installedNow || isStandalone(w)) return 'installed';
  if (hasPrompt) return 'prompt';
  const ua = w.navigator.userAgent;
  const iOS =
    /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && w.navigator.maxTouchPoints > 1);
  const webkitOnly = /Safari\//.test(ua) && !/Chrome|CriOS|FxiOS|EdgiOS|OPiOS|Android/.test(ua);
  if (iOS && /Safari\//.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS/.test(ua)) return 'ios-share';
  if (!iOS && webkitOnly && /Version\/(1[7-9]|[2-9]\d)/.test(ua)) return 'mac-safari';
  return 'unsupported';
}

/** Shows the browser's install dialog; resolves with whether the person accepted. */
export async function promptInstall(): Promise<'accepted' | 'dismissed' | 'unavailable'> {
  const event = deferred;
  if (!event) return 'unavailable';
  deferred = null; // A prompt event can only be used once.
  emit();
  await event.prompt();
  const { outcome } = await event.userChoice;
  if (outcome === 'dismissed') rememberDismissal();
  return outcome;
}

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function rememberDismissal(now = Date.now()): void {
  try {
    storage()?.setItem(DISMISS_KEY, String(now));
  } catch {
    // Storage unavailable (private mode): the offer may come back next visit.
  }
}

export function recentlyDismissed(now = Date.now()): boolean {
  try {
    const at = Number(storage()?.getItem(DISMISS_KEY) ?? NaN);
    return Number.isFinite(at) && now - at < DISMISS_DAYS * 86_400_000;
  } catch {
    return false;
  }
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** The install method for this browser, updating when the browser offers or completes an install. */
export function useInstallMethod(): InstallMethod {
  return useSyncExternalStore(
    subscribe,
    () => installMethod(),
    () => 'unsupported',
  );
}

/** For tests only. */
export function resetInstallState(): void {
  deferred = null;
  installedNow = false;
  emit();
}
