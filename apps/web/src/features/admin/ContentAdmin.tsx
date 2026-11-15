import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, Eye, Pencil, Plus, Trash2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import {
  CONTENT_STATUSES,
  CONTENT_TYPE_LABEL,
  CONTENT_TYPES,
  MEDIA_KEYS,
  contentPath,
  slugify,
  type AdminContent,
  type ContentBlock,
  type ContentFields,
  type ContentStats,
  type ContentType,
  type MediaKey,
} from '@wayora/contracts';
import {
  Alert,
  Badge,
  Button,
  Checkbox,
  Field,
  Input,
  Select,
  Textarea,
  type BadgeTone,
} from '@wayora/ui';
import { ApiClientError } from '../../lib/api-client';
import {
  adminContent,
  adminContentList,
  adminContentStats,
  adminContentStatus,
  adminCreateContent,
  adminUpdateContent,
} from '../../services/content';
import { ContentView } from '../content/routes';
import { DESTINATIONS } from '../discover/data';
import { useCan } from './AdminLayout';
import { formatCount, formatUtc, humanize } from './format';
import { adminKeys } from './keys';
import { ADMIN_PATHS } from './paths';
import {
  AdminPage,
  DetailList,
  EmptyRows,
  FilterBar,
  Pager,
  QueryView,
  Section,
  Stat,
  StatGrid,
  Table,
  useFilters,
} from './ui';

/*
 * Content management (Phase 29, docs/seo.md#cms). Reading needs
 * admin.content.read; creating and editing drafts admin.content.edit;
 * publishing, archiving and restoring admin.content.publish. The API
 * validates every change, keeps every revision and writes the audit log.
 * Bodies are structured blocks (never HTML), rendered as text.
 */

const link = 'font-medium text-brand-ink underline-offset-2 hover:underline';
const mono = 'font-mono text-caption';
const STATUS_TONE: Record<string, BadgeTone> = {
  draft: 'warning',
  published: 'success',
  archived: 'neutral',
};

const errorText = (error: unknown) =>
  error instanceof ApiClientError
    ? [error.message, ...error.details.map((d) => `${d.path ?? ''} ${d.message}`.trim())]
        .filter(Boolean)
        .join(' ')
    : 'Something went wrong. Try again.';

const destinationName = (slug: string) => DESTINATIONS.find((d) => d.slug === slug)?.name ?? slug;
const mediaLabel = (key: string) => destinationName(key.replace(/^destination-/, ''));

// ─── List ───────────────────────────────────────────────────────────────

export function ContentListRoute() {
  const canEdit = useCan('admin.content.edit');
  const { values, page } = useFilters(['status', 'type', 'q']);
  const query = useQuery({
    queryKey: adminKeys.view('content', values, page),
    queryFn: ({ signal }) => adminContentList({ ...values, page } as never, signal),
    placeholderData: (previous) => previous,
  });
  const stats = useQuery({
    queryKey: adminKeys.view('content-stats', 30),
    queryFn: ({ signal }) => adminContentStats(30, signal),
  });
  return (
    <AdminPage
      title="Content"
      description="Guides, articles, tips, FAQs, collections and landing pages. Drafts are private; published entries are public pages (FAQs show on destination pages)."
      actions={
        canEdit ? (
          <Link to={ADMIN_PATHS.contentNew} className={`${link} inline-flex items-center gap-1`}>
            <Plus className="size-4" aria-hidden="true" />
            New entry
          </Link>
        ) : null
      }
    >
      <FilterBar
        label="Filter content"
        specs={[
          { name: 'q', label: 'Title or slug', kind: 'text' },
          {
            name: 'status',
            label: 'Status',
            kind: 'select',
            options: CONTENT_STATUSES.map((v) => ({ value: v, label: humanize(v) })),
          },
          {
            name: 'type',
            label: 'Type',
            kind: 'select',
            options: CONTENT_TYPES.map((v) => ({ value: v, label: CONTENT_TYPE_LABEL[v] })),
          },
        ]}
      />
      <QueryView query={query} label="content">
        {(data) =>
          data.items.length === 0 ? (
            <EmptyRows what="entries" />
          ) : (
            <>
              <Table
                label="Content entries"
                head={['Title', 'Type', 'Status', 'Updated', 'Editor', 'Views (30 days)']}
              >
                {data.items.map((c) => (
                  <tr key={c.id}>
                    <td>
                      <Link to={ADMIN_PATHS.contentItem(c.id)} className={link}>
                        {c.title}
                      </Link>
                      <div className={`${mono} text-ink-secondary`}>{c.slug}</div>
                    </td>
                    <td>{CONTENT_TYPE_LABEL[c.type]}</td>
                    <td>
                      <Badge tone={STATUS_TONE[c.status] ?? 'neutral'}>{humanize(c.status)}</Badge>
                    </td>
                    <td>{formatUtc(c.updatedAt)}</td>
                    <td>{c.editor}</td>
                    <td className="tabular-nums">{formatCount(c.views30d)}</td>
                  </tr>
                ))}
              </Table>
              <Pager pagination={data.pagination} label="Content" />
            </>
          )
        }
      </QueryView>
      <QueryView query={stats} label="page-view counts">
        {(s) => <StatsPanel stats={s} />}
      </QueryView>
    </AdminPage>
  );
}

