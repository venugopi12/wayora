import type { ReactNode } from 'react';
import { BRAND_ROUTE_PATH } from '../brand/BrandMark';
import { MediaFrame, mediaAspects, type MediaAspect } from '../components/MediaFrame';
import { cn } from '../lib/cn';
import { effects } from '../motion/presets';

/** Image data for a destination, as stored in a content manifest or returned by an API. */
export interface DestinationImageSource {
  src: string;
  /** Describe the scene; use "" only if the image is purely decorative. */
  alt: string;
  srcSet?: string;
  sizes?: string;
  /** Portrait crop served below 768 px (art direction). */
  portraitSrc?: string;
  /** CSS object-position, e.g. "50% 30%", so the subject survives cropping. */
  focalPoint?: string;
  /** Dominant colour shown while loading or if the file is missing. */
  tone?: string;
}

export interface DestinationImageProps {
  /** Destination name: used for the branded placeholder when there is no image. */
  name: string;
  image?: DestinationImageSource;
  /** Fixed ratio (reserves space, no layout shift) or `fill` to cover a sized parent. */
  aspect?: MediaAspect;
  /** Slow zoom when the enclosing `group` is hovered. Default true. */
  zoomOnHover?: boolean;
  /** Above-the-fold: eager load with high fetch priority. */
  priority?: boolean;
  className?: string;
  /** Overlays above the image (scrims, labels). */
  children?: ReactNode;
}

/**
 * Travel image with the conventions every destination visual needs: stable
 * aspect ratio, focal-point cropping, a portrait crop for phones, lazy
 * loading, and a branded placeholder when no licensed image exists yet.
 */
export function DestinationImage({
  name,
  image,
  aspect = '16/10',
  zoomOnHover = true,
  priority,
  className,
  children,
}: DestinationImageProps) {
  if (!image) {
    return (
      <div
        className={cn(
          aspect !== 'fill' && 'relative',
          'overflow-hidden',
          mediaAspects[aspect],
          className,
        )}
      >
        <DestinationPlaceholder name={name} />
        {children}
      </div>
    );
  }
  return (
    <MediaFrame
      aspect={aspect}
      src={image.src}
      srcSet={image.srcSet}
      sizes={image.sizes ?? '(min-width: 1024px) 33vw, (min-width: 640px) 50vw, 100vw'}
      sources={
        image.portraitSrc ? [{ media: '(max-width: 767px)', srcSet: image.portraitSrc }] : undefined
      }
      alt={image.alt}
      focalPoint={image.focalPoint}
      fallbackColor={image.tone}
      priority={priority}
      className={className}
      imgClassName={zoomOnHover ? effects.hoverZoom : undefined}
    >
      {children}
    </MediaFrame>
  );
}

/** Branded stand-in used until licensed photography is available. */
function DestinationPlaceholder({ name }: { name: string }) {
  return (
    <div
      className="absolute inset-0 flex items-end bg-linear-to-br from-brand-100 via-brand-50 to-sunken p-5"
      aria-hidden="true"
    >
      <svg
        viewBox="0 0 32 32"
        className="absolute -top-6 -right-6 size-44 text-brand-200"
        fill="none"
      >
        <path d={BRAND_ROUTE_PATH} stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
        <circle cx="8" cy="10.5" r="1.4" fill="currentColor" />
        <circle cx="16" cy="10.5" r="1.1" stroke="currentColor" strokeWidth="0.8" />
        <circle cx="24" cy="10.5" r="1.4" fill="currentColor" />
      </svg>
      <span className="relative text-heading-2 text-brand-300">{name.slice(0, 1)}</span>
    </div>
  );
}
