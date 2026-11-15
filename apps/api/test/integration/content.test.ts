import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  adminContentListSchema,
  adminContentSchema,
  contentFeedSchema,
  contentStatsSchema,
  popularDestinationsSchema,
  publicContentListSchema,
  publicContentSchema,
  type AdminContent,
  type ContentInput,
} from '@wayora/contracts';
import type { Env } from '../../src/config/env.js';
import { setUserRole } from '../../src/modules/admin/roles.js';
import { buildTestApp } from '../helpers.js';
import {
  ORIGIN,
  TEST_DATABASE_URL,
  disconnect,
  resetAccounts,
  testClock,
  testPrisma,
} from './db.js';

/*
 * Content and first-party counts against a real PostgreSQL (Phase 29,
 * docs/seo.md): CMS RBAC, slugs, drafts vs published visibility, publish
 * validation, revisions and audit, archive/restore, the build feed, the
 * cookieless counters, popular destinations and the database guards.
 */

const PASSWORD = 'blue river morning';
const NAMES = ['Anand', 'Bela', 'Chitra', 'Dev', 'Esha', 'Farah', 'Gopal', 'Hari'];
type Agent = ReturnType<typeof request.agent>;

if (process.env.CI && !TEST_DATABASE_URL) {
  throw new Error('CI is set but TEST_DATABASE_URL is not: the content tests would be skipped.');
}

const app = (env: Partial<Env> = {}, clock = testClock()) =>
  buildTestApp({
    prisma: testPrisma(),
    env: {
      SESSION_IDLE_TIMEOUT_HOURS: 24 * 900,
      SESSION_ABSOLUTE_TIMEOUT_HOURS: 24 * 1000,
      ...env,
    },
    now: clock.now,
  });

let counter = 0;
async function register(target: Parameters<typeof request.agent>[0], name = 'Asha Rao') {
  const email = `c${(counter += 1)}-${randomUUID().slice(0, 6)}@example.com`;
  const agent = request.agent(target);
  const res = await agent
    .post('/api/v1/auth/register')
    .set('Origin', ORIGIN)
    .send({ name, email, password: PASSWORD });
  expect(res.status).toBe(201);
  return {
    agent,
    email,
    userId: (await testPrisma().user.findUniqueOrThrow({ where: { email } })).id,
  };
}
async function staff(
  target: Parameters<typeof request.agent>[0],
  role: 'admin' | 'support',
  name: string,
) {
  const s = await register(target, name);
  await setUserRole(testPrisma(), { email: s.email, role, reason: 'Test setup', actor: 'test' });
  return s;
}

/** Deterministic prose: n words. */
const words = (n: number, seed = 'Goa') =>
  Array.from({ length: n }, (_, i) =>
    i % 12 === 0
      ? seed
      : [
          'beaches',
          'villages',
          'markets',
          'churches',
          'rivers',
          'evenings',
          'spices',
          'boats',
          'forts',
          'cafes',
          'paths',
        ][i % 11],
  ).join(' ');

const guide = (over: Partial<ContentInput> = {}): ContentInput => ({
  type: 'guide',
  slug: 'goa-for-first-timers',
  title: 'Goa for first-timers',
  summary:
    'A first visit to Goa: where the beaches, villages and old churches are, and how the coast is laid out.',
  body: [
    { type: 'heading', level: 2, text: 'Getting oriented' },
    { type: 'paragraph', text: words(200) },
    { type: 'heading', level: 3, text: 'North and south' },
    { type: 'paragraph', text: words(150, 'Panaji') },
    { type: 'tip', text: 'Check local advice before swimming.' },
  ],
  cover: { media: 'destination-goa', alt: 'Illustration of fishing boats on a sunset sea' },
  seoTitle: 'Goa for first-timers: a guide',
  metaDescription:
    'Planning a first trip to Goa? How the coast is laid out, from northern beaches to old churches.',
  destinations: ['goa'],
  related: [],
  ...over,
});

const create = (agent: Agent, body: ContentInput) =>
  agent.post('/api/v1/admin/content').set('Origin', ORIGIN).send(body);
const setStatus = (agent: Agent, id: string, action: string, revision: number) =>
  agent.post(`/api/v1/admin/content/${id}/status`).set('Origin', ORIGIN).send({ action, revision });
