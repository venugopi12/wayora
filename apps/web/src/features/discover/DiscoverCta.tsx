import { ArrowRight, ArrowUp } from 'lucide-react';
import { Link } from 'react-router';
import { Button, Container, Eyebrow } from '@wayora/ui';
import { Reveal } from '@wayora/ui/motion';

/**
 * Closing call to action. Points to the two real next steps today: search
 * again, or choose how to travel on the homepage. No booking is implied.
 */
export function DiscoverCta() {
  return (
    <section
      aria-labelledby="discover-cta-title"
      className="relative isolate overflow-hidden bg-deep text-ink-inverse focus-ring-inverse"
    >
      <div
        aria-hidden="true"
        className="absolute inset-0 -z-10 bg-[radial-gradient(60%_80%_at_85%_10%,rgb(84_99_177/0.55),transparent_70%),radial-gradient(45%_55%_at_0%_45%,rgb(217_154_166/0.22),transparent_70%)]"
      />
      <Container
        size="wide"
        className="flex flex-col gap-10 py-section lg:flex-row lg:items-end lg:justify-between"
      >
        <Reveal preset="sectionReveal" className="flex max-w-[40rem] flex-col gap-5">
          <Eyebrow tone="inverse">Your next step</Eyebrow>
          <h2 id="discover-cta-title" className="text-display max-w-[14ch]">
            Found a place that feels right?
          </h2>
          <p className="text-body-lg text-ink-inverse-secondary">
            Open its page to see how you could travel there. Flights, stays, trains and more open on
            Wayora one service at a time.
          </p>
        </Reveal>
        <Reveal preset="fadeUp" delay={0.15} className="flex flex-col gap-3 sm:flex-row lg:pb-2">
          <Button
            size="lg"
            variant="inverse"
            trailingIcon={<ArrowUp aria-hidden="true" />}
            onClick={() => {
              const input = document.getElementById('discover-query');
              const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
              input
                ?.closest('section')
                ?.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
              input?.focus({ preventScroll: true });
            }}
          >
            Search destinations
          </Button>
          <Button asChild size="lg" variant="outline-inverse">
            <Link to="/#journeys">
              Choose how to travel
              <ArrowRight aria-hidden="true" />
            </Link>
          </Button>
        </Reveal>
      </Container>
    </section>
  );
}
