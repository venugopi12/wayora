import { render, screen } from '@testing-library/react';
import { Plane } from 'lucide-react';
import { describe, expect, it } from 'vitest';
import {
  DestinationCard,
  DestinationFeatureCard,
  DestinationImage,
  JourneySummary,
  PriceDisplay,
  RatingBadge,
  ServiceCategoryCard,
  TravellerCountDisplay,
  describeTravellers,
  formatMoney,
  minorToDecimalString,
} from '../src';

describe('money formatting', () => {
  it('converts minor units exactly, including values beyond Number.MAX_SAFE_INTEGER', () => {
    expect(minorToDecimalString('149950', 2)).toBe('1499.50');
    expect(minorToDecimalString(5n, 2)).toBe('0.05');
    expect(minorToDecimalString(-150, 2)).toBe('-1.50');
    expect(minorToDecimalString('900719925474099312', 2)).toBe('9007199254740993.12');
  });

  it('formats INR with Indian grouping and drops .00 on whole amounts', () => {
    expect(formatMoney('12345600', 'INR')).toBe('₹1,23,456');
    expect(formatMoney('149950', 'INR')).toBe('₹1,499.50');
  });

  it('respects currencies without minor units (JPY) and with three (BHD)', () => {
    expect(formatMoney('15000', 'JPY', { locale: 'en-US' })).toBe('¥15,000');
    expect(formatMoney('1250', 'BHD', { locale: 'en-US', minorDigits: 'always' })).toMatch(
      /^BHD\s1\.250$/,
    );
  });
});

describe('PriceDisplay', () => {
  it('reads as one sentence including prefix, unit and previous price', () => {
    render(
      <PriceDisplay
        prefix="From"
        amountMinor="499900"
        originalAmountMinor="599900"
        currency="INR"
        suffix="per night"
      />,
    );
    expect(screen.getByText('From ₹4,999 per night, was ₹5,999')).toHaveClass('sr-only');
  });
});

describe('RatingBadge', () => {
  it.each([
    [9.2, 10, 'Exceptional'],
    [8.4, 10, 'Excellent'],
    [4.1, 5, 'Excellent'],
    [6.1, 10, 'Good'],
  ] as const)('%s/%s is "%s"', (score, outOf, label) => {
    render(<RatingBadge score={score} outOf={outOf} reviewCount={1} />);
    expect(
      screen.getByText(`Rated ${score.toFixed(1)} out of ${outOf}, ${label}, 1 review`),
    ).toBeInTheDocument();
  });
});

describe('TravellerCountDisplay', () => {
  it('pluralises each traveller type', () => {
    expect(describeTravellers({ adults: 2, children: 1, rooms: 1 })).toBe(
      '2 adults, 1 child, 1 room',
    );
    expect(describeTravellers({ adults: 1, children: 2, infants: 1 })).toBe(
      '1 adult, 2 children, 1 infant',
    );
  });

  it('has a compact form', () => {
    render(<TravellerCountDisplay adults={2} children={1} variant="compact" />);
    expect(screen.getByText('3 travellers')).toBeInTheDocument();
  });
});

describe('JourneySummary', () => {
  it('summarises the journey in one sentence for screen readers', () => {
    render(
      <JourneySummary
        mode="flight"
        operator="6E 2134"
        origin={{ name: 'Bengaluru', code: 'BLR', time: '06:45' }}
        destination={{ name: 'Delhi', code: 'DEL', time: '09:30' }}
        durationMinutes={165}
        stops={0}
      />,
    );
    expect(
      screen.getByText(
        'Flight 6E 2134 from Bengaluru at 06:45, to Delhi arriving 09:30, 2 hours 45 minutes, Direct',
      ),
    ).toBeInTheDocument();
  });
});

describe('ServiceCategoryCard', () => {
  it('renders a planned service as a non-interactive preview, even if a link is passed', () => {
    render(
      <ServiceCategoryCard
        icon={<Plane />}
        name="Flights"
        tagline="Domestic and international air travel"
        availability="planned"
        link={<a href="/flights" />}
      />,
    );
    expect(screen.getByRole('heading', { name: 'Flights' })).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.getByText('Coming in a later phase')).toBeInTheDocument();
  });

  it('turns a live service into a single named link', () => {
    render(
      <ServiceCategoryCard
        icon={<Plane />}
        name="Flights"
        tagline="Fly anywhere"
        availability="live"
        link={<a href="/flights" />}
      />,
    );
    const link = screen.getByRole('link', { name: 'Flights' });
    expect(link).toHaveAttribute('href', '/flights');
    expect(link.className).toContain('stretched-link');
    expect(screen.getByText('Available')).toBeInTheDocument();
  });
});

