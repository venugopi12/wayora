import { describe, expect, it } from 'vitest';
import {
  DEMO_SEARCH_NOTICE,
  TRAVEL_CATEGORIES,
  addMoney,
  apiErrorEnvelopeSchema,
  apiSuccessEnvelopeSchema,
  destinationListSchema,
  destinationSchema,
  deriveReadinessStatus,
  heartbeatJobSchema,
  moneySchema,
  travelCategoryListSchema,
} from '../src/index.js';

describe('moneySchema', () => {
  it('accepts integer minor-unit strings', () => {
    expect(moneySchema.parse({ amountMinor: '149950', currency: 'INR' })).toEqual({
      amountMinor: '149950',
      currency: 'INR',
    });
  });

  it.each(['14.99', '1e5', '007', '', 'abc'])('rejects non-integer amount %j', (amountMinor) => {
    expect(moneySchema.safeParse({ amountMinor, currency: 'INR' }).success).toBe(false);
  });

  it('rejects lowercase or malformed currency codes', () => {
    expect(moneySchema.safeParse({ amountMinor: '100', currency: 'inr' }).success).toBe(false);
    expect(moneySchema.safeParse({ amountMinor: '100', currency: 'RUPEE' }).success).toBe(false);
  });

  it('adds exactly beyond Number.MAX_SAFE_INTEGER', () => {
    const big = { amountMinor: '9007199254740993', currency: 'INR' };
    expect(addMoney(big, { amountMinor: '2', currency: 'INR' }).amountMinor).toBe(
      '9007199254740995',
    );
  });

  it('refuses to add different currencies', () => {
    expect(() =>
      addMoney({ amountMinor: '1', currency: 'INR' }, { amountMinor: '1', currency: 'USD' }),
    ).toThrow(/Cannot add INR to USD/);
  });
});

describe('API envelopes', () => {
  it('validates a success envelope with typed data', () => {
    const schema = apiSuccessEnvelopeSchema(travelCategoryListSchema);
    const parsed = schema.parse({ data: TRAVEL_CATEGORIES, meta: { requestId: 'req-1' } });
    expect(parsed.data).toHaveLength(7);
  });

  it('rejects an error envelope with an unknown code', () => {
    const result = apiErrorEnvelopeSchema.safeParse({
      error: { code: 'TEAPOT', message: 'x', requestId: 'r' },
    });
    expect(result.success).toBe(false);
  });
});

describe('catalog', () => {
  it('lists the seven categories with unique slugs, all in demo-search beta', () => {
    const slugs = TRAVEL_CATEGORIES.map((c) => c.slug);
    expect(new Set(slugs).size).toBe(7);
    expect(TRAVEL_CATEGORIES.every((c) => c.availability === 'beta')).toBe(true);
    expect(DEMO_SEARCH_NOTICE).toMatch(/demo search/i);
    expect(DEMO_SEARCH_NOTICE).toMatch(/nothing can be booked/i);
  });

  it('describes only what exists today: sample search, never booking features', () => {
    for (const category of TRAVEL_CATEGORIES) {
      expect(category.description, category.slug).toMatch(/\bsample\b/);
      expect(category.description, category.slug).not.toMatch(
        /\b(book|booking|ticket|e-ticket|confirm|confirmation|PNR|real-time|live|instant|availability|seat selection|inventory)/i,
      );
    }
  });
});

describe('deriveReadinessStatus', () => {
  const db = { name: 'postgres', essential: true } as const;
  const redis = { name: 'redis', essential: false } as const;

  it('is ready when everything is up', () => {
    expect(
      deriveReadinessStatus([
        { ...db, state: 'up' },
        { ...redis, state: 'up' },
      ]),
    ).toBe('ready');
  });

  it('is degraded when only an optional dependency is down', () => {
    expect(
      deriveReadinessStatus([
        { ...db, state: 'up' },
        { ...redis, state: 'down' },
      ]),
    ).toBe('degraded');
  });

  it('treats a disabled optional dependency as ready', () => {
    expect(
      deriveReadinessStatus([
        { ...db, state: 'up' },
        { ...redis, state: 'disabled' },
      ]),
    ).toBe('ready');
  });

  it('is unready when an essential dependency is down', () => {
    expect(
      deriveReadinessStatus([
        { ...db, state: 'down' },
        { ...redis, state: 'up' },
      ]),
    ).toBe('unready');
  });
});

describe('heartbeatJobSchema', () => {
  it('rejects unexpected keys so sensitive data cannot ride along', () => {
    const result = heartbeatJobSchema.safeParse({
      requestedAt: new Date().toISOString(),
      source: 'cli',
      email: 'someone@example.com',
    });
    expect(result.success).toBe(false);
  });
});

describe('destinationSchema', () => {
  const base = {
    id: 'goa',
    slug: 'goa',
    name: 'Goa',
    country: 'India',
    region: 'india',
    description: 'Beaches and villages.',
    intro: 'A coastal state.',
    highlights: [{ title: 'Coast', text: 'Long beaches.' }],
    categories: ['beach-escapes'],
    featured: false,
  };

  it('accepts editorial content and defaults aliases', () => {
    const parsed = destinationSchema.parse(base);
    expect(parsed.aliases).toEqual([]);
    expect(parsed.image).toBeUndefined();
  });

  it('rejects unknown regions, moods and malformed slugs', () => {
    expect(destinationSchema.safeParse({ ...base, region: 'mars' }).success).toBe(false);
    expect(destinationSchema.safeParse({ ...base, categories: ['nightlife'] }).success).toBe(false);
    expect(destinationSchema.safeParse({ ...base, categories: [] }).success).toBe(false);
    expect(destinationSchema.safeParse({ ...base, slug: 'Goa Beach' }).success).toBe(false);
  });

  it('requires alt text, and a credit for photos', () => {
    const image = { src: '/goa.avif', alt: 'Boats at sunset', kind: 'photo' as const };
    expect(destinationSchema.safeParse({ ...base, image }).success).toBe(false);
    expect(
      destinationSchema.safeParse({ ...base, image: { ...image, credit: 'Own photo, CC BY 4.0' } })
        .success,
    ).toBe(true);
    expect(
      destinationSchema.safeParse({ ...base, image: { ...image, alt: '', kind: 'artwork' } })
        .success,
    ).toBe(false);
  });

  it('has no price, rating or availability fields to fill', () => {
    const parsed = destinationSchema.parse({ ...base, priceFrom: 100, rating: 5 });
    expect(parsed).not.toHaveProperty('priceFrom');
    expect(parsed).not.toHaveProperty('rating');
  });

  it('rejects duplicate slugs in a list', () => {
    expect(destinationListSchema.safeParse([base, { ...base, id: 'goa-2' }]).success).toBe(false);
  });
});
