import { CloudOff, Download, RefreshCw, Share, SquarePlus, Wifi, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button, Dialog, DialogContent, IconButton, cn } from '@wayora/ui';
import {
  promptInstall,
  recentlyDismissed,
  rememberDismissal,
  useInstallMethod,
  type InstallMethod,
} from './install';
import { useOffline } from './online';
import { applyUpdate, useUpdateState } from './register';

/*
 * App-level notices (docs/pwa.md): connection state, a waiting update, and
 * the install offer. None of them blocks the page or moves it under the
 * reader: the connection bar sits under the header, the update notice above
 * the phone navigation bar.
 */

/**
 * While offline: says so, and that saved pages may be out of date and that
 * bookings, payments and account changes need a connection. On reconnecting,
 * "Back online" for a few seconds.
 */
export function ConnectivityBanner() {
  const offline = useOffline();
  const [backOnline, setBackOnline] = useState(false);
  useEffect(() => {
    let timer: number | undefined;
    const online = () => {
      setBackOnline(true);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setBackOnline(false), 4000);
    };
    const offlineNow = () => {
      window.clearTimeout(timer);
      setBackOnline(false);
    };
    window.addEventListener('online', online);
    window.addEventListener('offline', offlineNow);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('online', online);
      window.removeEventListener('offline', offlineNow);
    };
  }, []);

  return (
    // Always present (empty when online) so changes are announced; no status role,
    // so it doesn't add an empty landmark-like region to every page.
    <div aria-live="polite" className="contents">
      {offline ? (
        <div className="sticky top-(--header-h) z-(--z-raised) border-b border-warning/30 bg-warning-soft text-warning-ink">
          <p className="mx-auto flex max-w-7xl items-start gap-2 px-4 py-2 text-body-sm sm:px-6">
            <CloudOff className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <span>
              <strong className="font-semibold">You’re offline.</strong> Pages saved on this device
              may be out of date. Searching, booking, payments and account changes need a
              connection, and nothing is sent until you’re back online.
            </span>
          </p>
        </div>
      ) : backOnline ? (
        <div className="sticky top-(--header-h) z-(--z-raised) border-b border-success/30 bg-success-soft text-success-ink">
          <p className="mx-auto flex max-w-7xl items-center gap-2 px-4 py-2 text-body-sm sm:px-6">
            <Wifi className="size-4 shrink-0" aria-hidden="true" />
            Back online.
          </p>
        </div>
      ) : null}
    </div>
  );
}

/** A new version is waiting: reload into it when the person chooses. */
export function UpdatePrompt() {
  const update = useUpdateState();
  const [later, setLater] = useState(false);
  if (update === 'none' || later) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed inset-x-3 bottom-[calc(var(--tab-bar-h)+env(safe-area-inset-bottom)+0.75rem)] z-(--z-dropdown) mx-auto flex max-w-md items-center gap-3 rounded-xl border border-line bg-card p-3 shadow-lg lg:bottom-6"
    >
      <RefreshCw className="size-5 shrink-0 text-brand-ink" aria-hidden="true" />
      <p className="flex-1 text-body-sm text-ink">A new version of Wayora is ready.</p>
      <Button size="sm" loading={update === 'applying'} onClick={applyUpdate}>
        Reload
      </Button>
      <IconButton
        label="Not now"
        icon={<X />}
        size="sm"
        variant="ghost"
        onClick={() => setLater(true)}
      />
    </div>
  );
}

const BENEFITS = [
  'Opens from your home screen in its own window, without the browser bar.',
  'One tap to your trips, searches and rewards.',
  'Public pages you opened, like destinations and guides, can be read offline.',
  'No app store and no extra account: it’s the same Wayora, kept up to date.',
];

function ManualSteps({ method }: { method: InstallMethod }) {
  if (method === 'ios-share') {
    return (
      <ol className="flex flex-col gap-2 text-body-sm text-ink">
        <li className="flex items-start gap-2">
          <Share className="mt-0.5 size-4 shrink-0 text-brand-ink" aria-hidden="true" />
          <span>
            In Safari, tap <strong className="font-semibold">Share</strong>.
          </span>
        </li>
        <li className="flex items-start gap-2">
          <SquarePlus className="mt-0.5 size-4 shrink-0 text-brand-ink" aria-hidden="true" />
          <span>
            Choose <strong className="font-semibold">Add to Home Screen</strong>, then{' '}
            <strong className="font-semibold">Add</strong>.
          </span>
        </li>
      </ol>
    );
  }
  if (method === 'mac-safari') {
    return (
      <p className="text-body-sm text-ink">
        In Safari, choose <strong className="font-semibold">File → Add to Dock</strong>.
      </p>
    );
  }
  return null;
}