describe('DestinationCard', () => {
  it('uses a branded placeholder when there is no image', () => {
    const { container } = render(<DestinationCard name="Udaipur" region="Rajasthan, India" />);
    expect(screen.getByRole('heading', { name: 'Udaipur' })).toBeInTheDocument();
    expect(container.querySelector('img')).toBeNull();
  });

  it('renders a lazy, described image and an optional price', () => {
    render(
      <DestinationCard
        name="Goa"
        region="India"
        image={{ src: '/img/goa.jpg', alt: 'Palm-lined beach at sunset' }}
        priceFrom={{ amountMinor: '450000', currency: 'INR', suffix: 'per person' }}
        link={<a href="/destinations/goa" />}
      />,
    );
    const img = screen.getByRole('img', { name: 'Palm-lined beach at sunset' });
    expect(img).toHaveAttribute('loading', 'lazy');
    expect(screen.getByRole('link', { name: 'Goa' })).toHaveAttribute('href', '/destinations/goa');
    expect(screen.getByText('From ₹4,500 per person')).toBeInTheDocument();
  });

  it('marks editorial picks with a badge and names its tag list', () => {
    render(
      <DestinationCard
        name="Kyoto"
        region="Kansai, Japan"
        image={{ src: '/img/kyoto.svg', alt: 'Pagoda among autumn trees', focalPoint: '45% 50%' }}
        tags={['Cultural journeys', 'Nature & wellness']}
        tagsLabel="Travel moods"
        featured="Editor's pick"
        link={<a href="/discover/kyoto" />}
      />,
    );
    expect(screen.getByText("Editor's pick")).toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Travel moods' })).toHaveTextContent(
      'Cultural journeys',
    );
    expect(screen.getByRole('img', { name: 'Pagoda among autumn trees' })).toHaveStyle({
      objectPosition: '45% 50%',
    });
    // One link, named by the destination: badges and tags don't leak into it.
    expect(screen.getAllByRole('link')).toHaveLength(1);
    expect(screen.getByRole('link')).toHaveAccessibleName('Kyoto');
  });

  it('defaults: "Featured" badge for true, "Highlights" tag list, stacked layout', () => {
    const { container } = render(
      <DestinationCard name="Goa" region="India" featured tags={['Beaches']} />,
    );
    expect(screen.getByText('Featured')).toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Highlights' })).toBeInTheDocument();
    expect(container.firstElementChild).not.toHaveClass('sm:grid');
  });

  it('split layout puts the image beside the text from the sm breakpoint', () => {
    const { container } = render(
      <DestinationCard layout="split" name="Singapore" region="Southeast Asia" />,
    );
    expect(container.firstElementChild).toHaveClass('sm:grid');
    expect(screen.getByRole('heading', { name: 'Singapore' })).toHaveClass('sm:text-heading-2');
  });

  it('DestinationFeatureCard: one named link, described by the copy, with a decorative CTA', () => {
    render(
      <DestinationFeatureCard
        aspect="portrait"
        name="Kerala"
        region="South India"
        description="Backwaters and tea hills."
        image={{ src: '/img/kerala.svg', alt: 'Houseboat on a backwater' }}
        cta="Explore Kerala"
        link={<a href="/discover?destination=kerala" />}
      />,
    );
    const link = screen.getByRole('link', { name: 'Kerala' });
    expect(link).toHaveAttribute('href', '/discover?destination=kerala');
    expect(link).toHaveClass('stretched-link');
    expect(link).toHaveAccessibleDescription('Backwaters and tea hills.');
    expect(screen.getAllByRole('link')).toHaveLength(1);
    expect(screen.getByText('Explore Kerala').closest('[aria-hidden="true"]')).not.toBeNull();
    expect(screen.getByRole('article')).toHaveClass('aspect-[4/5]');
  });

  it('DestinationFeatureCard lets the caller wrap the media layer (e.g. parallax)', () => {
    render(
      <DestinationFeatureCard
        name="Goa"
        region="West coast"
        image={{ src: '/img/goa.svg', alt: '' }}
        renderMedia={(media) => <div data-testid="media-wrapper">{media}</div>}
      />,
    );
    expect(screen.getByTestId('media-wrapper').querySelector('img')).not.toBeNull();
    expect(screen.getByRole('heading', { name: 'Goa' })).toBeInTheDocument();
  });
});

describe('DestinationImage', () => {
  it('reserves its ratio, crops to a focal point and serves a portrait crop', () => {
    const { container } = render(
      <DestinationImage
        name="Manali"
        aspect="4/3"
        image={{
          src: '/img/manali.svg',
          portraitSrc: '/img/manali-portrait.svg',
          alt: 'Snow peaks above a pine valley',
          focalPoint: '40% 60%',
        }}
      />,
    );
    const img = screen.getByRole('img', { name: 'Snow peaks above a pine valley' });
    expect(img).toHaveAttribute('loading', 'lazy');
    expect(img).toHaveStyle({ objectPosition: '40% 60%' });
    expect(container.firstElementChild).toHaveClass('aspect-[4/3]');
    expect(container.querySelector('source')).toHaveAttribute('srcset', '/img/manali-portrait.svg');
  });

  it('falls back to a decorative branded placeholder without an image', () => {
    const { container } = render(<DestinationImage name="Hampi" aspect="1/1" />);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('[aria-hidden="true"]')).not.toBeNull();
    expect(container.firstElementChild).toHaveClass('aspect-square');
  });
});
