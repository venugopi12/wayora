#!/usr/bin/env node
/**
 * Downloads Wayora's photographs (docs/media-assets.md).
 *
 *   npm run photos            # download anything missing
 *   npm run photos -- --force # download everything again
 *
 * The photos are listed in photos.manifest.json: each is a free photo on
 * Unsplash (Unsplash License: free to use, commercially too, no permission
 * needed), with its page, photographer and where it was taken. Unsplash's
 * image server crops, resizes and converts each one, so this script needs no
 * image tools: it only fetches the sizes the app uses and writes them to
 * apps/web/public/media/photos/ (WebP) and apps/web/public/media/og/
 * (JPEG social cards). The files are committed; the app never loads images
 * from another site.
 *
 * Needs Node 22 and internet access to images.unsplash.com.
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(here, '../public');
const { photos } = JSON.parse(readFileSync(join(here, 'photos.manifest.json'), 'utf8'));
const force = process.argv.includes('--force');

/**
 * [suffix, folder, width, height, format, quality] for each kind of slot.
 * Sizes and quality were chosen by measuring the files: about 80–250 kB each
 * (the hero, a soft dawn scene, is about 60 kB), 4.6 MB in total.
 */
const CARD = ['', 'og', 1200, 630, 'jpg', 60];
const SIZES = {
  hero: [
    ['', 'photos', 2400, 1500, 'webp', 70],
    ['-portrait', 'photos', 1200, 2000, 'webp', 70],
  ],
  cta: [
    ['', 'photos', 2000, 1000, 'webp', 45],
    ['-portrait', 'photos', 1000, 1334, 'webp', 45],
  ],
  destination: [['', 'photos', 1200, 900, 'webp', 45], CARD],
  mood: [['', 'photos', 840, 1120, 'webp', 45]],
};
/** Slots whose shape differs from their kind's default. */
const OVERRIDES = {
  // Shown as a wide panorama on the home page.
  'destination-manali': [['', 'photos', 2000, 834, 'webp', 45], CARD],
};
/** The site's default social card is the hero photograph. */
const EXTRA = [['hero-mountain-dawn', 'og', 'default', 1200, 630, 'jpg', 80]];

const jobs = [];
for (const [slot, photo] of Object.entries(photos)) {
  const kind = slot.split('-')[0];
  for (const [suffix, folder, w, h, fm, q] of OVERRIDES[slot] ?? SIZES[kind] ?? []) {
    jobs.push({
      slot,
      photo,
      file: join(PUBLIC, 'media', folder, `${slot}${suffix}.${fm}`),
      w,
      h,
      fm,
      q,
    });
  }
}
for (const [slot, folder, name, w, h, fm, q] of EXTRA) {
  jobs.push({
    slot,
    photo: photos[slot],
    file: join(PUBLIC, 'media', folder, `${name}.${fm}`),
    w,
    h,
    fm,
    q,
  });
}

const urlOf = (job) => `${job.photo.raw}?w=${job.w}&h=${job.h}&fit=crop&fm=${job.fm}&q=${job.q}`;
if (process.argv.includes('--list')) {
  for (const job of jobs) console.log(`${job.file.slice(PUBLIC.length + 1)}\t${urlOf(job)}`);
  process.exit(0);
}

const MIME = { webp: 'image/webp', jpg: 'image/jpeg' };
let failed = 0;
let written = 0;
for (const job of jobs) {
  const label = job.file.slice(PUBLIC.length + 1);
  if (!force && existsSync(job.file) && statSync(job.file).size > 10_000) {
    console.log(`skip    ${label} (already there)`);
    continue;
  }
  const url = urlOf(job);
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    const type = res.headers.get('content-type') ?? '';
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (!type.startsWith(MIME[job.fm])) throw new Error(`expected ${MIME[job.fm]}, got ${type}`);
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length < 10_000) throw new Error(`only ${bytes.length} bytes`);
    mkdirSync(dirname(job.file), { recursive: true });
    writeFileSync(job.file, bytes);
    written += 1;
    console.log(`saved   ${label} (${Math.round(bytes.length / 1024)} kB, ${job.w}×${job.h})`);
  } catch (error) {
    failed += 1;
    console.error(`FAILED  ${label}: ${error.message}\n        ${job.photo.page}`);
  }
}

console.log(
  `\n${written} saved, ${jobs.length - written - failed} already there, ${failed} failed.`,
);
if (failed > 0) {
  console.error(
    'Some photos could not be downloaded. Check your internet connection and run it again.',
  );
  process.exit(1);
}
