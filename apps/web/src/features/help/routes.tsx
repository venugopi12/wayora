import {
  ArrowRight,
  BadgeCheck,
  BookOpen,
  CreditCard,
  FileText,
  Gift,
  LifeBuoy,
  Luggage,
  Receipt,
  RotateCcw,
  Search,
  Tag,
  UserRound,
  Wrench,
  XCircle,
  type LucideIcon,
} from 'lucide-react';
import { useId, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import {
  HELP_CATEGORIES,
  helpArticle,
  helpArticlesIn,
  helpCategory,
  searchHelp,
  type HelpArticle,
  type HelpBlock,
  type HelpCategorySlug,
} from '@wayora/contracts';
import {
  Alert,
  Breadcrumbs,
  Button,
  Card,
  Container,
  EmptyState,
  Input,
  PageHeader,
  cn,
  interaction,
} from '@wayora/ui';
import { useDocumentTitle } from '../../hooks/useDocumentTitle';
import { NotFoundRoute } from '../../routes/NotFoundRoute';
import {
  HELP_PATH,
  helpArticlePath,
  helpSearchPath,
  helpTopicPath,
  newTicketPath,
} from '../support/paths';

/*
 * Help Center (Phase 27, docs/support.md#help-center). Content lives in
 * packages/contracts/src/help.ts and describes how Wayora works today;
 * provider rules are marked as such. Search is deterministic keyword search
 * in the browser (no AI, no network).
 */

const TOPIC_ICON: Record<HelpCategorySlug, LucideIcon> = {
  booking: Luggage,
  payments: CreditCard,
  cancellations: XCircle,
  refunds: RotateCcw,
  documents: FileText,
  rewards: Gift,
  promotions: Tag,
  account: UserRound,
  technical: Wrench,
};

const POPULAR = [
  'what-is-a-demo-booking',
  'cancelling-a-booking',
  'refund-states',
  'using-a-coupon',
  'payment-failed',
  'contacting-support',
];

const linkClass =
  'font-semibold text-brand-ink underline-offset-4 hover:underline focus-visible:underline';

function SearchForm({
  initial = '',
  autoFocus = false,
}: {
  initial?: string;
  autoFocus?: boolean;
}) {
  const navigate = useNavigate();
  const [q, setQ] = useState(initial);
  const id = useId();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const v = q.trim();
    void navigate(v ? helpSearchPath(v) : HELP_PATH);
  };
  return (
    <form
      role="search"
      aria-label="Search help"
      onSubmit={submit}
      className="flex w-full max-w-2xl gap-2"
    >
      <label htmlFor={id} className="sr-only">
        Search help articles
      </label>
      <div className="relative min-w-0 flex-1">
        <Search
          className="pointer-events-none absolute top-1/2 left-3 size-5 -translate-y-1/2 text-ink-subtle"
          aria-hidden="true"
        />
        <Input
          id={id}
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search, e.g. refund, coupon, password"
          className="pl-10"
          autoComplete="off"
          // Only when the visitor asked to search (the search results page).
          autoFocus={autoFocus}
          maxLength={120}
        />
      </div>
      <Button type="submit">Search</Button>
    </form>
  );
}

function ArticleLink({
  article,
  showTopic = false,
}: {
  article: HelpArticle;
  showTopic?: boolean;
}) {
  return (
    <Link
      to={helpArticlePath(article.slug)}
      className={cn(
        'group flex h-full flex-col gap-1 rounded-lg border border-line bg-card p-4 shadow-xs',
        'hover:border-brand-300 hover:bg-brand-soft/40',
      )}
    >
      {showTopic ? (
        <span className="text-caption text-ink-secondary">
          {helpCategory(article.category)?.title}
        </span>
      ) : null}
      <span className="flex items-start justify-between gap-3 text-body font-semibold text-ink">
        {article.title}
        <ArrowRight
          aria-hidden="true"
          className={cn('mt-1 size-4 shrink-0 text-brand', interaction.iconNudge)}
        />
      </span>
      <span className="text-body-sm text-ink-secondary">{article.summary}</span>
    </Link>
  );
}

