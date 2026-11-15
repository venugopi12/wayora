/**
 * Homepage media manifest: the hero and the closing CTA. Mood and
 * destination images live with their content in features/discover/data.ts.
 *
 * All images are photographs from Unsplash (Unsplash License), downloaded
 * into apps/web/public/media/photos by `npm run photos`; nothing is loaded
 * from another site. Sources and photographers are in
 * apps/web/scripts/photos.manifest.json and docs/media-assets.md. To change
 * a photo, edit the manifest, run `npm run photos -- --force`, and update
 * `alt`, `focalPoint`, `tone` and `credit` here.
 */

export interface MediaAsset {
  /** Landscape / default file, served from apps/web/public. */
  src: string;
  /** Art-directed portrait crop for phones (< 768px). */
  portraitSrc?: string;
  /** Describes the scene. "" marks the image as decorative. */
  alt: string;
  /** object-position for responsive cropping, e.g. "62% 50%". */
  focalPoint?: string;
  /** Fallback colour shown while loading (matches the image's dominant tone). */
  tone: string;
  kind: 'artwork' | 'photo';
  /** Required for photos: source and licence. */
  credit?: string;
}

const PHOTOS = '/media/photos';

/** Hero layers, back to front: one photograph, moving slightly on scroll. */
export const HERO_LAYERS: readonly (MediaAsset & { depth: number })[] = [
  {
    src: `${PHOTOS}/hero-mountain-dawn.webp`,
    portraitSrc: `${PHOTOS}/hero-mountain-dawn-portrait.webp`,
    // Decorative: the headline carries the meaning.
    alt: '',
    focalPoint: '50% 60%',
    tone: '#3a4658',
    kind: 'photo',
    credit: 'Photo by Karthik B K on Unsplash',
    depth: 0.12,
  },
];

export const CTA_MEDIA: MediaAsset = {
  src: `${PHOTOS}/cta-night-peak.webp`,
  portraitSrc: `${PHOTOS}/cta-night-peak-portrait.webp`,
  alt: '',
  focalPoint: '50% 50%',
  tone: '#10162b',
  kind: 'photo',
  credit: 'Photo by Haseeb Jamil on Unsplash',
};
