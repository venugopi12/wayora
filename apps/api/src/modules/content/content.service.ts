import {
  contentBlockSchema,
  contentPath,
  hasPermission,
  mediaAsset,
  publishProblems,
  readingMinutes,
  travelCategorySlugSchema,
  wordCount,
  type AdminContent,
  type AdminContentList,
  type AnalyticsEvent,
  type ContentFeed,
  type ContentFields,
  type ContentLink,
  type ContentStats,
  type ContentStatus,
  type ContentType,
  type PopularDestinations,
  type PublicContent,
  type PublicContentList,
  type PublishProblem,
  type UserRole,
} from '@wayora/contracts';
import type {
  adminContentListQuerySchema,
  contentInputSchema,
  contentStatusChangeSchema,
  contentUpdateSchema,
  publicContentListQuerySchema,
} from '@wayora/contracts';
import type { z } from 'zod';
import {
  Prisma,
  type ContentStatus as DbStatus,
  type ContentType as DbType,
  type PrismaClient,
} from '@wayora/database';
import { AppError } from '../../utils/errors.js';
import { catalogDestination } from '../planner/catalog.js';

/*
 * Editorial content and first-party page-view counts (Phase 29,
 * docs/seo.md). Staff write drafts, publish, archive and restore them; the
 * public sees published entries only. Every save is a revision; publishing
 * actions are audited. Counts are daily totals with no personal data.
 */

type Tx = Prisma.TransactionClient;
type CreateInput = z.output<typeof contentInputSchema>;
type UpdateInput = z.output<typeof contentUpdateSchema>;
type StatusInput = z.output<typeof contentStatusChangeSchema>;
type AdminListQuery = z.output<typeof adminContentListQuerySchema>;
type PublicListQuery = z.output<typeof publicContentListQuerySchema>;

export interface Staff {
  id: string;
  role: UserRole;
}
export interface RequestContext {
  requestId?: string | undefined;
}

const NOT_FOUND = 'We couldn’t find that page.';
const STALE = 'This entry changed since you opened it. Reload it and try again.';
/** Popular destinations need at least this many views each, over POPULAR_DAYS. */
export const POPULAR_MIN_VIEWS = 20;
export const POPULAR_DAYS = 30;
/** …and at least this many destinations qualifying, or the section stays hidden. */
export const POPULAR_MIN_ITEMS = 3;

const toDbType = (t: ContentType) => t.toUpperCase() as DbType;
const fromDbType = (t: DbType) => t.toLowerCase() as ContentType;
const fromDbStatus = (s: DbStatus) => s.toLowerCase() as ContentStatus;
const GUIDE_TYPES: DbType[] = ['GUIDE', 'ARTICLE', 'TIP'];
const isUnique = (e: unknown) =>
  e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';

