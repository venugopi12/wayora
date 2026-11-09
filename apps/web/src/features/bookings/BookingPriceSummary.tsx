import type { SearchPrice } from '@wayora/contracts';
import { cn } from '@wayora/ui';
import { useEditingOnTouch } from '../navigation/MobileTabBar';
import { UNIT_LABEL, money } from '../search/cards/shared';

/**
 * The price of a booking, everywhere it is shown (review, confirmation,
 * booking details), from the same server-side price so the three always
 * agree. Only what the offer contains is shown: no invented taxes, fees or
 * discounts. Amounts are formatted from integer minor units.
 */
export function BookingPriceSummary({
  price,
  partyLabel,
  demo,
  title = 'Price',
  className,
}: {
  price: SearchPrice | null;
  /** e.g. "2 passengers". */
  partyLabel: string;
  demo: boolean;
  title?: string;
  className?: string;
}) {
  const id = `price-summary-${title.toLowerCase().replace(/\W+/g, '-')}`;
  const row = 'flex items-baseline justify-between gap-4';
  return (
    <section
      aria-labelledby={id}
      className={cn(
        'flex flex-col gap-4 rounded-xl border border-line bg-card p-5 shadow-xs',
        className,
      )}
    >
      <h2 id={id} className="text-title">
        {title}
      </h2>
      {price === null ? (
        <p className="text-body-sm text-ink-secondary">This offer has no price.</p>
      ) : (
        <dl className="flex flex-col gap-2.5 text-body-sm">
          <div className={row}>
            <dt className="text-ink-secondary">For</dt>
            <dd className="text-ink">{partyLabel}</dd>
          </div>
          {price.kind === 'total' && price.perUnit ? (
            <div className={row}>
              <dt className="text-ink-secondary">Price {UNIT_LABEL[price.perUnit.unit]}</dt>
              <dd className="numeric text-ink">{money(price.perUnit.amount)}</dd>
            </div>
          ) : null}
          <div className={row}>
            <dt className="text-ink-secondary">Taxes and fees</dt>
            <dd className="text-right text-ink-secondary italic">Not itemised in this offer</dd>
          </div>
          <div className={cn(row, 'border-t border-line pt-3')}>
            <dt className="font-semibold text-ink">
              {price.kind === 'range' ? 'Estimated fare' : 'Total'}
            </dt>
            <dd className="numeric text-heading-3 text-ink">
              {price.kind === 'range'
                ? `${money(price.min)} – ${money(price.max)}`
                : money(price.total)}
            </dd>
          </div>
        </dl>
      )}
      <p className="text-caption text-ink-secondary">
        {price?.kind === 'range'
          ? 'An estimate, not a quote: a real operator would set the final fare after the ride. '
          : ''}
        {demo
          ? 'Demo price: illustrative, not a supplier guarantee. Nothing is charged.'
          : 'Prices can change until a booking is confirmed.'}
      </p>
    </section>
  );
}

/**
 * Phones and small tablets (below `lg`, where the summary sits under the
 * form): the total stays visible at the bottom edge while filling in the
 * steps, with a link to the full price details. Information only: the
 * step's own buttons stay in the form, so nothing important is hidden behind
 * it, and the page reserves its height (`pb-24` on the checkout container).
 */
export function MobilePriceBar({
  price,
  demo,
  detailsId,
}: {
  price: SearchPrice | null;
  demo: boolean;
  /** id of the full summary to jump to. */
  detailsId: string;
}) {
  // Out of the way while the on-screen keyboard is up.
  const editing = useEditingOnTouch();
  if (price === null || editing) return null;
  return (
    <div className="fixed inset-x-0 bottom-0 z-(--z-sticky) border-t border-line bg-page/95 pb-[env(safe-area-inset-bottom)] backdrop-blur-sm lg:hidden">
      <div className="mx-auto flex max-w-3xl items-center justify-between gap-4 px-4 py-3">
        <p className="flex flex-col">
          <span className="text-caption text-ink-secondary">
            {price.kind === 'range' ? 'Estimated fare' : 'Total'}
            {demo ? ' (demo)' : ''}
          </span>
          <span className="numeric text-title text-ink">
            {price.kind === 'range'
              ? `${money(price.min)} – ${money(price.max)}`
              : money(price.total)}
          </span>
        </p>
        <a
          href={`#${detailsId}`}
          className="inline-flex min-h-11 items-center rounded-md px-3 text-label text-brand-ink underline-offset-4 hover:underline"
        >
          Price details
        </a>
      </div>
    </div>
  );
}
