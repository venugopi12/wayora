import { ClosingCta } from '../features/home/ClosingCta';
import { DestinationsSection } from '../features/home/DestinationsSection';
import { ExperienceSection } from '../features/home/ExperienceSection';
import { Hero } from '../features/home/Hero';
import { MoodSection } from '../features/home/MoodSection';
import { TravelSelector } from '../features/home/TravelSelector';
import { HomeOffers } from '../features/promotions/routes';
import { useDocumentTitle } from '../hooks/useDocumentTitle';

/**
 * Homepage narrative: arrive (hero) → choose how (travel selector) → find a
 * feeling (moods) → find a place (destinations) → understand the product
 * (experience) → go (closing CTA, flowing into the footer).
 */
export function HomeRoute() {
  useDocumentTitle();
  return (
    <>
      <Hero />
      <TravelSelector />
      <MoodSection />
      <DestinationsSection />
      {/* Only when real offers are running (Phase 26); renders nothing otherwise. */}
      <HomeOffers />
      <ExperienceSection />
      <ClosingCta />
    </>
  );
}
