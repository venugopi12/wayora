import { describe, expect, it } from 'vitest';
import {
  MEDIA_KEYS,
  PLANNER_CATALOG,
  analyticsEventSchema,
  contentInputSchema,
  contentPath,
  mediaAsset,
  publishProblems,
  readingMinutes,
  slugify,
  wordCount,
  type ContentFields,
} from '../src/index.js';

/* Content model rules (Phase 29, docs/seo.md#content-model). */

const fields = (over: Partial<ContentFields> = {}): ContentFields =>
  contentInputSchema.parse({
    type: 'guide',
    slug: 'goa-guide',
    title: 'A guide to Goa',
    summary: 'Where the beaches, villages and churches are, and how the coast is laid out.',
    body: [
      { type: 'heading', level: 2, text: 'Getting oriented' },
      { type: 'paragraph', text: Array.from({ length: 320 }, () => 'word').join(' ') },
    ],
    metaDescription:
      'Planning a first trip to Goa? How the coast is laid out, from beaches to churches.',
    ...over,
  });

describe('slugs and URLs', () => {
  it('makes readable slugs', () => {
    expect(slugify('Goa’s Best Beaches — 2026!')).toBe('goas-best-beaches-2026');
    expect(slugify('  Café & Crème in Kōchi  ')).toBe('cafe-creme-in-kochi');
    expect(slugify('***')).toBe('');
    expect(slugify('a'.repeat(100))).toHaveLength(80);
  });

  it('gives each type its canonical section; FAQs have no page', () => {
    expect(contentPath('guide', 'x-y')).toBe('/guides/x-y');
    expect(contentPath('article', 'x-y')).toBe('/guides/x-y');
    expect(contentPath('tip', 'x-y')).toBe('/guides/x-y');
    expect(contentPath('collection', 'x-y')).toBe('/collections/x-y');
    expect(contentPath('landing', 'x-y')).toBe('/explore/x-y');
    expect(contentPath('faq', 'x-y')).toBeNull();
  });

  it('refuses unsafe slugs and unknown fields', () => {
    for (const slug of ['Goa', 'goa_guide', '-goa', 'goa-', 'go', 'a--b', '../etc']) {
      expect(contentInputSchema.safeParse({ ...fields(), slug }).success, slug).toBe(false);
    }
    expect(contentInputSchema.safeParse({ ...fields(), status: 'published' }).success).toBe(false);
  });
});

describe('media', () => {
  it('only offers the destination photographs in the media library, each with a social card', () => {
    expect(MEDIA_KEYS).toHaveLength(12);
    expect(mediaAsset('destination-goa')).toEqual({
      key: 'destination-goa',
      src: '/media/photos/destination-goa.webp',
      width: 1200,
      height: 900,
      og: '/media/og/destination-goa.jpg',
    });
    expect(mediaAsset('https://example.com/a.jpg')).toBeNull();
    // Every destination in the shared catalogue has a photograph.
    for (const d of PLANNER_CATALOG) expect(mediaAsset(`destination-${d.id}`), d.id).not.toBeNull();
  });
});

describe('words and reading time', () => {
  it('counts visible words only', () => {
    expect(
      wordCount(
        [
          { type: 'heading', level: 2, text: 'Two words' },
          { type: 'list', style: 'bullet', items: ['one', 'two three'] },
          {
            type: 'image',
            media: 'destination-goa',
            alt: 'Alt text is not counted',
            caption: 'A caption',
          },
          { type: 'paragraph', text: '— – ... 42' },
        ],
        ['Intro here'],
      ),
    ).toBe(10);
    expect(readingMinutes(1)).toBe(1);
    expect(readingMinutes(200)).toBe(1);
    expect(readingMinutes(201)).toBe(2);
  });
});

describe('publish validation', () => {
  it('passes a complete guide', () => {
    expect(publishProblems(fields())).toEqual([]);
  });

  it('refuses thin pages, missing descriptions and introductions, and bad heading order', () => {
    const problems = publishProblems(
      fields({
        summary: 'Short',
        metaDescription: null,
        body: [
          { type: 'heading', level: 3, text: 'Starts at h3' },
          { type: 'paragraph', text: 'Only a few words here.' },
        ],
      }),
    );
    expect(problems.map((p) => p.field)).toEqual(['body', 'metaDescription', 'summary', 'body.0']);
  });

  it('applies type rules', () => {
    expect(
      publishProblems(fields({ type: 'collection', body: [], destinations: ['goa'] })).map(
        (p) => p.field,
      ),
    ).toEqual(['destinations']);
    expect(
      publishProblems(fields({ type: 'collection', body: [], destinations: ['goa', 'jaipur'] })),
    ).toEqual([]);
    expect(
      publishProblems(
        fields({
          type: 'faq',
          summary: '',
          metaDescription: null,
          body: [{ type: 'paragraph', text: Array.from({ length: 25 }, () => 'w').join(' ') }],
        }),
      ).map((p) => p.field),
    ).toEqual(['destinations']);
    expect(publishProblems(fields({ related: ['goa-guide'] })).map((p) => p.field)).toEqual([
      'related',
    ]);
  });
});

describe('analytics events', () => {
  it('accept an event name and a key, nothing else', () => {
    expect(analyticsEventSchema.safeParse({ event: 'destination_view', key: 'goa' }).success).toBe(
      true,
    );
    expect(
      analyticsEventSchema.safeParse({ event: 'destination_search_click', key: 'goa:hotels' })
        .success,
    ).toBe(true);
    expect(
      analyticsEventSchema.safeParse({ event: 'destination_view', key: 'goa', email: 'a@b.c' })
        .success,
    ).toBe(false);
    expect(
      analyticsEventSchema.safeParse({ event: 'destination_view', key: 'https://x' }).success,
    ).toBe(false);
  });
});