const patch = (agent: Agent, entry: AdminContent, over: Partial<ContentInput> = {}) => {
  const { type: _t, ...fields } = entry.fields;
  return agent
    .patch(`/api/v1/admin/content/${entry.id}`)
    .set('Origin', ORIGIN)
    .send({ ...fields, revision: entry.revision, ...over });
};
async function published(agent: Agent, body: ContentInput) {
  const created = adminContentSchema.parse((await create(agent, body)).body.data);
  const res = await setStatus(agent, created.id, 'publish', created.revision);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return adminContentSchema.parse(res.body.data);
}
const event = (agent: Agent | ReturnType<typeof request>, body: Record<string, unknown>) =>
  (agent as Agent).post('/api/v1/analytics/events').set('Origin', ORIGIN).send(body);

beforeEach(async () => {
  if (!TEST_DATABASE_URL) return;
  await resetAccounts();
  // Counts have no owner, so the account reset doesn't clear them.
  await testPrisma().contentDailyCount.deleteMany();
});
afterAll(async () => {
  await disconnect();
});

describe.skipIf(!TEST_DATABASE_URL)('content and counts (PostgreSQL)', () => {
  describe('CMS permissions', () => {
    it('customers get nothing, support staff read, administrators write and publish', async () => {
      const target = app();
      const customer = await register(target);
      const support = await staff(target, 'support', 'Ravi Support');
      const admin = await staff(target, 'admin', 'Meera Admin');

      for (const [method, path] of [
        ['get', '/api/v1/admin/content'],
        ['post', '/api/v1/admin/content'],
      ] as const) {
        expect(
          (await customer.agent[method](path).set('Origin', ORIGIN).send(guide())).status,
          path,
        ).toBe(403);
      }
      expect((await create(support.agent, guide())).status).toBe(403);
      const created = await create(admin.agent, guide());
      expect(created.status).toBe(201);
      const entry = adminContentSchema.parse(created.body.data);
      expect(entry).toMatchObject({
        status: 'draft',
        revision: 1,
        author: 'Meera Admin',
        editor: 'Meera Admin',
        path: '/guides/goa-for-first-timers',
      });

      const seen = adminContentSchema.parse(
        (await support.agent.get(`/api/v1/admin/content/${entry.id}`)).body.data,
      );
      expect(seen.allowed).toEqual({ edit: false, publish: false });
      expect((await setStatus(support.agent, entry.id, 'publish', 1)).status).toBe(403);
      expect((await patch(support.agent, entry, { title: 'Changed by support' })).status).toBe(403);
      expect(
        await testPrisma().auditLog.count({
          where: { action: 'admin.access_denied', actorId: support.userId },
        }),
      ).toBeGreaterThan(0);
    });
  });

  describe('drafts, publishing and visibility', () => {
    it('drafts are invisible; publishing needs real content; published pages appear in the feed and lists', async () => {
      const target = app();
      const admin = await staff(target, 'admin', 'Meera Admin');
      const anon = request(target);
      const thin = adminContentSchema.parse(
        (
          await create(
            admin.agent,
            guide({ body: [{ type: 'paragraph', text: words(40) }], metaDescription: 'Too short' }),
          )
        ).body.data,
      );
      expect(thin.problems.map((p) => p.field).sort()).toEqual(['body', 'metaDescription']);
      expect((await anon.get('/api/v1/content/guides/goa-for-first-timers')).status).toBe(404);
      expect(
        contentFeedSchema.parse((await anon.get('/api/v1/content/feed')).body.data).items,
      ).toHaveLength(0);

      const refused = await setStatus(admin.agent, thin.id, 'publish', thin.revision);
      expect(refused.status).toBe(400);
      expect(refused.body.error.details.map((d: { path: string }) => d.path).sort()).toEqual([
        'body.body',
        'body.metaDescription',
      ]);
      expect((await anon.get('/api/v1/content/guides/goa-for-first-timers')).status).toBe(404);

      const fixed = adminContentSchema.parse(
        (
          await patch(admin.agent, thin, {
            body: guide().body,
            metaDescription: guide().metaDescription,
          })
        ).body.data,
      );
      expect(fixed.problems).toEqual([]);
      const pub = await setStatus(admin.agent, fixed.id, 'publish', fixed.revision);
      expect(pub.status).toBe(200);
      const live = publicContentSchema.parse(
        (await anon.get('/api/v1/content/guides/goa-for-first-timers')).body.data,
      );
      expect(live).toMatchObject({
        type: 'guide',
        path: '/guides/goa-for-first-timers',
        author: 'Meera A.',
        destinations: ['goa'],
        cover: {
          src: '/media/photos/destination-goa.webp',
          og: '/media/og/destination-goa.jpg',
          width: 1200,
          height: 900,
        },
      });
      // 350 body words + headings, tip and introduction; 200 words a minute, rounded up.
      expect(live.wordCount).toBeGreaterThan(350);
      expect(live.readingMinutes).toBe(Math.ceil(live.wordCount / 200));
      // Wrong section for its type: not found.
      expect((await anon.get('/api/v1/content/collections/goa-for-first-timers')).status).toBe(404);
      const feed = contentFeedSchema.parse((await anon.get('/api/v1/content/feed')).body.data);
      expect(feed.items.map((i) => i.slug)).toEqual(['goa-for-first-timers']);
      const forGoa = publicContentListSchema.parse(
        (await anon.get('/api/v1/content?destination=goa&type=guides')).body.data,
      );
      expect(forGoa.items.map((i) => i.slug)).toEqual(['goa-for-first-timers']);
      expect((await anon.get('/api/v1/content?destination=jaipur')).body.data.items).toHaveLength(
        0,
      );
      expect(
        (
          await testPrisma().auditLog.findMany({
            where: { entityId: fixed.id },
            orderBy: { createdAt: 'asc' },
          })
        ).map((a) => a.action),
      ).toEqual(['content.created', 'content.updated', 'content.published']);
    });

    it('validates slugs, links and blocks; slugs are unique and permanent once published', async () => {
      const target = app();
      const admin = await staff(target, 'admin', 'Meera Admin');
      for (const over of [
        { slug: 'Goa Guide' },
        { slug: 'ab' },
        { slug: 'goa--guide' },
        { body: [{ type: 'html', html: '<script>alert(1)</script>' }] },
        { body: [{ type: 'heading', level: 1, text: 'An h1 is the page title' }] },
        { cover: { media: 'https://example.com/photo.jpg', alt: 'An external image' } },
        { title: 'x' },
      ] as Partial<ContentInput>[]) {
        expect(
          (await create(admin.agent, guide(over))).status,
          JSON.stringify(over).slice(0, 60),
        ).toBe(400);
      }
      const unknown = await create(admin.agent, guide({ destinations: ['atlantis'] }));
      expect(unknown.status).toBe(400);
      expect(unknown.body.error.details[0].message).toMatch(/isn’t a Wayora destination/);
      // Text that looks like markup is stored as text (it is rendered as text, never HTML).
      const markup = adminContentSchema.parse(
        (
          await create(
            admin.agent,
            guide({
              slug: 'markup-as-text',
              body: [{ type: 'paragraph', text: '<b>Bold?</b> <script>x</script>' }],
            }),
          )
        ).body.data,
      );
      expect(markup.fields.body[0]).toEqual({
        type: 'paragraph',
        text: '<b>Bold?</b> <script>x</script>',
      });

      const first = await published(admin.agent, guide());
      const dup = await create(
        admin.agent,
        guide({ type: 'collection', title: 'Another Goa page' }),
      );
      expect(dup.status).toBe(409);
      expect(dup.body.error.message).toMatch(/already used/);
      const moved = await patch(admin.agent, first, { slug: 'goa-first-time' });
      expect(moved.status).toBe(409);
      expect(moved.body.error.message).toMatch(/can’t change/);
      // Edits to live content must keep it publishable.
      expect((await patch(admin.agent, first, { metaDescription: 'short' })).status).toBe(400);
      expect((await patch(admin.agent, first, { revision: 1 } as never)).status).toBe(409); // stale
      const edited = await patch(admin.agent, first, { title: 'Goa for first-time visitors' });
      expect(edited.status).toBe(200);
      const after = adminContentSchema.parse(edited.body.data);
      expect(after.revisions.map((r) => r.note)).toEqual([
        'Edited while published',
        'Published',
        'Created',
      ]);
    });

    it('archives (unless still linked), hides archived pages, and restores them as drafts', async () => {
      const target = app();
      const admin = await staff(target, 'admin', 'Meera Admin');
      const anon = request(target);
      const base = await published(admin.agent, guide());
      const linking = await published(
        admin.agent,
        guide({ slug: 'goa-beaches', title: 'Goa’s beaches', related: ['goa-for-first-timers'] }),
      );
      expect(
        publicContentSchema.parse((await anon.get('/api/v1/content/guides/goa-beaches')).body.data)
          .related,
      ).toEqual([
        {
          type: 'guide',
          slug: 'goa-for-first-timers',
          path: '/guides/goa-for-first-timers',
          title: 'Goa for first-timers',
          summary: guide().summary,
        },
      ]);
      const blocked = await setStatus(admin.agent, base.id, 'archive', base.revision);
      expect(blocked.status).toBe(400);
      expect(blocked.body.error.details[0].message).toMatch(/goa-beaches/);

      const archivedLinking = await setStatus(admin.agent, linking.id, 'archive', linking.revision);
      expect(archivedLinking.status).toBe(200);
      expect((await anon.get('/api/v1/content/guides/goa-beaches')).status).toBe(404);
      expect(
        contentFeedSchema
          .parse((await anon.get('/api/v1/content/feed')).body.data)
          .items.map((i) => i.slug),
      ).toEqual(['goa-for-first-timers']);
      const archived = adminContentSchema.parse(archivedLinking.body.data);
      expect((await setStatus(admin.agent, archived.id, 'publish', archived.revision)).status).toBe(
        409,
      );
      const restored = await setStatus(admin.agent, archived.id, 'restore', archived.revision);
      expect(adminContentSchema.parse(restored.body.data).status).toBe('draft');

      const list = adminContentListSchema.parse(
        (await admin.agent.get('/api/v1/admin/content?status=draft')).body.data,
      );
      expect(list.items.map((i) => i.slug)).toEqual(['goa-beaches']);
    });
  });

  describe('first-party counts', () => {
    it('counts real destinations and published pages only, as daily totals with no personal data', async () => {
      const target = app();
      const admin = await staff(target, 'admin', 'Meera Admin');
      await published(admin.agent, guide());
      const anon = request(target);
      const counted = async (body: Record<string, unknown>) =>
        (await event(anon, body)).body.data?.counted;
      expect(await counted({ event: 'destination_view', key: 'goa' })).toBe(true);
      expect(await counted({ event: 'destination_view', key: 'goa' })).toBe(true);
      expect(await counted({ event: 'destination_view', key: 'atlantis' })).toBe(false);
      expect(await counted({ event: 'content_view', key: 'goa-for-first-timers' })).toBe(true);
      expect(await counted({ event: 'content_view', key: 'not-published' })).toBe(false);
      expect(await counted({ event: 'destination_search_click', key: 'goa:hotels' })).toBe(true);
      expect(await counted({ event: 'destination_search_click', key: 'goa:rockets' })).toBe(false);
      expect(
        (await event(anon, { event: 'destination_view', key: 'goa', userId: 'x' })).status,
      ).toBe(400);
      expect((await event(anon, { event: 'page_view', key: 'goa' })).status).toBe(400);

      const rows = await testPrisma().contentDailyCount.findMany({
        orderBy: [{ event: 'asc' }, { key: 'asc' }],
      });
      expect(rows.map((r) => [r.event, r.key, r.count])).toEqual([
        ['content_view', 'goa-for-first-timers', 1],
        ['destination_search_click', 'goa:hotels', 1],
        ['destination_view', 'goa', 2],
      ]);
      // The table has no column that could hold a person, session or address.
      expect(Object.keys(rows[0]!).sort()).toEqual(['count', 'day', 'event', 'key']);

      const stats = contentStatsSchema.parse(
        (await admin.agent.get('/api/v1/admin/content/stats?days=30')).body.data,
      );
      expect(stats.topDestinations).toEqual([{ key: 'goa', count: 2 }]);
      expect(stats.searchClicks).toEqual([{ key: 'goa:hotels', count: 1 }]);
      const list = adminContentListSchema.parse(
        (await admin.agent.get('/api/v1/admin/content')).body.data,
      );
      expect(list.items[0]!.views30d).toBe(1);
    });

    it('rate-limits events per client', async () => {
      const target = app({ ANALYTICS_RATE_LIMIT_MAX: 2 });
      const anon = request(target);
      const statuses = [];
      for (let i = 0; i < 3; i += 1)
        statuses.push((await event(anon, { event: 'destination_view', key: 'goa' })).status);
      expect(statuses).toEqual([202, 202, 429]);
    });

    it('lists popular destinations only when at least three have 20 views in 30 days', async () => {
      const clock = testClock();
      const anon = request(app({}, clock));
      const popular = async () =>
        popularDestinationsSchema.parse((await anon.get('/api/v1/discover/popular')).body.data);
      const db = testPrisma();
      const today = new Date(`${clock.now().toISOString().slice(0, 10)}T00:00:00Z`);
      const old = new Date(today.getTime() - 40 * 86_400_000);
      await db.contentDailyCount.createMany({
        data: [
          { day: today, event: 'destination_view', key: 'goa', count: 30 },
          { day: today, event: 'destination_view', key: 'jaipur', count: 25 },
          { day: today, event: 'destination_view', key: 'kerala', count: 19 },
          // Outside the 30 days: not counted.
          { day: old, event: 'destination_view', key: 'kerala', count: 500 },
        ],
      });
      expect(await popular()).toEqual({
        basis: 'destination_page_views',
        days: 30,
        minimumViews: 20,
        items: [],
      });
      await db.contentDailyCount.update({
        where: { day_event_key: { day: today, event: 'destination_view', key: 'kerala' } },
        data: { count: 21 },
      });
      expect((await popular()).items).toEqual([
        { slug: 'goa' },
        { slug: 'jaipur' },
        { slug: 'kerala' },
      ]);
    });
  });

  describe('database guards', () => {
    it('keeps entries and revisions, and keeps a published slug', async () => {
      const target = app();
      const admin = await staff(target, 'admin', 'Meera Admin');
      const entry = await published(admin.agent, guide());
      const db = testPrisma();
      await expect(db.contentEntry.delete({ where: { id: entry.id } })).rejects.toThrow(
        /DELETE blocked/,
      );
      await expect(db.contentRevision.deleteMany({ where: { entryId: entry.id } })).rejects.toThrow(
        /append-only/,
      );
      await expect(
        db.contentEntry.update({
          where: { id: entry.id },
          data: { slug: 'renamed', revision: entry.revision + 1 },
        }),
      ).rejects.toThrow(/permanent/);
      await expect(
        db.contentEntry.update({ where: { id: entry.id }, data: { title: 'No new revision' } }),
      ).rejects.toThrow(/revision/);
      await expect(
        db.contentEntry.update({
          where: { id: entry.id },
          data: { type: 'TIP', revision: entry.revision + 1 },
        }),
      ).rejects.toThrow(/immutable/);
    });
  });

  it('names its sections: guides, articles and tips under /guides/', async () => {
    const target = app();
    const admin = await staff(target, 'admin', NAMES[0]!);
    const tip = await published(
      admin.agent,
      guide({
        type: 'tip',
        slug: 'carry-a-light-scarf',
        title: 'Carry a light scarf',
        body: [{ type: 'paragraph', text: words(90) }],
      }),
    );
    expect(tip.path).toBe('/guides/carry-a-light-scarf');
    const faq = await published(
      admin.agent,
      guide({
        type: 'faq',
        slug: 'goa-faq-monsoon',
        title: 'Is Goa open in the monsoon?',
        summary: '',
        body: [{ type: 'paragraph', text: words(30) }],
        metaDescription: null,
        cover: null,
      }),
    );
    expect(faq.path).toBeNull();
    const anon = request(target);
    // FAQs have no page, but appear in destination lists.
    expect((await anon.get('/api/v1/content/guides/goa-faq-monsoon')).status).toBe(404);
    expect(
      (await anon.get('/api/v1/content?type=faq&destination=goa')).body.data.items.map(
        (i: { slug: string }) => i.slug,
      ),
    ).toEqual(['goa-faq-monsoon']);
    // Lists carry the answer for FAQs (shown where they're listed), and no body for pages.
    const forGoa = publicContentListSchema.parse(
      (await anon.get('/api/v1/content?destination=goa')).body.data,
    );
    const bodies = Object.fromEntries(forGoa.items.map((i) => [i.slug, i.body]));
    expect(bodies['goa-faq-monsoon']).toEqual([{ type: 'paragraph', text: words(30) }]);
    expect(forGoa.items.filter((i) => i.type !== 'faq').every((i) => i.body === undefined)).toBe(
      true,
    );
  });
});
