import { BedDouble, Plane, TrainFront } from 'lucide-react';
import {
  DestinationCard,
  DestinationFeatureCard,
  DestinationImage,
  Grid,
  JourneySummary,
  PriceDisplay,
  RatingBadge,
  ServiceCategoryCard,
  TravellerCountDisplay,
} from '@wayora/ui';
import { moodBySlug } from '../discover/data';
import { placeLine } from '../discover/format';
import { findDestination } from '../discover/search';
import { Code, ShowcaseSection, Specimen } from './showcase';

export function TravelSection() {
  return (
    <ShowcaseSection
      id="travel"
      title="Travel components"
      description={
        <>
          Domain building blocks for the booking phases. Example data is fictional. Prices take
          integer minor units (<Code>amountMinor</Code>, matching the API&apos;s money contract) and
          are formatted exactly, never with floats.
        </>
      }
    >
      <div className="grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-2">
        <Specimen label="PriceDisplay" note="sizes, prefix, unit, previous price">
          <div className="flex flex-wrap items-end gap-8">
            <PriceDisplay amountMinor="1248000" currency="INR" size="lg" />
            <PriceDisplay
              prefix="From"
              amountMinor="499900"
              originalAmountMinor="599900"
              currency="INR"
              suffix="per night"
            />
            <PriceDisplay
              amountMinor="18950"
              currency="USD"
              locale="en-US"
              size="sm"
              suffix="per person"
            />
            <PriceDisplay amountMinor="15000" currency="JPY" locale="en-US" size="sm" />
          </div>
        </Specimen>
        <Specimen label="RatingBadge and TravellerCountDisplay">
          <div className="flex flex-col gap-5">
            <div className="flex flex-wrap gap-6">
              <RatingBadge score={9.1} reviewCount={1284} />
              <RatingBadge score={4.3} outOf={5} reviewCount={312} />
              <RatingBadge score={7.4} size="sm" />
            </div>
            <div className="flex flex-col gap-2">
              <TravellerCountDisplay adults={2} children={1} rooms={1} />
              <TravellerCountDisplay adults={1} travelClass="Business" />
              <TravellerCountDisplay adults={2} children={2} infants={1} variant="compact" />
            </div>
          </div>
        </Specimen>
        <Specimen label="JourneySummary" note="flight and train">
          <div className="flex flex-col gap-6">
            <JourneySummary
              mode="flight"
              operator="Example Air WX 214"
              origin={{ name: 'Bengaluru', code: 'BLR', time: '06:45', detail: 'Terminal 2' }}
              destination={{ name: 'New Delhi', code: 'DEL', time: '09:30', detail: 'Terminal 3' }}
              durationMinutes={165}
              stops={0}
            />
            <JourneySummary
              mode="train"
              operator="Example Express 12628"
              origin={{ name: 'Chennai Central', code: 'MAS', time: '22:10' }}
              destination={{ name: 'Mumbai CSMT', code: 'CSMT', time: '20:55' }}
              durationMinutes={1365}
              stops={11}
              dayOffset={1}
            />
          </div>
        </Specimen>
        <Specimen label="ServiceCategoryCard" note="planned is a non-interactive preview">
          <div className="grid grid-cols-[minmax(0,1fr)] gap-4 sm:grid-cols-2">
            <ServiceCategoryCard
              icon={<Plane />}
              name="Flights"
              tagline="Domestic and international"
              availability="planned"
            />
            <ServiceCategoryCard
              icon={<TrainFront />}
              name="Trains"
              tagline="Intercity rail"
              availability="live"
              link={<a href="#travel" />}
            />
          </div>
        </Specimen>
      </div>
      <Specimen
        label="DestinationCard"
        tone="page"
        note="stacked, featured and split layouts with the Discover sample data. priceFrom and rating exist for real, sourced data only, so they are not shown with placeholder values"
      >
        <Grid columns={{ base: 1, sm: 2, lg: 3 }} gap={5}>
          {(['kyoto', 'jaipur'] as const).map((slug, i) => {
            const d = findDestination(slug);
            return d ? (
              <DestinationCard
                key={slug}
                name={d.name}
                region={placeLine(d)}
                description={d.description}
                image={d.image}
                tags={d.categories.map((c) => moodBySlug[c].title)}
                tagsLabel="Travel moods"
                featured={i === 0 ? "Editor's pick" : undefined}
                link={<a href="#travel" />}
              />
            ) : null;
          })}
          <DestinationCard
            name="Udaipur"
            region="Rajasthan, India"
            description="No image yet: the branded placeholder keeps the frame."
            aspect="square"
            tags={['Lakes', 'Palaces']}
          />
        </Grid>
        <div className="mt-5">
          {(() => {
            const d = findDestination('singapore');
            return d ? (
              <DestinationCard
                layout="split"
                name={d.name}
                region={placeLine(d)}
                description={d.description}
                image={d.image}
                tags={d.categories.map((c) => moodBySlug[c].title)}
                link={<a href="#travel" />}
              />
            ) : null;
          })()}
        </div>
      </Specimen>
      <Specimen
        label="DestinationFeatureCard"
        note="editorial tiles: image, scrim, stretched link; size with aspect or className"
      >
        <Grid columns={{ base: 1, md: 2 }} gap={5}>
          <DestinationFeatureCard
            aspect="portrait"
            name="Kerala"
            region="South India"
            description="Backwaters, tea hills and slow mornings by the water."
            image={findDestination('kerala')?.image}
            cta="Explore Kerala"
            link={<a href="#travel" />}
          />
          <DestinationFeatureCard
            aspect="portrait"
            name="Jaipur"
            region="Rajasthan"
            titleSize="lg"
            image={findDestination('jaipur')?.image}
            link={<a href="#travel" />}
          />
        </Grid>
      </Specimen>
      <Specimen
        label="DestinationImage"
        note="fixed ratio, focal point, portrait crop, lazy, placeholder when there is no image"
      >
        <div className="grid grid-cols-[minmax(0,1fr)] gap-5 sm:grid-cols-3">
          <DestinationImage
            name="Goa"
            image={findDestination('goa')?.image}
            aspect="4/3"
            className="rounded-lg"
          />
          <DestinationImage
            name="Manali"
            image={findDestination('manali')?.image}
            aspect="1/1"
            className="rounded-lg"
          />
          <DestinationImage name="Hampi" aspect="4/3" className="rounded-lg" />
        </div>
      </Specimen>
      <Specimen label="Icons" note="Lucide, 1.75 stroke, 16/20/24px">
        <div className="flex items-center gap-6 text-ink">
          <Plane className="size-4" strokeWidth={1.75} />
          <Plane className="size-5" strokeWidth={1.75} />
          <Plane className="size-6" strokeWidth={1.75} />
          <BedDouble className="size-6 text-brand" strokeWidth={1.75} />
          <TrainFront className="size-6 text-ink-secondary" strokeWidth={1.75} />
        </div>
      </Specimen>
    </ShowcaseSection>
  );
}
