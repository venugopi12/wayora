import { useQuery } from '@tanstack/react-query';
import { Clock, MapPin } from 'lucide-react';
import { ACTIVITY_CATEGORY_LABELS, type Destination } from '@wayora/contracts';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
  Container,
  Eyebrow,
  PageHeader,
} from '@wayora/ui';
import { listPublishedContent } from '../../services/content';
import { ContentBody } from '../content/ContentBody';
import { contentKeys } from '../content/keys';
import { ContentCard } from '../content/routes';
import { attractionsFor } from '../seo/pages';

/*
 * Destination page sections added in Phase 29: things to see and do (the
 * curated planner catalogue), and published guides and FAQs about the place.
 */

const duration = (minutes: number) =>
  minutes >= 60 ? `About ${Math.round((minutes / 60) * 2) / 2} h` : `About ${minutes} min`;

export function ThingsToDo({ destination }: { destination: Destination }) {
  const items = attractionsFor(destination.slug);
  if (items.length === 0) return null;
  return (
    <section aria-labelledby="things-title" className="border-t border-line py-section-sm">
      <Container size="wide" className="flex flex-col gap-section-head">
        <PageHeader
          size="section"
          headingLevel="h2"
          id="things-title"
          eyebrow="On the ground"
          title={`Things to see and do in ${destination.name}`}
          description="From Wayora’s sample planning catalogue, the same list the trip planner uses. Times are planning estimates; check opening hours and entry rules locally."
        />
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {items.map((a) => (
            <li
              key={a.name}
              className="flex flex-col gap-1.5 rounded-xl border border-line bg-card p-4"
            >
              <span className="text-caption text-ink-secondary">
                {ACTIVITY_CATEGORY_LABELS[a.category]}
              </span>
              <h3 className="text-title">{a.name}</h3>
              <p className="text-body-sm text-ink-secondary">{a.description}</p>
              <p className="mt-auto flex flex-wrap gap-x-3 gap-y-1 pt-1 text-caption text-ink-secondary">
                <span className="inline-flex items-center gap-1">
                  <MapPin className="size-3.5" aria-hidden="true" />
                  {a.area}
                </span>
                <span className="inline-flex items-center gap-1">
                  <Clock className="size-3.5" aria-hidden="true" />
                  {duration(a.minutes)}
                </span>
              </p>
            </li>
          ))}
        </ul>
      </Container>
    </section>
  );
}

/** Published guides and FAQs about this destination; nothing when there are none. */
export function DestinationContent({ destination }: { destination: Destination }) {
  const params = { destination: destination.slug, pageSize: 20 };
  const query = useQuery({
    queryKey: contentKeys.list(params),
    queryFn: ({ signal }) => listPublishedContent(params, signal),
  });
  const items = query.data?.items ?? [];
  const guides = items.filter(
    (c) => c.type === 'guide' || c.type === 'article' || c.type === 'tip',
  );
  const faqs = items.filter((c) => c.type === 'faq' && c.body);
  if (guides.length === 0 && faqs.length === 0) return null;
  return (
    <section
      aria-label={`Guides and questions about ${destination.name}`}
      className="border-t border-line py-section-sm"
    >
      <Container size="wide" className="flex flex-col gap-10">
        {guides.length ? (
          <div className="flex flex-col gap-4">
            <Eyebrow>From the Wayora team</Eyebrow>
            <h2 className="text-heading-2">Guides to {destination.name}</h2>
            <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {guides.map((g) => (
                <li key={g.slug} className="min-w-0">
                  <ContentCard item={g} />
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {faqs.length ? (
          <div className="flex max-w-3xl flex-col gap-4">
            <h2 className="text-heading-2">Questions about {destination.name}</h2>
            <Accordion type="multiple">
              {faqs.map((f) => (
                <AccordionItem key={f.slug} value={f.slug}>
                  <AccordionTrigger>{f.title}</AccordionTrigger>
                  <AccordionContent>
                    <ContentBody blocks={f.body ?? []} />
                  </AccordionContent>
                </AccordionItem>
              ))}
            </Accordion>
          </div>
        ) : null}
      </Container>
    </section>
  );
}