/** Explains installing and offers the right way for this browser. */
export function InstallDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const method = useInstallMethod();
  const [result, setResult] = useState<string | null>(null);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="Install the Wayora app"
        description="Add Wayora to your home screen or dock."
        size="sm"
        footer={
          method === 'prompt' ? (
            <Button
              onClick={async () => {
                const outcome = await promptInstall();
                setResult(outcome === 'accepted' ? 'Installing Wayora…' : null);
                if (outcome !== 'unavailable') onOpenChange(false);
              }}
            >
              <Download aria-hidden="true" />
              Install
            </Button>
          ) : (
            <Button variant="secondary" onClick={() => onOpenChange(false)}>
              Close
            </Button>
          )
        }
      >
        <div className="flex flex-col gap-4">
          <ul className="flex list-disc flex-col gap-1.5 pl-5 text-body-sm text-ink-secondary">
            {BENEFITS.map((b) => (
              <li key={b}>{b}</li>
            ))}
          </ul>
          {method === 'installed' ? (
            <p className="text-body-sm text-ink">Wayora is already installed on this device.</p>
          ) : method === 'unsupported' ? (
            <p className="text-body-sm text-ink">
              This browser doesn’t offer to install websites. In Chrome, Edge or Samsung Internet,
              look for <strong className="font-semibold">Install app</strong> in the browser menu;
              on an iPhone or iPad, use Safari’s{' '}
              <strong className="font-semibold">Add to Home Screen</strong>.
            </p>
          ) : (
            <ManualSteps method={method} />
          )}
          {result ? (
            <p role="status" className="text-body-sm text-ink">
              {result}
            </p>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * A small, dismissible offer to install, for pages people come back to (My
 * trips). Shown only when this browser can install (its own prompt, or
 * Safari's manual steps), not when already installed, and not again for 30
 * days once dismissed.
 */
export function InstallOfferCard({ className }: { className?: string }) {
  const method = useInstallMethod();
  const [hidden, setHidden] = useState(() => recentlyDismissed());
  const [open, setOpen] = useState(false);
  if (hidden || method === 'installed' || method === 'unsupported') return null;
  return (
    <section
      aria-label="Install the Wayora app"
      className={cn(
        'flex items-start gap-3 rounded-xl border border-brand-200 bg-brand-soft p-4',
        className,
      )}
    >
      <Download className="mt-0.5 size-5 shrink-0 text-brand-ink" aria-hidden="true" />
      <div className="flex flex-1 flex-col gap-2">
        <p className="text-body-sm text-ink">
          <strong className="font-semibold">Keep your trips one tap away.</strong> Install Wayora on
          this device to open it from your home screen.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={() => setOpen(true)}>
            {method === 'prompt' ? 'Install' : 'How to install'}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              rememberDismissal();
              setHidden(true);
            }}
          >
            Not now
          </Button>
        </div>
      </div>
      <InstallDialog open={open} onOpenChange={setOpen} />
    </section>
  );
}

const clock = new Intl.DateTimeFormat('en-IN', { hour: 'numeric', minute: '2-digit' });

/**
 * For personal data already on screen (trips, a booking, a payment) when the
 * connection drops: it isn't current, so say when it was loaded. Nothing
 * personal is stored for offline use; this only labels what the open page
 * already had.
 */
export function OfflineDataNote({ updatedAt, what }: { updatedAt: number; what: string }) {
  const offline = useOffline();
  if (!offline || !updatedAt) return null;
  return (
    <p
      role="status"
      className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning-soft px-3 py-2 text-body-sm text-warning-ink"
    >
      <CloudOff className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <span>
        You’re offline. {what} as loaded at{' '}
        <time dateTime={new Date(updatedAt).toISOString()}>{clock.format(updatedAt)}</time>; it may
        have changed since. Changes need a connection.
      </span>
    </p>
  );
}
