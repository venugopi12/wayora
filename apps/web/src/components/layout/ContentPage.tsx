import type { ReactNode } from 'react';
import { Breadcrumbs, Container, PageHeader, Prose } from '@wayora/ui';
import { useDocumentTitle } from '../../hooks/useDocumentTitle';
import { useRouteBreadcrumbs } from './route-handle';

export interface ContentPageProps {
  title: string;
  /** One or two sentences under the title. */
  description?: ReactNode;
  eyebrow?: ReactNode;
  /** Shown above the body, e.g. a "Draft" notice. */
  notice?: ReactNode;
  /** Optional side panel on large screens (related links, status). */
  aside?: ReactNode;
  /** Long-form body: plain headings, paragraphs and lists, styled by `Prose`. */
  children: ReactNode;
  /** Composed content after the prose (e.g. an FAQ accordion), not prose-styled. */
  after?: ReactNode;
}

/**
 * Layout for informational and legal pages inside MarketingLayout:
 * breadcrumbs from the route handles, a page title block, an optional notice,
 * and a readable body (65-character measure) with an optional aside.
 * Uses the standard page container and section rhythm.
 */
export function ContentPage({
  title,
  description,
  eyebrow,
  notice,
  aside,
  children,
  after,
}: ContentPageProps) {
  useDocumentTitle(title);
  const crumbs = useRouteBreadcrumbs();
  return (
    <Container size="page" className="flex flex-col gap-10 py-section-sm">
      <div className="flex flex-col gap-6">
        <Breadcrumbs items={crumbs} />
        <PageHeader title={title} description={description} eyebrow={eyebrow} />
      </div>
      {notice ? <div className="max-w-prose">{notice}</div> : null}
      <div className="grid grid-cols-[minmax(0,1fr)] gap-12 lg:grid-cols-[minmax(0,1fr)_18rem] lg:gap-16">
        <div className="flex min-w-0 flex-col gap-10">
          <Prose>{children}</Prose>
          {after ? <div className="max-w-prose">{after}</div> : null}
        </div>
        {aside ? <aside className="flex flex-col gap-4 lg:pt-1">{aside}</aside> : null}
      </div>
    </Container>
  );
}
