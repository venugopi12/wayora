import { ArrowRight } from 'lucide-react';
import { useId, type ReactElement, type ReactNode } from 'react';
import { cn } from '../lib/cn';
import { interaction } from '../motion/presets';
import { destinationAspectClass, linkedTitle, type DestinationAspect } from './destination-shared';
import { DestinationImage, type DestinationImageSource } from './DestinationImage';

export interface DestinationFeatureCardProps {
  name: string;
  /** Region / country line, shown above the name. */
  region: string;
  /** One or two sentences; becomes the link's accessible description. */
  description?: string;
  image?: DestinationImageSource;
  /** Fixed ratio. Omit to size the tile with `className` (e.g. a bento grid). */
  aspect?: DestinationAspect;
  /** Link element, e.g. <Link to="/discover/goa" />. */
  link?: ReactElement;
  /** Visible (decorative) call to action under the text, e.g. "Explore Goa". */
  cta?: string;
  headingLevel?: 'h2' | 'h3';
  /** Visual size of the name. */
  titleSize?: 'md' | 'lg';
  /** Wrap the image layer, e.g. in a `<Parallax>` from `@wayora/ui/motion`. */
  renderMedia?: (media: ReactNode) => ReactNode;
  priority?: boolean;
  sizes?: string;
  className?: string;
}

/**
 * Editorial destination tile: full-bleed image, legibility scrim and the text
 * on top. The name is the only link and its hit area covers the tile; the
 * focus ring is drawn around the whole tile. No price or rating slots — this
 * is for inspiration content, not inventory.
 */
export function DestinationFeatureCard({
  name,
  region,
  description,
  image,
  aspect,
  link,
  cta,
  headingLevel: Heading = 'h3',
  titleSize = 'md',
  renderMedia,
  priority,
  sizes,
  className,
}: DestinationFeatureCardProps) {
  const generatedId = useId();
  const descriptionId = description ? `${generatedId}-description` : undefined;
  const { title } = linkedTitle(name, link, 'rounded-xs focus-ring-inverse', descriptionId);
  const media = (
    <DestinationImage
      name={name}
      aspect="fill"
      image={image && sizes ? { ...image, sizes } : image}
      priority={priority}
    />
  );
  return (
    <article
      className={cn(
        'group relative isolate overflow-hidden rounded-2xl bg-deep text-ink-inverse',
        aspect && destinationAspectClass[aspect],
        className,
      )}
    >
      {renderMedia ? renderMedia(media) : media}
      <div
        aria-hidden="true"
        className="absolute inset-0 bg-linear-to-t from-deep/95 from-15% via-deep/80 via-50% to-deep/5 to-90%"
      />
      <div className="relative flex h-full flex-col justify-end gap-2 p-6 sm:p-8">
        <p className="text-label text-ink-inverse">{region}</p>
        <Heading className={titleSize === 'lg' ? 'text-heading-1' : 'text-heading-2'}>
          {title}
        </Heading>
        {description ? (
          <p id={descriptionId} className="max-w-md text-body text-ink-inverse-secondary">
            {description}
          </p>
        ) : null}
        {cta ? (
          <span
            aria-hidden="true"
            className="mt-2 inline-flex items-center gap-1.5 text-label text-ink-inverse"
          >
            {cta}
            <ArrowRight className={cn('size-4', interaction.iconNudge)} />
          </span>
        ) : null}
      </div>
      {/* Focus ring for the whole tile (the link's ::after covers the card). */}
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 rounded-2xl ring-white group-has-[:focus-visible]:ring-2 group-has-[:focus-visible]:ring-inset"
      />
    </article>
  );
}
