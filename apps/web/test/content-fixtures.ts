import type { PublicContent } from '@wayora/contracts';

/** A published guide as the API returns it (fixture for tests only). */
export function guide(over: Partial<PublicContent> = {}): PublicContent {
  return {
    type: 'guide',
    slug: 'goa-monsoon-guide',
    path: '/guides/goa-monsoon-guide',
    title: 'Goa in the monsoon',
    seoTitle: null,
    metaDescription:
      'How to plan a quieter monsoon trip to Goa: what changes, what stays open and how to get around.',
    summary: 'What changes in Goa between June and September, and how to plan around it.',
    body: [
      { type: 'heading', level: 2, text: 'What changes' },
      { type: 'paragraph', text: 'Many beach shacks close for the season.' },
      {
        type: 'list',
        style: 'bullet',
        items: ['Pack a light rain jacket', 'Check ferry timings locally'],
      },
      { type: 'tip', text: 'Plan indoor mornings and drive in the afternoon lulls.' },
      { type: 'provider', text: 'Sea-sport operators set their own monsoon closures.' },
      {
        type: 'image',
        media: 'destination-goa',
        alt: 'Photograph of the Goa coastline',
        caption: null,
      },
    ],
    cover: {
      src: '/media/photos/destination-goa.webp',
      alt: 'Photograph of the Goa coastline',
      width: 1200,
      height: 900,
      og: '/media/og/destination-goa.jpg',
    },
    destinations: ['goa'],
    related: [],
    author: 'Asha R.',
    publishedAt: '2026-11-01T09:00:00.000+00:00',
    updatedAt: '2026-11-03T09:00:00.000+00:00',
    wordCount: 320,
    readingMinutes: 2,
    ...over,
  };
}
