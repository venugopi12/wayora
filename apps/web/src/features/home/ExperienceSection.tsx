import { CircleDot, MapPin } from 'lucide-react';
import { motion, useInView } from 'motion/react';
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Badge, Container, PageHeader, cn } from '@wayora/ui';
import { Reveal, transitions, useMotionPreferences } from '@wayora/ui/motion';
import { SERVICE_NAV, serviceBySlug } from '../navigation/config';

const CHAPTERS = [
  {
    title: 'Every way to travel, in one place.',
    body: "Flights, stays, trains, buses, metro, cabs and holiday packages are being built into a single platform, so planning a trip won't mean juggling a different site for every leg.",
  },
  {
    title: 'A clearer way to plan.',
    body: 'Wayora is designed around the journey rather than the ticket: see how each leg connects, from the first train to the last transfer, before you commit.',
  },
  {
    title: 'Your trip, kept together.',
    body: 'As booking opens, tickets, stays and transfers will sit in one itinerary you can come back to. It is on the roadmap, not live yet.',
  },
] as const;

/** Chapter 1: the seven services as stops on one arc (a simple grid on phones). */
function ModesVisual() {
  return (
    <div className="relative flex h-full flex-col justify-center p-6 sm:p-8">
      <svg
        viewBox="0 0 420 120"
        aria-hidden="true"
        className="absolute inset-x-8 top-1/2 hidden -translate-y-[70%] text-brand-300 sm:block"
      >
        <path
          d="M20 100 C120 10 300 10 400 100"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeDasharray="2 8"
          strokeLinecap="round"
        />
      </svg>
      <ul
        className="relative grid grid-cols-4 gap-x-2 gap-y-5 sm:grid-cols-7"
        aria-label="Services in development"
      >
        {SERVICE_NAV.map((s, i) => {
          const Icon = s.icon;
          const lift = Math.round(Math.sin((i / 6) * Math.PI) * -34);
          return (
            <li
              key={s.slug}
              className="flex flex-col items-center gap-2 text-center sm:translate-y-(--lift)"
              style={{ '--lift': `${lift}px` } as CSSProperties}
            >
              <span className="grid size-11 place-items-center rounded-full bg-deep text-ink-inverse ring-1 ring-white/25 [&_svg]:size-5">
                <Icon strokeWidth={1.75} aria-hidden="true" />
              </span>
              <span className="text-caption text-ink-inverse-secondary">
                {s.name.replace(' packages', '')}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Chapter 2: one journey, several legs, different modes. Generic labels only. */
function RouteVisual() {
  const stops = [
    { label: 'Origin', next: { mode: serviceBySlug.trains, text: 'by train to the airport' } },
    { label: 'Stopover', next: { mode: serviceBySlug.flights, text: 'by flight to your city' } },
    { label: 'Destination', next: null },
  ];
  return (
    <ol
      className="flex h-full flex-col justify-center p-6 sm:p-8"
      aria-label="Example of a multi-leg journey"
    >
      {stops.map(({ label, next }, i) => {
        const last = next === null;
        const Icon = next?.mode.icon;
        return (
          <li key={label} className="relative flex gap-5 pb-8 last:pb-0">
            {!last ? (
              <span
                aria-hidden="true"
                className="absolute top-8 bottom-0 left-[15px] w-0.5 bg-brand-300/50"
              />
            ) : null}
            <span
              aria-hidden="true"
              className={cn(
                'relative z-10 grid size-8 shrink-0 place-items-center rounded-full',
                i === 1 ? 'border-2 border-white bg-deep' : 'bg-white text-deep',
              )}
            >
              {i === 1 ? null : <MapPin className="size-4" />}
            </span>
            <div className="flex flex-col gap-1.5 pt-1">
              <span className="text-label text-ink-inverse">{label}</span>
              {next && Icon ? (
                <span className="inline-flex items-center gap-2 text-caption text-ink-inverse-secondary">
                  <Icon className="size-4 text-brand-300" strokeWidth={1.75} aria-hidden="true" />
                  Then {next.text}
                </span>
              ) : (
                <span className="text-caption text-ink-inverse-secondary">
                  Arrive, with every leg in view
                </span>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/** Chapter 3: a skeleton of a future itinerary view (no fake bookings). */
function ItineraryVisual() {
  const rows = [serviceBySlug.trains, serviceBySlug.hotels, serviceBySlug.cabs];
  return (
    <div className="flex h-full flex-col justify-center gap-4 p-8">
      <p className="text-caption text-ink-inverse-secondary">Preview of a future itinerary view</p>
      {rows.map((s, i) => {
        const Icon = s.icon;
        return (
          <div
            key={s.slug}
            className="flex items-center gap-4 rounded-lg bg-white/[0.06] p-4 ring-1 ring-white/10"
          >
            <span className="grid size-10 shrink-0 place-items-center rounded-md bg-white/10 text-brand-200 [&_svg]:size-5">
              <Icon strokeWidth={1.75} aria-hidden="true" />
            </span>
            <div className="flex flex-1 flex-col gap-2" aria-hidden="true">
              <span
                className="h-2.5 rounded-full bg-white/25"
                style={{ width: `${72 - i * 12}%` }}
              />
              <span className="h-2 rounded-full bg-white/12" style={{ width: `${46 + i * 10}%` }} />
            </div>
            <CircleDot className="size-4 text-brand-300" aria-hidden="true" />
          </div>
        );
      })}
    </div>
  );
}

const VISUALS = [ModesVisual, RouteVisual, ItineraryVisual];

function Chapter({ index, onActive }: { index: number; onActive: (i: number) => void }) {
  const ref = useRef<HTMLLIElement>(null);
  // Active while the chapter crosses the middle band of the viewport.
  const inView = useInView(ref, { margin: '-45% 0px -45% 0px' });
  useEffect(() => {
    if (inView) onActive(index);
  }, [inView, index, onActive]);
  const chapter = CHAPTERS[index]!;
  const Visual = VISUALS[index]!;
  return (
    <li ref={ref} className="flex flex-col gap-6 lg:min-h-[56vh] lg:justify-center">
      <div className="aspect-[5/4] overflow-hidden rounded-2xl bg-deep text-ink-inverse lg:hidden">
        <Visual />
      </div>
      <div className="flex flex-col gap-4">
        <div className="flex items-center gap-3">
          <span className="numeric text-label text-brand-ink">
            {String(index + 1).padStart(2, '0')}
          </span>
          <Badge size="sm">In development</Badge>
        </div>
        <h3 className="text-heading-2">{chapter.title}</h3>
        <p className="max-w-[32rem] text-body-lg text-ink-secondary">{chapter.body}</p>
      </div>
    </li>
  );
}

/**
 * "The Wayora experience": restrained scroll storytelling. On large screens
 * a sticky visual changes as each chapter passes the middle of the viewport;
 * the page scrolls normally (no pinning or scroll-jacking). Smaller screens
 * get a simple stacked sequence with each visual inline.
 */
export function ExperienceSection() {
  const [active, setActive] = useState(0);
  const { reduce } = useMotionPreferences();

  return (
    <section
      id="experience"
      aria-labelledby="experience-title"
      className="scroll-mt-(--header-offset) bg-sunken py-section"
    >
      <Container size="wide">
        <Reveal preset="sectionReveal">
          <PageHeader
            size="section"
            headingLevel="h2"
            id="experience-title"
            eyebrow="The Wayora experience"
            title="Designed around the whole journey."
            description="What we're building, and how it will come together as each service opens."
          />
        </Reveal>
        <div className="mt-12 grid gap-12 lg:mt-0 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:gap-20">
          <div className="hidden lg:block">
            <div className="sticky top-[max(7rem,calc(50vh-15rem))] aspect-[5/4] overflow-hidden rounded-2xl bg-deep text-ink-inverse shadow-lg">
              {VISUALS.map((Visual, i) => (
                <motion.div
                  key={i}
                  className="absolute inset-0"
                  aria-hidden={i !== active}
                  initial={false}
                  animate={{ opacity: i === active ? 1 : 0, y: reduce || i === active ? 0 : 12 }}
                  transition={reduce ? transitions.instant : transitions.emphasized}
                >
                  <Visual />
                </motion.div>
              ))}
              <ol aria-hidden="true" className="absolute right-6 bottom-6 flex gap-2">
                {CHAPTERS.map((_, i) => (
                  <li
                    key={i}
                    className={cn(
                      'h-1.5 rounded-full transition-[width,background-color] duration-(--duration-base) ease-emphasized',
                      i === active ? 'w-6 bg-white' : 'w-1.5 bg-white/35',
                    )}
                  />
                ))}
              </ol>
            </div>
          </div>
          <ol className="flex flex-col gap-16 lg:gap-0">
            {CHAPTERS.map((_, i) => (
              <Chapter key={i} index={i} onActive={setActive} />
            ))}
          </ol>
        </div>
      </Container>
    </section>
  );
}
