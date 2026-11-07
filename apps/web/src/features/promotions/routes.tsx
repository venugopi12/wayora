import { useQuery } from '@tanstack/react-query';
import { ArrowRight, Check, Copy, RotateCw, Tag } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import type { PromotionOffer, TravelCategorySlug } from '@wayora/contracts';
import {
  Alert,
  Badge,
  Button,
  Container,
  EmptyState,
  ErrorState,
  PageHeader,
  Skeleton,
  cn,
  interaction,
} from '@wayora/ui';
import { useDocumentTitle } from '../../hooks/useDocumentTitle';
import { ApiClientError } from '../../lib/api-client';
import { getPromotions } from '../../services/promotions';
import { INFO_PATHS } from '../navigation/config';
import { categoriesText, conditions, discountText, validUntil } from './format';
import { promotionKeys } from './keys';
import { promotionsMeta } from '../seo/pages';
import { usePageMeta } from '../seo/SeoProvider';

/*
 * Promotion discovery (docs/promotions.md#web): offers that are active and
 * running now, straight from the API. No invented deals, no countdowns, no
 * claim that anyone is eligible: eligibility is checked at checkout.
 */

export function useOffers(category?: TravelCategorySlug) {
  return useQuery({
    queryKey: promotionKeys.offers(category ?? 'all'),
    queryFn: ({ signal }) => getPromotions(category, signal),
    staleTime: 60_000,
  });
}

function CopyCode({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <span className="inline-flex items-center gap-2">
      <code className="rounded-md border border-dashed border-brand-300 bg-brand-soft px-2.5 py-1 font-mono text-body-sm font-semibold tracking-wide text-brand-ink">
        {code}
      </code>
      <Button
        variant="ghost"
        size="sm"
        aria-label={copied ? `Code ${code} copied` : `Copy code ${code}`}
        onClick={() => {
          void navigator.clipboard
            ?.writeText(code)
            .then(() => setCopied(true))
            .catch(() => setCopied(false));
        }}
      >
        {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
        {copied ? 'Copied' : 'Copy'}
      </Button>
    </span>
  );
}

export function OfferCard({
  offer,
  headingLevel = 'h3',
}: {
  offer: PromotionOffer;
  headingLevel?: 'h2' | 'h3';
}) {
  const Heading = headingLevel;
  return (
    <article className="flex h-full min-w-0 flex-col gap-3 rounded-xl border border-line bg-card p-5 shadow-xs">
      <div className="flex flex-wrap items-center gap-2">
        <Badge size="sm" tone="brand" icon={<Tag />}>
          {discountText(offer)}
        </Badge>
        {offer.personal ? (
          <Badge size="sm" tone="success">
            For you
          </Badge>
        ) : null}
        {offer.kind === 'automatic' ? (
          <Badge size="sm" tone="neutral">
            No code needed
          </Badge>
        ) : null}
      </div>
      <Heading className="text-title text-ink">{offer.name}</Heading>
      <p className="text-body-sm text-ink-secondary">{offer.description}</p>
      <ul className="flex flex-col gap-1 text-body-sm text-ink-secondary">
        {conditions(offer).map((c) => (
          <li key={c} className="flex items-start gap-2">
            <Check className="mt-0.5 size-4 shrink-0 text-brand" aria-hidden="true" />
            {c}
          </li>
        ))}
      </ul>
      <p className="text-caption text-ink-secondary">{validUntil(offer.endsAt)} (India time)</p>
      {offer.code ? <CopyCode code={offer.code} /> : null}
      <details className="group mt-auto rounded-md text-body-sm">
        <summary className="cursor-pointer font-semibold text-brand-ink hover:underline">
          Terms and conditions
        </summary>
        <p className="mt-2 whitespace-pre-line text-ink-secondary">{offer.terms}</p>
        <p className="mt-2 text-caption text-ink-secondary">
          Discounts apply to Wayora demo bookings: no real money moves. Whether a booking qualifies
          is checked when you apply the offer at payment.
        </p>
      </details>
    </article>
  );
}

export function OffersRoute() {
  useDocumentTitle('Offers and coupons');
  usePageMeta(promotionsMeta());
  const offers = useOffers();
  return (
    <Container className="flex flex-col gap-8 py-section-sm">
      <PageHeader
        headingLevel="h1"
        eyebrow="Offers"
        title="Offers and coupons"
        description="Promotions running now. Automatic offers apply at payment when your booking qualifies; coupons need their code."
      />
      <Alert tone="info" role="none" title="How offers work">
        Each offer lists what it applies to and when it ends. Wayora checks whether your booking
        qualifies (category, amount, limits) when you apply it at payment, and shows the exact
        discount before you pay. Offers never change the original price.
      </Alert>
      {offers.isPending ? (
        <div
          role="status"
          aria-label="Loading offers"
          className="grid gap-4 md:grid-cols-2 lg:grid-cols-3"
        >
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-64 rounded-xl" />
          ))}
        </div>
      ) : offers.isError ? (
        <ErrorState
          title="We couldn’t load offers"
          description="Check your connection, then try again."
          reference={
            offers.error instanceof ApiClientError
              ? (offers.error.requestId ?? undefined)
              : undefined
          }
          action={
            <Button variant="secondary" onClick={() => void offers.refetch()}>
              <RotateCw aria-hidden="true" />
              Try again
            </Button>
          }
        />
      ) : offers.data.length === 0 ? (
        <div className="rounded-xl border border-dashed border-line-strong bg-card">
          <EmptyState
            size="page"
            icon={<Tag />}
            title="No offers right now"
            description="When Wayora runs a promotion, it will be listed here with its terms."
          />
        </div>
      ) : (
        <ul aria-label="Current offers" className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {offers.data.map((o) => (
            <li key={o.id} className="min-w-0">
              <OfferCard offer={o} headingLevel="h2" />
            </li>
          ))}
        </ul>
      )}
    </Container>
  );
}

/** Homepage: up to three running offers; nothing at all when there are none. */
export function HomeOffers() {
  const offers = useOffers();
  if (!offers.data || offers.data.length === 0) return null;
  const shown = offers.data.slice(0, 3);
  return (
    <section aria-labelledby="home-offers-title" className="pb-section">
      <Container size="wide">
        <PageHeader
          size="section"
          headingLevel="h2"
          id="home-offers-title"
          eyebrow="Offers"
          title="Running now"
          description={`${categoriesText([...new Set(shown.flatMap((o) => o.categories))])}: promotions from Wayora, with their terms. Eligibility is checked at payment.`}
          actions={
            <Link
              to={INFO_PATHS.offers}
              className="group inline-flex shrink-0 items-center gap-1.5 rounded-md text-label text-brand-ink hover:underline hover:underline-offset-4"
            >
              All offers
              <ArrowRight aria-hidden="true" className={cn('size-4', interaction.iconNudge)} />
            </Link>
          }
        />
        <ul aria-label="Offers running now" className="mt-section-head grid gap-4 md:grid-cols-3">
          {shown.map((o) => (
            <li key={o.id} className="min-w-0">
              <OfferCard offer={o} />
            </li>
          ))}
        </ul>
      </Container>
    </section>
  );
}
