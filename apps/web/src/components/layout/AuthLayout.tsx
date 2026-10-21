import { ArrowLeft, Check } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link, Outlet } from 'react-router';
import { SkipLink, Wordmark } from '@wayora/ui';
import { HERO_LAYERS } from '../../features/home/media';
import { INFO_PATHS } from '../../features/navigation/config';

/** What an account does today. Keep this list true: no features that don't exist. */
const ACCOUNT_POINTS = [
  'Save the people you travel with, ready for when booking opens.',
  'Sign in on any device and sign out of all of them at once.',
  'Your password is stored only as a one-way hash.',
] as const;

/**
 * Focused layout for /login and /register (a sibling of MarketingLayout under
 * RootLayout, see docs/layouts.md): no site navigation or footer, so the
 * form is the only task on the page.
 *
 * lg+: form column | artwork panel. Below lg the artwork is dropped and the
 * form uses the full width, so nothing pushes it below the fold on phones.
 */
export function AuthLayout({ children }: { children?: ReactNode }) {
  return (
    <div className="grid min-h-dvh bg-page lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
      <SkipLink />
      <div className="flex min-h-dvh flex-col px-gutter">
        <div className="flex h-(--header-h) items-center justify-between gap-4">
          <Link to="/" className="rounded-md" aria-label="Wayora, home">
            <Wordmark />
          </Link>
          <Link
            to="/"
            className="inline-flex min-h-11 items-center gap-1.5 rounded-md px-2 text-body-sm text-ink-secondary hover:text-ink"
          >
            <ArrowLeft className="size-4" aria-hidden="true" />
            Back to Wayora
          </Link>
        </div>
        <main
          id="main"
          tabIndex={-1}
          className="flex flex-1 items-center justify-center py-10 focus:outline-none"
        >
          <div className="w-full max-w-[26rem]">{children ?? <Outlet />}</div>
        </main>
        <footer className="flex flex-wrap items-center justify-center gap-x-5 gap-y-2 pb-6 text-caption text-ink-secondary">
          <Link to={INFO_PATHS.privacy} className="rounded-sm hover:text-ink">
            Privacy (draft)
          </Link>
          <Link to={INFO_PATHS.terms} className="rounded-sm hover:text-ink">
            Terms (draft)
          </Link>
          <Link to={INFO_PATHS.help} className="rounded-sm hover:text-ink">
            Help
          </Link>
        </footer>
      </div>

      <aside
        aria-label="About Wayora accounts"
        className="relative m-3 hidden overflow-hidden rounded-2xl bg-deep lg:flex"
      >
        {/* Original artwork (see docs/media-assets.md); decorative. */}
        {HERO_LAYERS.map((layer) => (
          <img
            key={layer.src}
            src={layer.portraitSrc ?? layer.src}
            alt=""
            aria-hidden="true"
            decoding="async"
            className="absolute inset-0 size-full object-cover"
            style={{ objectPosition: layer.focalPoint ?? '50% 60%' }}
          />
        ))}
        <div
          aria-hidden="true"
          className="absolute inset-0 bg-linear-to-t from-deep via-deep/55 to-deep/0"
        />
        <div className="relative mt-auto flex max-w-lg flex-col gap-5 p-10 xl:p-14">
          <p className="text-caption font-semibold tracking-[0.14em] text-brand-200 uppercase">
            Your Wayora account
          </p>
          <p className="text-heading-2 text-ink-inverse">
            Keep the details of every journey in one calm place.
          </p>
          <ul className="flex flex-col gap-3">
            {ACCOUNT_POINTS.map((point) => (
              <li key={point} className="flex gap-3 text-body text-ink-inverse-secondary">
                <Check className="mt-1 size-4 shrink-0 text-brand-200" aria-hidden="true" />
                {point}
              </li>
            ))}
          </ul>
        </div>
      </aside>
    </div>
  );
}
