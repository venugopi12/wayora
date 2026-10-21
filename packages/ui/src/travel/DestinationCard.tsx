import { MapPin, Sparkles } from 'lucide-react';
import type { ReactElement } from 'react';
import { Badge } from '../components/Badge';
import { Card } from '../layout/Card';
import { cn } from '../lib/cn';
import type { MinorAmount } from '../lib/format';
import { linkedTitle, destinationMediaAspect, type DestinationAspect } from './destination-shared';
import { DestinationImage, type DestinationImageSource } from './DestinationImage';
import { PriceDisplay } from './PriceDisplay';
import { RatingBadge } from './RatingBadge';

export type { DestinationAspect };

export interface DestinationCardProps {
  name: string;
  /** Region / country line, e.g. "Rajasthan, India". */
  region: string;
  /** One or two sentences about the place. */
  description?: string;
  image?: DestinationImageSource;
  /** Image ratio. Default `landscape`. */
  aspect?: DestinationAspect;
  /** Only for real, sourced prices. Never show placeholder amounts. */
  priceFrom?: { amountMinor: MinorAmount; currency: string; suffix?: string };
  /** Only for real, sourced ratings. */
  rating?: { score: number; outOf?: 5 | 10; reviewCount?: number };
  /** Short descriptors, e.g. ["Beaches", "Nightlife"]. */
  tags?: string[];
  /** Accessible name for the tag list. Default "Highlights". */
  tagsLabel?: string;
  /**
   * Editorial emphasis: a badge over the image. `true`
   * shows "Featured"; pass a string for other wording (e.g. "Editor's pick").
   * Never use it to imply popularity, availability or a deal.
   */
  featured?: boolean | string;
  /**
   * `stacked` (default): image above the text.
   * `split`: image beside the text from the `sm` breakpoint, for list rows.
   */
  layout?: 'stacked' | 'split';
  /** Link element, e.g. <Link to="/destinations/goa" />. Makes the whole card clickable. */
  link?: ReactElement;
  headingLevel?: 'h2' | 'h3';
  /** Load the image eagerly (above the fold). */
  priority?: boolean;
  sizes?: string;
  className?: string;
}

/**
 * Destination card for grids and results: image above (or beside, with
 * `layout="split"`) a white body. Images
 * keep a fixed ratio with focal-point cropping, lazy-load and fall back to a
 * branded placeholder, so the layout never shifts. When `link` is given the
 * name becomes the link and its hit area covers the card (one tab stop, a
 * sensible accessible name). For editorial, full-bleed tiles use
 * `DestinationFeatureCard`.
 */
export function DestinationCard({
  name,
  region,
  description,
  image,
  aspect = 'landscape',
  priceFrom,
  rating,
  tags,
  tagsLabel = 'Highlights',
  featured,
  layout = 'stacked',
  link,
  headingLevel: Heading = 'h3',
  priority,
  sizes,
  className,
}: DestinationCardProps) {
  const { interactive, title } = linkedTitle(name, link, 'rounded-xs');
  const split = layout === 'split';
  const featuredLabel = featured === true ? 'Featured' : featured || null;
  return (
    <Card
      interactive={interactive}
      padding="none"
      className={cn(
        'group flex flex-col overflow-hidden',
        split && 'sm:grid sm:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]',
        className,
      )}
    >
      <DestinationImage
        name={name}
        image={image && sizes ? { ...image, sizes } : image}
        aspect={destinationMediaAspect[aspect]}
        priority={priority}
        className={cn('bg-brand-soft', split && 'sm:aspect-auto sm:h-full sm:min-h-72')}
      >
        {featuredLabel ? (
          <Badge
            tone="brand"
            size="sm"
            icon={<Sparkles aria-hidden="true" />}
            className="absolute top-3 left-3 bg-card/95 shadow-xs backdrop-blur-sm"
          >
            {featuredLabel}
          </Badge>
        ) : null}
      </DestinationImage>
      <div
        className={cn(
          'flex flex-1 flex-col gap-3 p-5',
          split && 'sm:justify-center sm:gap-4 sm:p-8 lg:p-10',
        )}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <Heading className={cn('text-title', split && 'sm:text-heading-2')}>{title}</Heading>
            <p className="mt-0.5 flex items-center gap-1 text-body-sm text-ink-secondary">
              <MapPin className="size-3.5 shrink-0" aria-hidden="true" />
              {region}
            </p>
          </div>
          {rating ? <RatingBadge size="sm" {...rating} /> : null}
        </div>
        {description ? (
          <p
            className={cn(
              'text-body-sm text-ink-secondary',
              split && 'sm:max-w-md sm:text-body-lg',
            )}
          >
            {description}
          </p>
        ) : null}
        {tags?.length ? (
          <ul
            className={cn('flex flex-wrap gap-1.5 pt-1', !split && 'mt-auto')}
            aria-label={tagsLabel}
          >
            {tags.map((tag) => (
              <li
                key={tag}
                className="rounded-full bg-sunken px-2.5 py-0.5 text-caption text-ink-secondary"
              >
                {tag}
              </li>
            ))}
          </ul>
        ) : null}
        {priceFrom ? (
          <div className="mt-auto border-t border-line pt-3">
            <PriceDisplay
              prefix="From"
              amountMinor={priceFrom.amountMinor}
              currency={priceFrom.currency}
              suffix={priceFrom.suffix}
              size="sm"
            />
          </div>
        ) : null}
      </div>
    </Card>
  );
}
