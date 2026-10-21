import { forwardRef, useState, type CSSProperties, type ReactNode } from 'react';
import { cn } from '../lib/cn';

export type MediaAspect = '16/9' | '16/10' | '21/9' | '4/3' | '4/5' | '3/4' | '1/1' | 'fill';

/** Aspect-ratio classes, shared with other media components. */
export const mediaAspects: Record<MediaAspect, string> = {
  '16/9': 'aspect-video',
  '16/10': 'aspect-[16/10]',
  '21/9': 'aspect-[21/9]',
  '4/3': 'aspect-[4/3]',
  '4/5': 'aspect-[4/5]',
  '3/4': 'aspect-[3/4]',
  '1/1': 'aspect-square',
  /** Fill the parent (parent must define the size). */
  fill: 'absolute inset-0',
};

export interface MediaSource {
  /** Media query, e.g. "(max-width: 767px)". */
  media: string;
  srcSet: string;
  type?: string;
}

export interface MediaFrameProps {
  src: string;
  /**
   * Describe the scene for informative images. Use "" for decorative images
   * (the heading or caption next to it already carries the meaning).
   */
  alt: string;
  /** Art-directed alternatives, e.g. a portrait crop for phones. */
  sources?: MediaSource[];
  srcSet?: string;
  sizes?: string;
  /** Reserves space before the image loads, preventing layout shift. */
  aspect?: MediaAspect;
  /** CSS object-position, e.g. "60% 40%". Keeps the subject in frame when cropped. */
  focalPoint?: string;
  /**
   * Above-the-fold hero media: loads eagerly with high fetch priority.
   * Everything else lazy-loads.
   */
  priority?: boolean;
  /** Intrinsic size hints for the browser (improves CLS when aspect is 'fill'). */
  width?: number;
  height?: number;
  /** Shown while loading and if the file is missing. Defaults to brand-soft. */
  fallbackColor?: string;
  className?: string;
  imgClassName?: string;
  imgStyle?: CSSProperties;
  /** Overlays rendered above the image (scrims, captions). */
  children?: ReactNode;
}

/**
 * Responsive image container: fixed aspect ratio, object-cover cropping with
 * a focal point, lazy loading by default and an on-brand fallback colour.
 * Swapping artwork for licensed photography is a `src` change only.
 */
export const MediaFrame = forwardRef<HTMLDivElement, MediaFrameProps>(function MediaFrame(
  {
    src,
    alt,
    sources,
    srcSet,
    sizes,
    aspect = '16/9',
    focalPoint,
    priority = false,
    width,
    height,
    fallbackColor,
    className,
    imgClassName,
    imgStyle,
    children,
  },
  ref,
) {
  // A missing or broken file never shows the browser's broken-image icon:
  // the frame keeps its size and fallback colour instead.
  const [failed, setFailed] = useState<string | null>(null);
  const broken = failed === src;
  const img = (
    <img
      src={src}
      srcSet={srcSet}
      sizes={sizes}
      alt={alt}
      width={width}
      height={height}
      loading={priority ? 'eager' : 'lazy'}
      decoding={priority ? 'sync' : 'async'}
      fetchPriority={priority ? 'high' : undefined}
      draggable={false}
      onError={() => setFailed(src)}
      data-failed={broken || undefined}
      style={{ objectPosition: focalPoint, ...imgStyle }}
      className={cn(
        'absolute inset-0 size-full object-cover select-none',
        broken && 'invisible',
        imgClassName,
      )}
    />
  );
  return (
    <div
      ref={ref}
      className={cn(
        aspect !== 'fill' && 'relative',
        'overflow-hidden',
        mediaAspects[aspect],
        className,
      )}
      style={{ backgroundColor: fallbackColor ?? 'var(--color-brand-soft)' }}
    >
      {sources?.length ? (
        <picture>
          {sources.map((s) => (
            <source key={s.media} media={s.media} srcSet={s.srcSet} type={s.type} />
          ))}
          {img}
        </picture>
      ) : (
        img
      )}
      {children}
    </div>
  );
});
