import { ArrowRight, ArrowUp } from 'lucide-react';
import { Link } from 'react-router';
import { BRAND_ROUTE_PATH, Button, Container, MediaFrame } from '@wayora/ui';
import { DrawPath, Reveal } from '@wayora/ui/motion';
import { DISCOVER } from '../navigation/config';
import { CTA_MEDIA } from './media';

/**
 * Closing call to action. The night artwork fades into the footer's navy, so
 * the page ends in one continuous scene. The brand route draws in once.
 */
export function ClosingCta() {
  return (
    <section
      aria-labelledby="cta-title"
      className="relative isolate overflow-hidden bg-deep text-ink-inverse focus-ring-inverse"
    >
      <MediaFrame
        aspect="fill"
        src={CTA_MEDIA.src}
        sources={
          CTA_MEDIA.portraitSrc
            ? [{ media: '(max-width: 767px)', srcSet: CTA_MEDIA.portraitSrc }]
            : undefined
        }
        alt={CTA_MEDIA.alt}
        fallbackColor={CTA_MEDIA.tone}
        className="-z-10"
      />
      <div
        aria-hidden="true"
        className="absolute inset-0 -z-10 bg-[radial-gradient(ellipse_60%_45%_at_50%_58%,rgb(23_27_53/0.7),transparent_75%)]"
      />
      <Container
        size="narrow"
        className="flex min-h-[38rem] flex-col items-center justify-center gap-7 py-section text-center lg:min-h-[44rem]"
      >
        <svg viewBox="0 0 32 32" aria-hidden="true" className="size-16 text-white" fill="none">
          <DrawPath
            d={BRAND_ROUTE_PATH}
            delay={0.2}
            viewport={{ margin: '0px' }}
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
          />
          <circle cx="8" cy="10.5" r="2" fill="currentColor" />
          <circle cx="16" cy="10.5" r="1.6" stroke="currentColor" strokeWidth="1.2" />
          <circle cx="24" cy="10.5" r="2" fill="currentColor" />
        </svg>
        <Reveal preset="sectionReveal" className="flex flex-col items-center gap-5">
          <h2 id="cta-title" className="text-display max-w-[14ch]">
            Where will your next line lead?
          </h2>
          <p className="max-w-[34rem] text-body-lg text-ink-inverse-secondary">
            Pick a place, follow a mood, and travel with Wayora as each service comes online.
          </p>
          <div className="flex flex-col gap-3 pt-2 sm:flex-row">
            <Button asChild size="lg" variant="inverse">
              <Link to={DISCOVER.path}>
                Discover destinations
                <ArrowRight aria-hidden="true" />
              </Link>
            </Button>
            <Button asChild size="lg" variant="outline-inverse">
              <a href="#journeys">
                Choose how to travel
                <ArrowUp aria-hidden="true" />
              </a>
            </Button>
          </div>
        </Reveal>
      </Container>
    </section>
  );
}
