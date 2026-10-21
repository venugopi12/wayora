import { ArrowRight, FileWarning } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
  Alert,
  Badge,
  Card,
  cn,
  interaction,
} from '@wayora/ui';
import { ContentPage } from '../../components/layout/ContentPage';
import { ACCOUNT_PATHS, DISCOVER, INFO_PATHS } from '../navigation/config';

/*
 * Informational and legal pages (Phase 7). Everything stated here is true of
 * the current product and verifiable in the code. The legal pages are DRAFTS:
 * they describe what the preview does today and list what a reviewed policy
 * must cover. They are not policies or terms, and say so. See docs/layouts.md
 * ("Content that needs review before launch").
 */

function RelatedLinks({ title, links }: { title: string; links: { label: string; to: string }[] }) {
  return (
    <Card padding="md" className="flex flex-col gap-3">
      <h2 className="text-label text-ink">{title}</h2>
      <ul className="flex flex-col gap-1">
        {links.map((l) => (
          <li key={l.to}>
            <Link
              to={l.to}
              className="group flex min-h-10 items-center justify-between gap-3 rounded-xs text-body-sm font-semibold text-brand-ink hover:text-brand"
            >
              {l.label}
              <ArrowRight aria-hidden="true" className={cn('size-4', interaction.iconNudge)} />
            </Link>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function DraftNotice({ children }: { children: ReactNode }) {
  return (
    <Alert tone="warning" role="none" title="Draft: not a published policy">
      {children}
    </Alert>
  );
}

/** /about */
export function AboutRoute() {
  return (
    <ContentPage
      eyebrow="Company"
      title="About Wayora"
      description="A travel platform being built so a whole journey can be planned in one place."
      aside={
        <RelatedLinks
          title="What you can do today"
          links={[
            { label: 'Discover destinations', to: DISCOVER.path },
            { label: 'Help and support', to: INFO_PATHS.help },
            { label: 'Platform status', to: INFO_PATHS.status },
          ]}
        />
      }
    >
      <h2>What Wayora is for</h2>
      <p>
        Most trips cross several kinds of travel: a flight, a train or bus, a hotel, a cab from the
        station. Wayora is being designed to bring flights, hotels, trains, buses, metro, cabs and
        holiday packages together, so the parts of a journey can be planned side by side.
      </p>
      <h2>Where it is today</h2>
      <p>Wayora is in development. Today you can:</p>
      <ul>
        <li>
          explore a small, curated set of <Link to={DISCOVER.path}>sample destinations</Link>, by
          mood or region;
        </li>
        <li>
          try a demo search for each travel service: flights, hotels, trains, buses, metro, cabs and
          holiday packages, using clearly labelled sample data;
        </li>
        <li>
          choose the currency you&apos;d like prices shown in (demo prices are in rupees and
          aren&apos;t converted);
        </li>
        <li>
          <Link to={ACCOUNT_PATHS.register}>create an account</Link> and save the people you travel
          with, ready for when booking opens.
        </li>
      </ul>
      <p>
        Search results are demo data from Wayora&apos;s own sample fixtures, not from travel
        providers: their prices and times are illustrative, availability isn&apos;t checked, and
        nothing can be booked. No ratings or reviews are shown anywhere.
      </p>
      <h2>How it will grow</h2>
      <p>
        Services open one at a time, each with its own booking flow and real travel providers. Until
        then, every search page labels its results as demo data.
      </p>
    </ContentPage>
  );
}

const FAQ: { q: string; a: ReactNode }[] = [
  {
    q: 'Can I book travel on Wayora?',
    a: (
      <>
        Not yet. Each service page has a demo search so you can try planning, but its results are
        sample data and nothing can be reserved or paid for. Booking opens one service at a time.
      </>
    ),
  },
  {
    q: 'Are the destinations, prices and ratings real?',
    a: (
      <>
        Discover uses a small, curated set of sample destinations with editorial descriptions. The
        prices and times in search results are demo data: illustrative, not live fares, and not
        bookable. Availability isn&apos;t checked, and Wayora shows no ratings, reviews or deals.
      </>
    ),
  },
  {
    q: 'What does the currency selector do?',
    a: (
      <>
        It sets the currency you&apos;d like prices shown in, for this visit. Nothing is converted
        or charged, and the choice isn&apos;t saved: it resets when you reload the page.
      </>
    ),
  },
  {
    q: 'Do I need an account?',
    a: (
      <>
        Only to save travellers. Browsing Discover and the service pages works without one. You can{' '}
        <Link to={ACCOUNT_PATHS.register}>create an account</Link> with your name, email and a
        password; see <a href="#accounts">Your account</a> above for what it stores.
      </>
    ),
  },
  {
    q: 'Something isn’t working. Where can I check?',
    a: (
      <>
        <Link to={INFO_PATHS.status}>Platform status</Link> shows whether Wayora&apos;s API and the
        services it depends on are reachable right now.
      </>
    ),
  },
  {
    q: 'Does Wayora use cookies?',
    a: (
      <>
        Only one, and only when you sign in: a session cookie that keeps you signed in. It
        can&apos;t be read by the page&apos;s scripts and is removed when you sign out. Besides
        that, the browser keeps only scroll positions for the current tab, so Back returns you to
        the same place. Wayora loads no analytics or advertising scripts. The{' '}
        <Link to={INFO_PATHS.privacy}>draft privacy page</Link> has the details.
      </>
    ),
  },
];

/** /help */
export function HelpRoute() {
  return (
    <ContentPage
      eyebrow="Support"
      title="Help and support"
      description="Answers to common questions about what Wayora does today."
      aside={
        <Card padding="md" className="flex flex-col gap-2">
          <h2 className="text-label text-ink">Contacting Wayora</h2>
          <p className="text-body-sm text-ink-secondary">
            There&apos;s no support contact yet. One will be added before booking opens, when
            there&apos;s something to support.
          </p>
        </Card>
      }
      after={
        <section aria-labelledby="faq-title" className="flex flex-col gap-4">
          <h2 id="faq-title" className="text-heading-3">
            Frequently asked questions
          </h2>
          <Accordion type="multiple" className="border-t border-line">
            {FAQ.map((item, i) => (
              <AccordionItem key={item.q} value={`q${i}`}>
                <AccordionTrigger className="text-body font-semibold">{item.q}</AccordionTrigger>
                <AccordionContent className="text-body text-ink-secondary [&_a]:font-semibold [&_a]:text-brand-ink [&_a]:underline [&_a]:underline-offset-4">
                  {item.a}
                </AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        </section>
      }
    >
      <p>
        Wayora is in development, so there&apos;s less to go wrong than on a live booking site:
        nothing is booked or paid for. If you&apos;re wondering what something does, the answers
        below cover what exists today.
      </p>
      <h2 id="accounts" className="scroll-mt-(--header-offset)">
        Your account
      </h2>
      <p>
        An account holds your name, your email address, your password (stored only as a one-way
        hash, never as the password itself) and any travellers you save: their names and,
        optionally, date of birth and nationality. Wayora never asks for passport or ID numbers.
      </p>
      <ul>
        <li>
          <strong>Staying signed in.</strong> You stay signed in for up to 30 days, or until 7 days
          pass without using Wayora. Sign out from the account menu, or from your{' '}
          <Link to={ACCOUNT_PATHS.profile}>profile</Link>, where you can also sign out on all
          devices at once.
        </li>
        <li>
          <strong>Forgotten password.</strong> Password reset isn&apos;t available yet, because
          Wayora doesn&apos;t send email yet and a reset must be confirmed by email to be safe.
          It&apos;ll be added with email support.
        </li>
        <li>
          <strong>Changing your email or deleting your account.</strong> Not available in the app
          yet. Your name and saved travellers can be changed or removed at any time.
        </li>
      </ul>
    </ContentPage>
  );
}

/** /legal/privacy (draft) */
export function PrivacyRoute() {
  return (
    <ContentPage
      eyebrow={<Badge tone="warning">Draft</Badge>}
      title="Privacy policy"
      description="How the current preview of Wayora handles information. This is not yet a published policy."
      notice={
        <DraftNotice>
          A privacy policy will be written and reviewed by qualified legal counsel before Wayora
          launches booking or opens accounts to the public. Until then, this page only describes
          what the preview does today. Nothing here is a legal commitment.
        </DraftNotice>
      }
      aside={
        <RelatedLinks
          title="Related"
          links={[
            { label: 'Terms and conditions (draft)', to: INFO_PATHS.terms },
            { label: 'Help and support', to: INFO_PATHS.help },
          ]}
        />
      }
    >
      <h2>What the preview does today</h2>
      <ul>
        <li>
          <strong>Accounts, if you create one.</strong> Wayora stores your name, email address and a
          one-way hash of your password (Argon2id; the password itself is never stored or logged),
          plus any travellers you save: names and, optionally, date of birth and nationality. No
          passport or ID numbers, and no payment details: nothing can be booked or paid for.
        </li>
        <li>
          <strong>Sign-in sessions.</strong> For each sign-in, Wayora records when the session
          started, when it was last used and when it expires. Sessions end after 7 days without use
          or 30 days at most, and when you sign out. Ended sessions are deleted about a day later.
        </li>
        <li>
          <strong>One cookie, only when signed in.</strong> A strictly necessary session cookie
          keeps you signed in. Page scripts can&apos;t read it and it isn&apos;t used for tracking.
          Wayora&apos;s pages also keep scroll positions in your browser&apos;s session storage, so
          Back and Forward return you to where you were; it holds no personal information and is
          cleared when the tab closes. Nothing else is stored; choices such as display currency last
          only until you reload.
        </li>
        <li>
          <strong>No analytics, advertising or third-party trackers.</strong> Fonts and images are
          served by Wayora itself.
        </li>
        <li>
          <strong>Technical request logs.</strong> When the site calls Wayora&apos;s API, the server
          logs each request&apos;s method, path, response status, browser user-agent string and a
          request ID, to run and debug the service. A retention period hasn&apos;t been set yet.
        </li>
        <li>
          <strong>Rate limiting.</strong> To protect the API, it counts requests from each network
          address over a short window (one minute by default) and rejects excess requests. Sign-in
          attempts are also counted per email address (as a one-way hash) for 15 minutes, to slow
          down password guessing.
        </li>
      </ul>
      <h2>What the published policy must cover</h2>
      <p>Before launch, the reviewed policy will need to address, at least:</p>
      <ul>
        <li>
          information collected for accounts, bookings and payments, the legal basis, and why;
        </li>
        <li>travel providers and payment processors it is shared with;</li>
        <li>how long information is kept, and log retention;</li>
        <li>your rights over your information and how to exercise them;</li>
        <li>the session cookie, and any further cookies or browser storage that are introduced;</li>
        <li>how to change your email, export your information or delete your account;</li>
        <li>who is responsible for your information and how to contact them.</li>
      </ul>
    </ContentPage>
  );
}

/** /legal/terms (draft) */
export function TermsRoute() {
  return (
    <ContentPage
      eyebrow={<Badge tone="warning">Draft</Badge>}
      title="Terms and conditions"
      description="The terms for using Wayora haven't been published yet."
      notice={
        <DraftNotice>
          Terms and conditions will be written and reviewed by qualified legal counsel before Wayora
          launches booking or accounts. This page is a placeholder and is not an agreement.
        </DraftNotice>
      }
      aside={
        <RelatedLinks
          title="Related"
          links={[
            { label: 'Privacy policy (draft)', to: INFO_PATHS.privacy },
            { label: 'About Wayora', to: INFO_PATHS.about },
          ]}
        />
      }
    >
      <h2>Where things stand</h2>
      <p>
        Wayora is in development. There are no bookings or payments. Accounts exist so you can save
        travellers ahead of booking, and the destination content in Discover is illustrative sample
        material, not an offer of travel.
      </p>
      <h2>What the published terms must cover</h2>
      <p>Before launch, the reviewed terms will need to address, at least:</p>
      <ul>
        <li>booking, confirmation and the role of each travel provider;</li>
        <li>prices, payments, cancellations, changes and refunds;</li>
        <li>accounts and acceptable use;</li>
        <li>liability and its limits;</li>
        <li>governing law and how disputes are handled.</li>
      </ul>
      <p className="flex items-center gap-2 text-body-sm">
        <FileWarning aria-hidden="true" className="size-4 shrink-0 text-warning" />
        Until then, nothing on this site creates a contract.
      </p>
    </ContentPage>
  );
}