const EVENT_LABEL: Record<string, string> = {
  destination_view: 'Destination page views',
  content_view: 'Guide and collection views',
  destination_search_click: 'Searches from destination pages',
  content_link_click: 'Clicks out of content',
};

function StatsPanel({ stats }: { stats: ContentStats }) {
  const total = (event: string) => stats.totals.find((t) => t.event === event)?.count ?? 0;
  const list = (
    title: string,
    rows: { key: string; count: number }[],
    label: (k: string) => string,
  ) => (
    <div className="flex min-w-0 flex-col gap-2">
      <h3 className="text-label text-ink">{title}</h3>
      {rows.length === 0 ? (
        <p className="text-body-sm text-ink-secondary">Nothing counted yet.</p>
      ) : (
        <ol className="flex flex-col gap-1 text-body-sm">
          {rows.map((r) => (
            <li key={r.key} className="flex justify-between gap-3">
              <span className="min-w-0 truncate">{label(r.key)}</span>
              <span className="tabular-nums text-ink-secondary">{formatCount(r.count)}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
  return (
    <Section
      title={`Page views, last ${stats.days} days`}
      description="First-party daily totals: no cookies, identifiers or IP addresses are stored, and visitors with Do Not Track or Global Privacy Control are not counted. Totals are page loads, not unique visitors."
    >
      <div className="flex flex-col gap-5">
        <StatGrid>
          {Object.keys(EVENT_LABEL).map((e) => (
            <Stat key={e} label={EVENT_LABEL[e]!} value={formatCount(total(e))} />
          ))}
        </StatGrid>
        <div className="grid gap-5 md:grid-cols-3">
          {list('Destinations', stats.topDestinations, destinationName)}
          {list('Content', stats.topContent, (k) => k)}
          {list('Searches from destination pages', stats.searchClicks, (k) => {
            const [d, s] = k.split(':');
            return `${destinationName(d ?? '')} → ${humanize(s ?? '')}`;
          })}
        </div>
      </div>
    </Section>
  );
}

// ─── New ────────────────────────────────────────────────────────────────

const emptyFields = (type: ContentType): ContentFields => ({
  type,
  slug: '',
  title: '',
  summary: '',
  body: [],
  cover: null,
  seoTitle: null,
  metaDescription: null,
  destinations: [],
  related: [],
});

export function ContentNewRoute() {
  const canEdit = useCan('admin.content.edit');
  const navigate = useNavigate();
  const qc = useQueryClient();
  const create = useMutation({
    mutationFn: adminCreateContent,
    onSuccess: async (c) => {
      await qc.invalidateQueries({ queryKey: adminKeys.view('content') });
      void navigate(ADMIN_PATHS.contentItem(c.id));
    },
  });
  return (
    <AdminPage
      title="New entry"
      description="Saved as a private draft. Publishing is a separate step."
      back={{ to: ADMIN_PATHS.content, label: 'Content' }}
    >
      {canEdit ? (
        <ContentEditor
          initial={emptyFields('guide')}
          isNew
          saving={create.isPending}
          error={create.isError ? errorText(create.error) : null}
          onSave={(f) => create.mutate(f)}
        />
      ) : (
        <Alert tone="info" title="You can read content but not create it">
          Creating and editing needs the content editing permission.
        </Alert>
      )}
    </AdminPage>
  );
}

// ─── Edit, preview, publish ─────────────────────────────────────────────

export function ContentEditRoute() {
  const { id = '' } = useParams();
  const query = useQuery({
    queryKey: adminKeys.view('content-item', id),
    queryFn: ({ signal }) => adminContent(id, signal),
  });
  return (
    <QueryView query={query} label="this entry" notFound="There's no entry with this ID">
      {(c) => <ContentItem key={`${c.id}-${c.revision}`} entry={c} />}
    </QueryView>
  );
}

function ContentItem({ entry: c }: { entry: AdminContent }) {
  const qc = useQueryClient();
  const [tab, setTab] = useState<'edit' | 'preview'>(c.allowed.edit ? 'edit' : 'preview');
  const refresh = async (next: AdminContent) => {
    qc.setQueryData(adminKeys.view('content-item', c.id), next);
    await qc.invalidateQueries({ queryKey: adminKeys.view('content') });
  };
  const save = useMutation({
    mutationFn: (f: ContentFields) => {
      const { type: _type, ...rest } = f;
      return adminUpdateContent(c.id, { ...rest, revision: c.revision });
    },
    onSuccess: refresh,
  });
  const status = useMutation({
    mutationFn: (action: 'publish' | 'archive' | 'restore') =>
      adminContentStatus(c.id, { action, revision: c.revision }),
    onSuccess: refresh,
  });
  const publicPath = contentPath(c.type, c.slug);

  return (
    <AdminPage
      title={c.title}
      description={`${CONTENT_TYPE_LABEL[c.type]} · revision ${c.revision}`}
      back={{ to: ADMIN_PATHS.content, label: 'Content' }}
      actions={<Badge tone={STATUS_TONE[c.status] ?? 'neutral'}>{humanize(c.status)}</Badge>}
    >
      <Section title="Status">
        <div className="flex flex-col gap-4">
          <DetailList
            items={[
              [
                'Public address',
                publicPath ? (
                  c.status === 'published' ? (
                    <Link to={publicPath} className={link}>
                      {publicPath}
                    </Link>
                  ) : (
                    <span className={mono}>{publicPath} (not public until published)</span>
                  )
                ) : (
                  'No page of its own: shown on the destination pages it’s linked to'
                ),
              ],
              ['Author', c.author],
              ['Last edited by', c.editor],
              ['Created', formatUtc(c.createdAt)],
              ['Updated', formatUtc(c.updatedAt)],
              ['First published', c.firstPublishedAt ? formatUtc(c.firstPublishedAt) : '—'],
              ['Views (30 days)', formatCount(c.views30d)],
            ]}
          />
          {c.problems.length ? (
            <Alert tone="warning" title="Not ready to publish">
              <ul className="list-disc pl-5">
                {c.problems.map((p, i) => (
                  <li key={i}>{p.message}</li>
                ))}
              </ul>
            </Alert>
          ) : c.status !== 'published' ? (
            <p className="text-body-sm text-ink-secondary">Ready to publish.</p>
          ) : null}
          {c.allowed.publish ? (
            <div className="flex flex-wrap gap-2">
              {c.status !== 'published' ? (
                <Button
                  onClick={() => status.mutate('publish')}
                  loading={status.isPending && status.variables === 'publish'}
                  disabled={c.problems.length > 0 || c.status === 'archived'}
                >
                  Publish
                </Button>
              ) : null}
              {c.status !== 'archived' ? (
                <Button
                  variant="secondary"
                  onClick={() => status.mutate('archive')}
                  loading={status.isPending && status.variables === 'archive'}
                >
                  Archive
                </Button>
              ) : (
                <Button
                  variant="secondary"
                  onClick={() => status.mutate('restore')}
                  loading={status.isPending && status.variables === 'restore'}
                >
                  Restore as a draft
                </Button>
              )}
            </div>
          ) : (
            <p className="text-body-sm text-ink-secondary">
              Publishing and archiving need the content publishing permission.
            </p>
          )}
          {status.isError ? (
            <Alert tone="danger" title="Status not changed">
              {errorText(status.error)}
            </Alert>
          ) : null}
        </div>
      </Section>

      <div role="group" aria-label="View" className="flex gap-2">
        {c.allowed.edit ? (
          <Button
            variant={tab === 'edit' ? 'primary' : 'secondary'}
            size="sm"
            aria-pressed={tab === 'edit'}
            onClick={() => setTab('edit')}
          >
            <Pencil aria-hidden="true" />
            Edit
          </Button>
        ) : null}
        <Button
          variant={tab === 'preview' ? 'primary' : 'secondary'}
          size="sm"
          aria-pressed={tab === 'preview'}
          onClick={() => setTab('preview')}
        >
          <Eye aria-hidden="true" />
          Preview
        </Button>
      </div>

      {tab === 'edit' && c.allowed.edit ? (
        <ContentEditor
          initial={c.fields}
          published={c.firstPublishedAt !== null}
          saving={save.isPending}
          error={save.isError ? errorText(save.error) : null}
          saved={save.isSuccess}
          onSave={(f) => save.mutate(f)}
        />
      ) : (
        <Section
          title="Preview"
          description="How the saved version looks when published. Previews are never indexed."
        >
          <ContentView content={c.preview} preview />
        </Section>
      )}

      <Section title="Revisions" description="Every saved version is kept.">
        <Table label="Revisions" head={['Revision', 'Status', 'Title', 'Editor', 'Saved']}>
          {c.revisions.map((r) => (
            <tr key={r.revision}>
              <td className="tabular-nums">{r.revision}</td>
              <td>{humanize(r.status)}</td>
              <td>{r.title}</td>
              <td>{r.editor}</td>
              <td>{formatUtc(r.createdAt)}</td>
            </tr>
          ))}
        </Table>
      </Section>
    </AdminPage>
  );
}

// ─── Editor ─────────────────────────────────────────────────────────────

const BLOCK_LABEL: Record<ContentBlock['type'], string> = {
  heading: 'Heading',
  paragraph: 'Paragraph',
  list: 'List',
  tip: 'Tip',
  provider: 'Provider rule',
  image: 'Image',
};

const newBlock = (type: ContentBlock['type']): ContentBlock => {
  switch (type) {
    case 'heading':
      return { type, level: 2, text: '' };
    case 'list':
      return { type, style: 'bullet', items: [''] };
    case 'image':
      return { type, media: MEDIA_KEYS[0]!, alt: '', caption: null };
    default:
      return { type, text: '' };
  }
};

function ContentEditor({
  initial,
  isNew = false,
  published = false,
  saving,
  saved = false,
  error,
  onSave,
}: {
  initial: ContentFields;
  isNew?: boolean;
  /** Once published, the slug (the public address) can't change. */
  published?: boolean;
  saving: boolean;
  saved?: boolean;
  error: string | null;
  onSave: (fields: ContentFields) => void;
}) {
  const [f, setF] = useState<ContentFields>(initial);
  const [slugTouched, setSlugTouched] = useState(!isNew);
  const [relatedText, setRelatedText] = useState(initial.related.join(', '));
  const set = <K extends keyof ContentFields>(key: K, value: ContentFields[K]) =>
    setF((prev) => ({ ...prev, [key]: value }));
  const setBlock = (i: number, b: ContentBlock) =>
    set(
      'body',
      f.body.map((x, j) => (j === i ? b : x)),
    );
  const move = (i: number, by: -1 | 1) => {
    const next = [...f.body];
    const [b] = next.splice(i, 1);
    next.splice(i + by, 0, b!);
    set('body', next);
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    onSave({
      ...f,
      body: f.body.map((b) =>
        b.type === 'list' ? { ...b, items: b.items.map((x) => x.trim()).filter(Boolean) } : b,
      ),
      related: relatedText
        .split(/[\s,]+/)
        .map((s) => s.trim())
        .filter(Boolean),
      seoTitle: f.seoTitle?.trim() ? f.seoTitle : null,
      metaDescription: f.metaDescription?.trim() ? f.metaDescription : null,
    });
  };

  const isFaq = f.type === 'faq';
  return (
    <Section title={isNew ? 'Draft' : 'Edit'} description="Saving keeps the current status.">
      <form noValidate onSubmit={submit} className="flex flex-col gap-5">
        <div className="grid gap-4 sm:grid-cols-2">
          {isNew ? (
            <Field label="Type">
              <Select
                value={f.type}
                onChange={(e) => set('type', e.target.value as ContentType)}
                options={CONTENT_TYPES.map((t) => ({ value: t, label: CONTENT_TYPE_LABEL[t] }))}
              />
            </Field>
          ) : null}
          <Field label={isFaq ? 'Question' : 'Title'} hint="5–120 characters.">
            <Input
              value={f.title}
              onChange={(e) => {
                const title = e.target.value;
                setF((prev) => ({
                  ...prev,
                  title,
                  ...(slugTouched ? {} : { slug: slugify(title) }),
                }));
              }}
            />
          </Field>
          <Field
            label="Slug"
            hint={
              published
                ? 'Fixed: this entry has been published at this address.'
                : 'Lower-case letters, digits and hyphens; part of the public address. Fixed once published.'
            }
          >
            <Input
              value={f.slug}
              readOnly={published}
              onChange={(e) => {
                setSlugTouched(true);
                set('slug', e.target.value);
              }}
            />
          </Field>
        </div>
        {!isFaq ? (
          <Field
            label="Introduction"
            hint="Shown first and in lists; at least 40 characters to publish."
          >
            <Textarea rows={3} value={f.summary} onChange={(e) => set('summary', e.target.value)} />
          </Field>
        ) : null}

        <fieldset className="flex flex-col gap-3">
          <legend className="mb-2 text-label text-ink">{isFaq ? 'Answer' : 'Body'}</legend>
          {f.body.length === 0 ? (
            <p className="text-body-sm text-ink-secondary">No blocks yet. Add one below.</p>
          ) : null}
          <ol className="flex flex-col gap-3">
            {f.body.map((b, i) => (
              <li key={i} className="flex flex-col gap-3 rounded-lg border border-line p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-label text-ink">
                    {i + 1}. {BLOCK_LABEL[b.type]}
                  </span>
                  <span className="flex gap-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={i === 0}
                      aria-label={`Move block ${i + 1} up`}
                      onClick={() => move(i, -1)}
                    >
                      <ArrowUp aria-hidden="true" />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={i === f.body.length - 1}
                      aria-label={`Move block ${i + 1} down`}
                      onClick={() => move(i, 1)}
                    >
                      <ArrowDown aria-hidden="true" />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      aria-label={`Remove block ${i + 1}`}
                      onClick={() =>
                        set(
                          'body',
                          f.body.filter((_, j) => j !== i),
                        )
                      }
                    >
                      <Trash2 aria-hidden="true" />
                    </Button>
                  </span>
                </div>
                <BlockFields index={i} block={b} onChange={(next) => setBlock(i, next)} />
              </li>
            ))}
          </ol>
          <div className="flex flex-wrap gap-2" role="group" aria-label="Add a block">
            {(Object.keys(BLOCK_LABEL) as ContentBlock['type'][]).map((t) => (
              <Button
                key={t}
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => set('body', [...f.body, newBlock(t)])}
              >
                <Plus aria-hidden="true" />
                {BLOCK_LABEL[t]}
              </Button>
            ))}
          </div>
        </fieldset>

        {!isFaq ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Cover image" hint="Photographs from Wayora’s media library only.">
              <Select
                value={f.cover?.media ?? ''}
                onChange={(e) =>
                  set(
                    'cover',
                    e.target.value
                      ? { media: e.target.value as MediaKey, alt: f.cover?.alt ?? '' }
                      : null,
                  )
                }
                options={[
                  { value: '', label: 'No cover' },
                  ...MEDIA_KEYS.map((k) => ({ value: k, label: mediaLabel(k) })),
                ]}
              />
            </Field>
            {f.cover ? (
              <Field label="Cover alt text" hint="Describe the image for people who can’t see it.">
                <Input
                  value={f.cover.alt}
                  onChange={(e) => set('cover', { media: f.cover!.media, alt: e.target.value })}
                />
              </Field>
            ) : null}
          </div>
        ) : null}

        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-label text-ink">Destinations</legend>
          <p className="text-body-sm text-ink-secondary">
            {isFaq
              ? 'The destination pages this question appears on.'
              : 'Destinations this entry is about or features (linked from the page).'}
          </p>
          <div className="grid gap-2 sm:grid-cols-3">
            {DESTINATIONS.map((d) => (
              <Checkbox
                key={d.slug}
                label={d.name}
                checked={f.destinations.includes(d.slug)}
                onChange={(e) =>
                  set(
                    'destinations',
                    e.target.checked
                      ? [...f.destinations, d.slug]
                      : f.destinations.filter((s) => s !== d.slug),
                  )
                }
              />
            ))}
          </div>
        </fieldset>

        {!isFaq ? (
          <>
            <Field
              label="Related entries"
              hint="Slugs of published entries, separated by commas (up to 6)."
            >
              <Input value={relatedText} onChange={(e) => setRelatedText(e.target.value)} />
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                label="SEO title"
                hint={`Optional, up to 60 characters (${(f.seoTitle ?? '').length}/60). Defaults to the title.`}
              >
                <Input value={f.seoTitle ?? ''} onChange={(e) => set('seoTitle', e.target.value)} />
              </Field>
              <Field
                label="Meta description"
                hint={`50–160 characters to publish (${(f.metaDescription ?? '').length}/160). Shown in search results.`}
              >
                <Textarea
                  rows={2}
                  value={f.metaDescription ?? ''}
                  onChange={(e) => set('metaDescription', e.target.value)}
                />
              </Field>
            </div>
          </>
        ) : null}

        {error ? (
          <Alert tone="danger" title="Not saved">
            {error}
          </Alert>
        ) : saved ? (
          <Alert tone="success" title="Saved">
            A new revision was saved.
          </Alert>
        ) : null}
        <div>
          <Button type="submit" loading={saving}>
            {isNew ? 'Save draft' : 'Save'}
          </Button>
        </div>
      </form>
    </Section>
  );
}

function BlockFields({
  index,
  block: b,
  onChange,
}: {
  index: number;
  block: ContentBlock;
  onChange: (b: ContentBlock) => void;
}) {
  const n = index + 1;
  switch (b.type) {
    case 'heading':
      return (
        <div className="grid gap-3 sm:grid-cols-[10rem_1fr]">
          <Field label={`Block ${n} level`}>
            <Select
              value={String(b.level)}
              onChange={(e) => onChange({ ...b, level: e.target.value === '3' ? 3 : 2 })}
              options={[
                { value: '2', label: 'Section (H2)' },
                { value: '3', label: 'Subsection (H3)' },
              ]}
            />
          </Field>
          <Field label={`Block ${n} heading`}>
            <Input value={b.text} onChange={(e) => onChange({ ...b, text: e.target.value })} />
          </Field>
        </div>
      );
    case 'paragraph':
    case 'tip':
    case 'provider':
      return (
        <Field
          label={`Block ${n} text`}
          hint={
            b.type === 'provider'
              ? 'A rule set by an airline, hotel, operator or government. Shown as “Set by the provider, not Wayora”.'
              : b.type === 'paragraph'
                ? 'Plain text. A blank line starts a new paragraph.'
                : undefined
          }
        >
          <Textarea
            rows={4}
            value={b.text}
            onChange={(e) => onChange({ ...b, text: e.target.value })}
          />
        </Field>
      );
    case 'list':
      return (
        <div className="grid gap-3 sm:grid-cols-[10rem_1fr]">
          <Field label={`Block ${n} style`}>
            <Select
              value={b.style}
              onChange={(e) =>
                onChange({ ...b, style: e.target.value === 'number' ? 'number' : 'bullet' })
              }
              options={[
                { value: 'bullet', label: 'Bullets' },
                { value: 'number', label: 'Numbered' },
              ]}
            />
          </Field>
          <Field label={`Block ${n} items`} hint="One item per line.">
            <Textarea
              rows={4}
              value={b.items.join('\n')}
              onChange={(e) => onChange({ ...b, items: e.target.value.split('\n') })}
            />
          </Field>
        </div>
      );
    case 'image':
      return (
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label={`Block ${n} image`}>
            <Select
              value={b.media}
              onChange={(e) => onChange({ ...b, media: e.target.value as MediaKey })}
              options={MEDIA_KEYS.map((k) => ({ value: k, label: mediaLabel(k) }))}
            />
          </Field>
          <Field label={`Block ${n} alt text`}>
            <Input value={b.alt} onChange={(e) => onChange({ ...b, alt: e.target.value })} />
          </Field>
          <Field label={`Block ${n} caption`} hint="Optional.">
            <Input
              value={b.caption ?? ''}
              onChange={(e) => onChange({ ...b, caption: e.target.value || null })}
            />
          </Field>
        </div>
      );
  }
}