function ContactCard({ category, article }: { category?: string; article?: string }) {
  return (
    <Card padding="md" className="flex flex-col gap-3">
      <span className="flex size-10 items-center justify-center rounded-full bg-brand-soft text-brand-ink">
        <LifeBuoy className="size-5" aria-hidden="true" />
      </span>
      <h2 className="text-title">Still need help?</h2>
      <p className="text-body-sm text-ink-secondary">
        Open a support ticket. You need to be signed in, so support can check your bookings with
        you. Replies arrive in the ticket and in your notifications.
      </p>
      <Link
        to={newTicketPath({
          ...(category ? { category } : {}),
          ...(article ? { article } : {}),
        })}
        className="inline-flex min-h-11 items-center justify-center rounded-md bg-brand px-4 text-label text-white hover:bg-brand-600"
      >
        Contact support
      </Link>
      <Link to="/support" className={cn(linkClass, 'text-body-sm')}>
        Your support tickets
      </Link>
    </Card>
  );
}

/** /help and /help?q= */
export function HelpCenterRoute() {
  const [params] = useSearchParams();
  const q = (params.get('q') ?? '').slice(0, 120);
  useDocumentTitle(q ? `Search help: ${q}` : 'Help Center');
  const results = q ? searchHelp(q, 12) : [];
  return (
    <Container className="flex flex-col gap-10 py-section-sm">
      <Breadcrumbs
        items={[
          { label: 'Home', link: <Link to="/" /> },
          ...(q
            ? [{ label: 'Help Center', link: <Link to={HELP_PATH} /> }, { label: 'Search' }]
            : [{ label: 'Help Center' }]),
        ]}
      />
      <div className="flex flex-col gap-6 rounded-2xl bg-brand-soft/60 px-5 py-8 sm:px-10 sm:py-12">
        <PageHeader
          headingLevel="h1"
          eyebrow="Help Center"
          title={q ? 'Search results' : 'How can we help?'}
          description="Answers about bookings, payments, cancellations, refunds, rewards and your account, as Wayora works today."
        />
        <SearchForm key={q} initial={q} autoFocus={Boolean(q)} />
      </div>

      {q ? (
        <section aria-labelledby="results-title" className="flex flex-col gap-4">
          <h2 id="results-title" className="text-heading-3" aria-live="polite">
            {results.length === 0
              ? `No articles match “${q}”`
              : `${results.length} article${results.length === 1 ? '' : 's'} for “${q}”`}
          </h2>
          {results.length === 0 ? (
            <div className="rounded-xl border border-dashed border-line-strong bg-card">
              <EmptyState
                icon={<Search />}
                title="Try other words"
                description="Search for a topic such as refund, coupon, payment or password, or browse the topics below."
                action={
                  <Link to={newTicketPath()} className={linkClass}>
                    Contact support instead
                  </Link>
                }
              />
            </div>
          ) : (
            <ul className="grid gap-3 md:grid-cols-2">
              {results.map((a) => (
                <li key={a.slug} className="min-w-0">
                  <ArticleLink article={a} showTopic />
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}

      <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="flex min-w-0 flex-col gap-10">
          <section aria-labelledby="topics-title" className="flex flex-col gap-4">
            <h2 id="topics-title" className="text-heading-3">
              Browse by topic
            </h2>
            <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {HELP_CATEGORIES.map((c) => {
                const Icon = TOPIC_ICON[c.slug];
                const n = helpArticlesIn(c.slug).length;
                return (
                  <li key={c.slug} className="min-w-0">
                    <Link
                      to={helpTopicPath(c.slug)}
                      className="group flex h-full gap-3 rounded-xl border border-line bg-card p-4 shadow-xs hover:border-brand-300"
                    >
                      <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-brand-soft text-brand-ink">
                        <Icon className="size-5" aria-hidden="true" />
                      </span>
                      <span className="flex min-w-0 flex-col gap-0.5">
                        <span className="text-body font-semibold text-ink group-hover:text-brand-ink">
                          {c.title}
                        </span>
                        <span className="text-body-sm text-ink-secondary">{c.description}</span>
                        <span className="text-caption text-ink-secondary">
                          {n} article{n === 1 ? '' : 's'}
                        </span>
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </section>
          {!q ? (
            <section aria-labelledby="popular-title" className="flex flex-col gap-4">
              <h2 id="popular-title" className="text-heading-3">
                Popular questions
              </h2>
              <ul className="grid gap-3 md:grid-cols-2">
                {POPULAR.map((slug) => helpArticle(slug))
                  .filter((a): a is HelpArticle => a !== null)
                  .map((a) => (
                    <li key={a.slug} className="min-w-0">
                      <ArticleLink article={a} />
                    </li>
                  ))}
              </ul>
            </section>
          ) : null}
        </div>
        <aside aria-label="Contact support" className="flex flex-col gap-4">
          <ContactCard />
          <Alert tone="info" role="none" title="Every booking is a demo">
            Wayora is in development: bookings and payments are simulated, and nothing is reserved
            with suppliers or charged.
          </Alert>
        </aside>
      </div>
    </Container>
  );
}

function TopicNav({ current }: { current: string }) {
  return (
    <nav aria-label="Help topics">
      <ul className="flex flex-wrap gap-1 lg:flex-col">
        {HELP_CATEGORIES.map((c) => (
          <li key={c.slug}>
            <Link
              to={helpTopicPath(c.slug)}
              aria-current={c.slug === current ? 'page' : undefined}
              className="flex min-h-10 items-center rounded-md px-3 text-body-sm text-ink-secondary hover:bg-brand-soft hover:text-brand-ink aria-[current=page]:bg-brand-soft aria-[current=page]:font-semibold aria-[current=page]:text-brand-ink"
            >
              {c.title}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/** /help/topics/:category */
export function HelpTopicRoute() {
  const { category = '' } = useParams();
  const topic = helpCategory(category);
  useDocumentTitle(topic ? `${topic.title} · Help Center` : 'Help Center');
  if (!topic) return <NotFoundRoute />;
  const articles = helpArticlesIn(topic.slug);
  return (
    <Container className="flex flex-col gap-8 py-section-sm">
      <Breadcrumbs
        items={[
          { label: 'Home', link: <Link to="/" /> },
          { label: 'Help Center', link: <Link to={HELP_PATH} /> },
          { label: topic.title },
        ]}
      />
      <div className="grid gap-8 lg:grid-cols-[14rem_minmax(0,1fr)_18rem] lg:gap-10">
        <TopicNav current={topic.slug} />
        <div className="flex min-w-0 flex-col gap-6">
          <PageHeader
            headingLevel="h1"
            eyebrow="Help Center"
            title={topic.title}
            description={topic.description}
          />
          <SearchForm />
          <ul className="flex flex-col gap-3" aria-label={`${topic.title} articles`}>
            {articles.map((a) => (
              <li key={a.slug}>
                <ArticleLink article={a} />
              </li>
            ))}
          </ul>
        </div>
        <aside aria-label="Contact support">
          <ContactCard category={articles[0]?.supportCategory} />
        </aside>
      </div>
    </Container>
  );
}

function Block({ block }: { block: HelpBlock }) {
  switch (block.type) {
    case 'p':
      return <p className="text-body text-ink">{block.text}</p>;
    case 'list':
      return (
        <ul className="ml-5 flex list-disc flex-col gap-2 text-body text-ink marker:text-brand">
          {block.items.map((i) => (
            <li key={i}>{i}</li>
          ))}
        </ul>
      );
    case 'steps':
      return (
        <ol className="ml-5 flex list-decimal flex-col gap-2 text-body text-ink marker:font-semibold marker:text-brand-ink">
          {block.items.map((i) => (
            <li key={i}>{i}</li>
          ))}
        </ol>
      );
    case 'provider':
      return (
        <Alert tone="info" role="none" title="Set by the provider, not Wayora">
          {block.text}
        </Alert>
      );
    case 'demo':
      return (
        <Alert tone="warning" role="none" title="Demo bookings">
          {block.text}
        </Alert>
      );
  }
}

/** /help/articles/:slug */
export function HelpArticleRoute() {
  const { slug = '' } = useParams();
  const article = helpArticle(slug);
  useDocumentTitle(article ? `${article.title} · Help Center` : 'Help Center');
  if (!article) return <NotFoundRoute />;
  const topic = helpCategory(article.category)!;
  const related = article.related
    .map((s) => helpArticle(s))
    .filter((a): a is HelpArticle => a !== null);
  return (
    <Container className="flex flex-col gap-8 py-section-sm">
      <Breadcrumbs
        items={[
          { label: 'Home', link: <Link to="/" /> },
          { label: 'Help Center', link: <Link to={HELP_PATH} /> },
          { label: topic.title, link: <Link to={helpTopicPath(topic.slug)} /> },
          { label: article.title },
        ]}
      />
      <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_18rem] lg:gap-16">
        <article
          className="flex max-w-prose min-w-0 flex-col gap-5"
          aria-labelledby="article-title"
        >
          <div className="flex flex-col gap-2">
            <Link
              to={helpTopicPath(topic.slug)}
              className="text-label text-brand-ink hover:underline"
            >
              {topic.title}
            </Link>
            <h1 id="article-title" className="text-heading-1">
              {article.title}
            </h1>
            <p className="text-body-lg text-ink-secondary">{article.summary}</p>
          </div>
          {article.body.map((b, i) => (
            <Block key={i} block={b} />
          ))}
          {article.actions?.length ? (
            <div className="flex flex-wrap gap-2">
              {article.actions.map((a) => (
                <Link
                  key={a.path}
                  to={a.path}
                  className="inline-flex min-h-11 items-center gap-1.5 rounded-md border border-line-strong bg-card px-4 text-label text-ink hover:border-brand-300 hover:text-brand-ink"
                >
                  {a.label}
                  <ArrowRight className="size-4" aria-hidden="true" />
                </Link>
              ))}
            </div>
          ) : null}
          <p className="flex items-center gap-1.5 text-caption text-ink-secondary">
            <BadgeCheck className="size-4" aria-hidden="true" />
            Checked against how Wayora works on{' '}
            {new Intl.DateTimeFormat('en-IN', { dateStyle: 'long' }).format(
              new Date(`${article.reviewed}T00:00:00`),
            )}
            .
          </p>
          {related.length ? (
            <section
              aria-labelledby="related-title"
              className="flex flex-col gap-3 border-t border-line pt-6"
            >
              <h2 id="related-title" className="text-heading-3">
                Related articles
              </h2>
              <ul className="grid gap-3 sm:grid-cols-2">
                {related.map((a) => (
                  <li key={a.slug} className="min-w-0">
                    <ArticleLink article={a} />
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </article>
        <aside aria-label="Contact support" className="flex flex-col gap-4">
          <ContactCard category={article.supportCategory} article={article.slug} />
          <Card padding="md" className="flex flex-col gap-2">
            <h2 className="flex items-center gap-2 text-label text-ink">
              <BookOpen className="size-4" aria-hidden="true" />
              In {topic.title}
            </h2>
            <ul className="flex flex-col gap-1">
              {helpArticlesIn(topic.slug).map((a) => (
                <li key={a.slug}>
                  <Link
                    to={helpArticlePath(a.slug)}
                    aria-current={a.slug === article.slug ? 'page' : undefined}
                    className="block rounded-xs py-1 text-body-sm text-ink-secondary hover:text-brand-ink aria-[current=page]:font-semibold aria-[current=page]:text-ink"
                  >
                    {a.title}
                  </Link>
                </li>
              ))}
            </ul>
          </Card>
        </aside>
      </div>
    </Container>
  );
}

/** For other pages: suggestions for what someone is typing (no AI). */
export function HelpSuggestions({ articles, label }: { articles: HelpArticle[]; label: string }) {
  if (articles.length === 0) return null;
  return (
    <section aria-label={label} className="flex flex-col gap-2 rounded-lg bg-brand-soft/60 p-4">
      <p className="flex items-center gap-2 text-label text-brand-ink">
        <Receipt className="size-4" aria-hidden="true" />
        {label}
      </p>
      <ul className="flex flex-col gap-1.5">
        {articles.map((a) => (
          <li key={a.slug} className="text-body-sm">
            <Link to={helpArticlePath(a.slug)} className={linkClass} target="_blank" rel="noopener">
              {a.title}
              <span className="sr-only"> (opens in a new tab)</span>
            </Link>
            <span className="text-ink-secondary"> · {a.summary}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