/** "Asha Rao" → "Asha R."; staff without a name are "Wayora team". */
export function bylineOf(displayName: string | null): string {
  const parts = (displayName ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return 'Wayora team';
  return parts.length > 1
    ? `${parts[0]} ${parts[parts.length - 1]!.charAt(0).toUpperCase()}.`
    : parts[0]!;
}

const entryInclude = {
  author: { select: { displayName: true } },
  editor: { select: { displayName: true } },
} satisfies Prisma.ContentEntryInclude;
type EntryRow = Prisma.ContentEntryGetPayload<{ include: typeof entryInclude }>;

function fieldsOf(row: EntryRow): ContentFields {
  const body = contentBlockSchema.array().safeParse(row.body);
  return {
    type: fromDbType(row.type),
    slug: row.slug,
    title: row.title,
    summary: row.summary,
    body: body.success ? body.data : [],
    cover: row.coverMedia && row.coverAlt ? { media: row.coverMedia, alt: row.coverAlt } : null,
    seoTitle: row.seoTitle,
    metaDescription: row.metaDescription,
    destinations: row.destinations,
    related: row.related,
  };
}

const dayOf = (d: Date) => new Date(`${d.toISOString().slice(0, 10)}T00:00:00Z`);

export class ContentService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly now: () => Date = () => new Date(),
  ) {}

  // ─── Presentation ──────────────────────────────────────────────────────

  private async relatedLinks(
    slugs: string[],
    db: Tx | PrismaClient = this.prisma,
  ): Promise<ContentLink[]> {
    if (slugs.length === 0) return [];
    const rows = await db.contentEntry.findMany({
      where: { slug: { in: slugs }, status: 'PUBLISHED' },
      select: { type: true, slug: true, title: true, summary: true },
    });
    const bySlug = new Map(rows.map((r) => [r.slug, r]));
    return slugs.flatMap((s) => {
      const r = bySlug.get(s);
      if (!r) return [];
      const type = fromDbType(r.type);
      return [
        { type, slug: r.slug, path: contentPath(type, r.slug), title: r.title, summary: r.summary },
      ];
    });
  }

  private present(
    row: EntryRow,
    f: ContentFields,
    related: ContentLink[],
    at: Date,
  ): PublicContent {
    const words = wordCount(f.body, [f.summary]);
    const cover = f.cover ? mediaAsset(f.cover.media) : null;
    return {
      type: f.type,
      slug: f.slug,
      path: contentPath(f.type, f.slug),
      title: f.title,
      seoTitle: f.seoTitle,
      metaDescription: f.metaDescription,
      summary: f.summary,
      body: f.body,
      cover:
        cover && f.cover
          ? {
              src: cover.src,
              alt: f.cover.alt,
              width: cover.width,
              height: cover.height,
              og: cover.og,
            }
          : null,
      destinations: f.destinations,
      related,
      author: bylineOf(row.author.displayName),
      publishedAt: (row.firstPublishedAt ?? at).toISOString(),
      updatedAt: (row.publishedAt ?? at).toISOString(),
      wordCount: words,
      readingMinutes: ['guide', 'article', 'tip'].includes(f.type) ? readingMinutes(words) : null,
    };
  }

  private async presentPublished(row: EntryRow): Promise<PublicContent> {
    const f = fieldsOf(row);
    return this.present(row, f, await this.relatedLinks(f.related), this.now());
  }

  // ─── Public ────────────────────────────────────────────────────────────

  /** A published entry; the URL section must match its type (/guides/ for guides, articles, tips). */
  async published(
    section: 'guides' | 'collections' | 'explore',
    slug: string,
  ): Promise<PublicContent> {
    const types: DbType[] =
      section === 'guides' ? GUIDE_TYPES : section === 'collections' ? ['COLLECTION'] : ['LANDING'];
    const row = await this.prisma.contentEntry.findFirst({
      where: { slug, status: 'PUBLISHED', type: { in: types } },
      include: entryInclude,
    });
    if (!row) throw new AppError('NOT_FOUND', NOT_FOUND);
    return this.presentPublished(row);
  }

  async listPublished(q: PublicListQuery): Promise<PublicContentList> {
    const where: Prisma.ContentEntryWhereInput = {
      status: 'PUBLISHED',
      ...(q.type === 'guides'
        ? { type: { in: GUIDE_TYPES } }
        : q.type
          ? { type: toDbType(q.type) }
          : {}),
      ...(q.destination ? { destinations: { has: q.destination } } : {}),
    };
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.contentEntry.count({ where }),
      this.prisma.contentEntry.findMany({
        where,
        include: entryInclude,
        orderBy: [{ firstPublishedAt: 'desc' }, { id: 'desc' }],
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
    ]);
    const items = await Promise.all(rows.map((r) => this.presentPublished(r)));
    return {
      items: items.map(({ body, ...rest }) => (rest.type === 'faq' ? { ...rest, body } : rest)),
      pagination: {
        page: q.page,
        pageSize: q.pageSize,
        totalResults: total,
        totalPages: Math.ceil(total / q.pageSize),
      },
    };
  }

  /** Every published entry with its body: what the web build prerenders and lists in the sitemap. */
  async feed(): Promise<ContentFeed> {
    const rows = await this.prisma.contentEntry.findMany({
      where: { status: 'PUBLISHED' },
      include: entryInclude,
      orderBy: [{ slug: 'asc' }],
      take: 10_000,
    });
    const published = new Map(rows.map((r) => [r.slug, r]));
    const items = rows.map((r) => {
      const f = fieldsOf(r);
      const related = f.related.flatMap((s) => {
        const x = published.get(s);
        if (!x) return [];
        const type = fromDbType(x.type);
        return [
          {
            type,
            slug: x.slug,
            path: contentPath(type, x.slug),
            title: x.title,
            summary: x.summary,
          },
        ];
      });
      return this.present(r, f, related, this.now());
    });
    return { items, generatedAt: this.now().toISOString() };
  }

  // ─── Admin ─────────────────────────────────────────────────────────────

  private async views30d(slugs: string[]): Promise<Map<string, number>> {
    if (slugs.length === 0) return new Map();
    const since = dayOf(new Date(this.now().getTime() - 29 * 86_400_000));
    const rows = await this.prisma.contentDailyCount.groupBy({
      by: ['key'],
      where: { event: 'content_view', key: { in: slugs }, day: { gte: since } },
      _sum: { count: true },
    });
    return new Map(rows.map((r) => [r.key, r._sum.count ?? 0]));
  }

  private summaryOf(row: EntryRow, views: Map<string, number>) {
    const type = fromDbType(row.type);
    return {
      id: row.id,
      type,
      slug: row.slug,
      path: contentPath(type, row.slug),
      title: row.title,
      status: fromDbStatus(row.status),
      revision: row.revision,
      author: row.author.displayName?.trim() || 'Staff member',
      editor: row.editor.displayName?.trim() || 'Staff member',
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      publishedAt: row.publishedAt?.toISOString() ?? null,
      views30d: views.get(row.slug) ?? 0,
    };
  }

  async adminList(q: AdminListQuery): Promise<AdminContentList> {
    const where: Prisma.ContentEntryWhereInput = {
      ...(q.status ? { status: q.status.toUpperCase() as DbStatus } : {}),
      ...(q.type ? { type: toDbType(q.type) } : {}),
      ...(q.q
        ? {
            OR: [
              { title: { contains: q.q, mode: 'insensitive' } },
              { slug: { contains: q.q.toLowerCase() } },
            ],
          }
        : {}),
    };
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.contentEntry.count({ where }),
      this.prisma.contentEntry.findMany({
        where,
        include: entryInclude,
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
    ]);
    const views = await this.views30d(rows.map((r) => r.slug));
    return {
      items: rows.map((r) => this.summaryOf(r, views)),
      pagination: {
        page: q.page,
        pageSize: q.pageSize,
        totalResults: total,
        totalPages: Math.ceil(total / q.pageSize),
      },
    };
  }

  /** Problems the server adds to publishProblems: unknown destinations, unpublished or missing related entries. */
  private async serverProblems(
    f: ContentFields,
    db: Tx | PrismaClient,
    forPublish: boolean,
  ): Promise<PublishProblem[]> {
    const problems: PublishProblem[] = [];
    for (const d of f.destinations) {
      if (!catalogDestination(d))
        problems.push({ field: 'destinations', message: `“${d}” isn’t a Wayora destination.` });
    }
    if (f.related.length > 0) {
      const rows = await db.contentEntry.findMany({
        where: { slug: { in: f.related } },
        select: { slug: true, status: true, type: true },
      });
      for (const s of f.related) {
        const r = rows.find((x) => x.slug === s);
        if (!r) problems.push({ field: 'related', message: `There’s no entry “${s}”.` });
        else if (r.type === 'FAQ')
          problems.push({
            field: 'related',
            message: `“${s}” is an FAQ, which has no page to link to.`,
          });
        else if (forPublish && r.status !== 'PUBLISHED')
          problems.push({
            field: 'related',
            message: `“${s}” isn’t published, so it can’t be linked yet.`,
          });
      }
    }
    return problems;
  }

  async adminGet(staff: Staff, id: string): Promise<AdminContent> {
    const row = await this.prisma.contentEntry.findUnique({ where: { id }, include: entryInclude });
    if (!row) throw new AppError('NOT_FOUND', 'There is no content entry with that id.');
    const f = fieldsOf(row);
    const [revisions, views, server, related] = await Promise.all([
      this.prisma.contentRevision.findMany({
        where: { entryId: id },
        orderBy: { revision: 'desc' },
        take: 50,
        include: { editor: { select: { displayName: true } } },
      }),
      this.views30d([row.slug]),
      this.serverProblems(f, this.prisma, true),
      this.relatedLinks(f.related),
    ]);
    return {
      ...this.summaryOf(row, views),
      fields: f,
      problems: [...publishProblems(f), ...server],
      firstPublishedAt: row.firstPublishedAt?.toISOString() ?? null,
      archivedAt: row.archivedAt?.toISOString() ?? null,
      revisions: revisions.map((r) => ({
        revision: r.revision,
        status: fromDbStatus(r.status),
        title: String((r.snapshot as { title?: unknown }).title ?? ''),
        editor: r.editor.displayName?.trim() || 'Staff member',
        note: r.note,
        createdAt: r.createdAt.toISOString(),
      })),
      preview: this.present(row, f, related, this.now()),
      allowed: {
        edit: hasPermission(staff.role, 'admin.content.edit'),
        publish: hasPermission(staff.role, 'admin.content.publish'),
      },
    };
  }

  private async lock(tx: Tx, id: string) {
    await tx.$queryRaw`SELECT id FROM content_entries WHERE id = ${id}::uuid FOR UPDATE`;
    return tx.contentEntry.findUnique({ where: { id }, include: entryInclude });
  }

  private revisionRow(
    tx: Tx,
    entryId: string,
    revision: number,
    status: DbStatus,
    f: ContentFields,
    editorId: string,
    note: string | null,
  ) {
    return tx.contentRevision.create({
      data: {
        entryId,
        revision,
        status,
        snapshot: f as unknown as Prisma.InputJsonValue,
        editorId,
        note,
        createdAt: this.now(),
      },
    });
  }

  private audit(
    tx: Tx,
    staff: Staff,
    action: string,
    id: string,
    metadata: Record<string, unknown>,
    ctx: RequestContext,
  ) {
    return tx.auditLog.create({
      data: {
        actorType: 'ADMIN',
        actorId: staff.id,
        action,
        entityType: 'content_entry',
        entityId: id,
        requestId: ctx.requestId ?? null,
        metadata: metadata as Prisma.InputJsonValue,
      },
    });
  }

  private columns(f: ContentFields) {
    return {
      slug: f.slug,
      title: f.title,
      summary: f.summary,
      body: f.body as unknown as Prisma.InputJsonValue,
      coverMedia: f.cover?.media ?? null,
      coverAlt: f.cover?.alt ?? null,
      seoTitle: f.seoTitle || null,
      metaDescription: f.metaDescription || null,
      destinations: [...new Set(f.destinations)],
      related: [...new Set(f.related)],
    };
  }

  private refuse(problems: PublishProblem[], message: string): never {
    throw new AppError('VALIDATION_FAILED', message, {
      details: problems.map((p) => ({
        path: `body.${p.field}`,
        message: p.message,
        code: 'custom',
      })),
    });
  }

  async create(staff: Staff, input: CreateInput, ctx: RequestContext): Promise<AdminContent> {
    const now = this.now();
    const server = await this.serverProblems(input, this.prisma, false);
    if (server.length > 0) this.refuse(server, 'Some links aren’t valid.');
    let id: string;
    try {
      id = await this.prisma.$transaction(async (tx) => {
        const row = await tx.contentEntry.create({
          data: {
            type: toDbType(input.type),
            ...this.columns(input),
            authorId: staff.id,
            editorId: staff.id,
            createdAt: now,
          },
        });
        await this.revisionRow(tx, row.id, 1, 'DRAFT', input, staff.id, 'Created');
        await this.audit(
          tx,
          staff,
          'content.created',
          row.id,
          { type: input.type, slug: input.slug },
          ctx,
        );
        return row.id;
      });
    } catch (e) {
      if (isUnique(e))
        throw new AppError('CONFLICT', `The slug “${input.slug}” is already used. Choose another.`);
      throw e;
    }
    return this.adminGet(staff, id);
  }

  async update(
    staff: Staff,
    id: string,
    input: UpdateInput,
    ctx: RequestContext,
  ): Promise<AdminContent> {
    try {
      await this.prisma.$transaction(async (tx) => {
        const row = await this.lock(tx, id);
        if (!row) throw new AppError('NOT_FOUND', 'There is no content entry with that id.');
        if (row.revision !== input.revision) throw new AppError('CONFLICT', STALE);
        const { revision: _r, ...rest } = input;
        const f: ContentFields = { ...rest, type: fromDbType(row.type) };
        if (row.firstPublishedAt && f.slug !== row.slug) {
          throw new AppError(
            'CONFLICT',
            'This entry has been published, so its address (slug) can’t change.',
          );
        }
        // Live content must stay publishable; drafts only need valid links.
        const live = row.status === 'PUBLISHED';
        const problems = [
          ...(live ? publishProblems(f) : []),
          ...(await this.serverProblems(f, tx, live)),
        ];
        if (problems.length > 0)
          this.refuse(
            problems,
            live ? 'A published entry must stay publishable.' : 'Some links aren’t valid.',
          );
        const revision = row.revision + 1;
        await tx.contentEntry.update({
          where: { id },
          data: {
            ...this.columns(f),
            editorId: staff.id,
            revision,
            ...(live ? { publishedAt: this.now() } : {}),
          },
        });
        await this.revisionRow(
          tx,
          id,
          revision,
          row.status,
          f,
          staff.id,
          live ? 'Edited while published' : 'Edited',
        );
        await this.audit(
          tx,
          staff,
          'content.updated',
          id,
          { slug: f.slug, status: row.status, revision },
          ctx,
        );
      });
    } catch (e) {
      if (isUnique(e))
        throw new AppError('CONFLICT', `The slug “${input.slug}” is already used. Choose another.`);
      throw e;
    }
    return this.adminGet(staff, id);
  }

  async changeStatus(
    staff: Staff,
    id: string,
    input: StatusInput,
    ctx: RequestContext,
  ): Promise<AdminContent> {
    const now = this.now();
    await this.prisma.$transaction(async (tx) => {
      const row = await this.lock(tx, id);
      if (!row) throw new AppError('NOT_FOUND', 'There is no content entry with that id.');
      if (row.revision !== input.revision) throw new AppError('CONFLICT', STALE);
      const f = fieldsOf(row);
      const revision = row.revision + 1;
      let data: Prisma.ContentEntryUncheckedUpdateInput;
      let status: DbStatus;
      if (input.action === 'publish') {
        if (row.status === 'ARCHIVED')
          throw new AppError('CONFLICT', 'Restore it to a draft before publishing.');
        const problems = [...publishProblems(f), ...(await this.serverProblems(f, tx, true))];
        if (problems.length > 0) this.refuse(problems, 'This entry isn’t ready to publish.');
        status = 'PUBLISHED';
        data = {
          status,
          publishedAt: now,
          firstPublishedAt: row.firstPublishedAt ?? now,
          archivedAt: null,
        };
      } else if (input.action === 'archive') {
        if (row.status === 'ARCHIVED') throw new AppError('CONFLICT', 'It’s already archived.');
        // Published entries that link here would point at a missing page.
        const linking = await tx.contentEntry.findMany({
          where: { status: 'PUBLISHED', related: { has: row.slug }, NOT: { id } },
          select: { slug: true },
        });
        if (linking.length > 0) {
          this.refuse(
            linking.map((l) => ({
              field: 'related',
              message: `“${l.slug}” links to it; remove that link first.`,
            })),
            'Published entries still link to this one.',
          );
        }
        status = 'ARCHIVED';
        data = { status, archivedAt: now };
      } else {
        if (row.status !== 'ARCHIVED')
          throw new AppError('CONFLICT', 'Only archived entries can be restored.');
        status = 'DRAFT';
        data = { status, archivedAt: null };
      }
      await tx.contentEntry.update({
        where: { id },
        data: { ...data, editorId: staff.id, revision },
      });
      await this.revisionRow(
        tx,
        id,
        revision,
        status,
        f,
        staff.id,
        { publish: 'Published', archive: 'Archived', restore: 'Restored to draft' }[input.action],
      );
      await this.audit(
        tx,
        staff,
        `content.${{ publish: 'published', archive: 'archived', restore: 'restored' }[input.action]}`,
        id,
        { slug: row.slug, type: row.type, from: row.status, to: status, revision },
        ctx,
      );
    });
    return this.adminGet(staff, id);
  }

  // ─── First-party counts ────────────────────────────────────────────────

  /**
   * Adds one to today's total for a page view or click. Keys must name a
   * real destination or published content: nothing else is counted.
   * Returns whether it was counted.
   */
  async record(e: AnalyticsEvent): Promise<boolean> {
    const [first, second] = e.key.split(':');
    let valid = false;
    if (e.event === 'destination_view') valid = !second && Boolean(catalogDestination(first));
    else if (e.event === 'destination_search_click')
      valid =
        Boolean(catalogDestination(first)) && travelCategorySlugSchema.safeParse(second).success;
    else if (!second) {
      valid = Boolean(
        await this.prisma.contentEntry.findFirst({
          where: { slug: first, status: 'PUBLISHED', NOT: { type: 'FAQ' } },
          select: { id: true },
        }),
      );
    }
    if (!valid) return false;
    const day = dayOf(this.now());
    await this.prisma.$executeRaw`
      INSERT INTO content_daily_counts (day, event, key, count) VALUES (${day}::date, ${e.event}, ${e.key}, 1)
      ON CONFLICT (day, event, key) DO UPDATE SET count = content_daily_counts.count + 1`;
    return true;
  }

  /** Destinations by page views over the last 30 days; empty unless enough destinations clear the minimum. */
  async popularDestinations(): Promise<PopularDestinations> {
    const since = dayOf(new Date(this.now().getTime() - (POPULAR_DAYS - 1) * 86_400_000));
    const rows = await this.prisma.contentDailyCount.groupBy({
      by: ['key'],
      where: { event: 'destination_view', day: { gte: since } },
      _sum: { count: true },
    });
    const qualifying = rows
      .map((r) => ({ slug: r.key, views: r._sum.count ?? 0 }))
      .filter((r) => r.views >= POPULAR_MIN_VIEWS && catalogDestination(r.slug))
      .sort((a, b) => b.views - a.views || a.slug.localeCompare(b.slug))
      .slice(0, 6);
    return {
      basis: 'destination_page_views',
      days: POPULAR_DAYS,
      minimumViews: POPULAR_MIN_VIEWS,
      items:
        qualifying.length >= POPULAR_MIN_ITEMS ? qualifying.map((q) => ({ slug: q.slug })) : [],
    };
  }

  async stats(days: number): Promise<ContentStats> {
    const since = dayOf(new Date(this.now().getTime() - (days - 1) * 86_400_000));
    const rows = await this.prisma.contentDailyCount.groupBy({
      by: ['event', 'key'],
      where: { day: { gte: since } },
      _sum: { count: true },
    });
    const top = (event: string) =>
      rows
        .filter((r) => r.event === event)
        .map((r) => ({ key: r.key, count: r._sum.count ?? 0 }))
        .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
        .slice(0, 10);
    const totals = new Map<string, number>();
    for (const r of rows) totals.set(r.event, (totals.get(r.event) ?? 0) + (r._sum.count ?? 0));
    return {
      days,
      totals: (
        [
          'destination_view',
          'content_view',
          'destination_search_click',
          'content_link_click',
        ] as const
      ).map((event) => ({
        event,
        count: totals.get(event) ?? 0,
      })),
      topDestinations: top('destination_view'),
      topContent: top('content_view'),
      searchClicks: top('destination_search_click'),
    };
  }
}
