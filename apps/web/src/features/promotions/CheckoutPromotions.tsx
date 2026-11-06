import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RotateCw, Tag, X } from 'lucide-react';
import { useId, useState, type FormEvent, type ReactNode } from 'react';
import { Link } from 'react-router';
import type { Booking, BookingPricing } from '@wayora/contracts';
import { Alert, Badge, Button, Field, Input, Skeleton } from '@wayora/ui';
import { ApiClientError } from '../../lib/api-client';
import { applyCoupon, getBookingPricing, removeCoupon } from '../../services/promotions';
import { Panel } from '../account/AccountShell';
import { bookingKeys } from '../bookings/keys';
import { INFO_PATHS } from '../navigation/config';
import { rewardKeys } from '../rewards/keys';
import { formatTime, money } from './format';
import { promotionKeys } from './keys';

/*
 * Promotions at checkout (docs/promotions.md#checkout): a coupon field, the
 * promotions the server applied, and the authoritative price breakdown. The
 * client sends only the code; every amount shown comes back from the server.
 */

export function usePricing(reference: string) {
  return useQuery({
    queryKey: promotionKeys.pricing(reference),
    queryFn: ({ signal }) => getBookingPricing(reference, signal),
  });
}

/** After any price change: the booking (amount due), the breakdown and the rewards quote. */
export function useRefreshPrices(reference: string) {
  const queryClient = useQueryClient();
  return (pricing?: BookingPricing) => {
    if (pricing) queryClient.setQueryData(promotionKeys.pricing(reference), pricing);
    void queryClient.invalidateQueries({ queryKey: promotionKeys.pricing(reference) });
    void queryClient.invalidateQueries({ queryKey: bookingKeys.detail(reference) });
    void queryClient.invalidateQueries({ queryKey: rewardKeys.booking(reference) });
    void queryClient.invalidateQueries({ queryKey: rewardKeys.summary });
  };
}

const messageOf = (error: unknown) =>
  error instanceof ApiClientError ? error.message : 'Something went wrong. Try again.';

export function CheckoutPromotions({ booking }: { booking: Booking }) {
  const reference = booking.reference;
  const pricing = usePricing(reference);
  const refresh = useRefreshPrices(reference);
  const id = useId();
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');

  const apply = useMutation({
    mutationFn: (value: string) => applyCoupon(reference, value),
    onSuccess: (data) => {
      refresh(data);
      setCode('');
      const added = data.promotions.find((p) => p.kind === 'coupon');
      setAnnouncement(
        added
          ? `Coupon ${added.code} applied: ${money(added.discount)} off. You pay ${money(data.payable!)}.`
          : 'Coupon applied.',
      );
    },
    onError: (e) => {
      setError(messageOf(e));
      refresh();
    },
  });
  const remove = useMutation({
    mutationFn: () => removeCoupon(reference),
    onSuccess: (data) => {
      refresh(data);
      setAnnouncement(`Coupon removed. You pay ${money(data.payable!)}.`);
    },
    onError: (e) => setError(messageOf(e)),
  });
  const busy = apply.isPending || remove.isPending;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    if (!code.trim()) return setError('Enter a coupon code.');
    if (busy) return;
    apply.mutate(code.trim());
  };

  return (
    <Panel
      title="Offers and coupons"
      description="Automatic offers are applied for you; enter a code if you have one. Wayora works out every discount."
    >
      <p role="status" aria-live="polite" className="sr-only">
        {announcement}
      </p>
      {pricing.isPending ? (
        <Skeleton className="h-20 rounded-lg" />
      ) : pricing.isError ? (
        <div className="flex flex-wrap items-center gap-3 text-body-sm text-ink-secondary">
          We couldn’t load offers for this booking. You can still pay the amount shown.
          <Button variant="ghost" size="sm" onClick={() => void pricing.refetch()}>
            <RotateCw aria-hidden="true" />
            Load offers again
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {pricing.data.notice ? (
            <Alert tone="warning" title="Your price changed">
              {pricing.data.notice.message}
            </Alert>
          ) : null}
          {pricing.data.promotions.length > 0 ? (
            <ul aria-label="Applied offers" className="flex flex-col gap-2">
              {pricing.data.promotions.map((p) => (
                <li
                  key={p.promotionId}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-success-soft px-4 py-3"
                >
                  <span className="flex min-w-0 items-start gap-2 text-body-sm">
                    <Tag className="mt-0.5 size-4 shrink-0 text-success-ink" aria-hidden="true" />
                    <span className="min-w-0">
                      <span className="font-semibold text-ink">
                        {p.kind === 'coupon' ? `Coupon ${p.code}` : p.name}
                      </span>
                      {p.kind === 'automatic' ? (
                        <Badge size="sm" tone="success" className="ml-2">
                          Applied automatically
                        </Badge>
                      ) : null}
                      <span className="block text-ink-secondary">{p.description}</span>
                      {p.reservedUntil ? (
                        <span className="block text-caption text-ink-secondary">
                          Held for you until {formatTime(p.reservedUntil)} (your payment window).
                        </span>
                      ) : null}
                    </span>
                  </span>
                  <span className="flex items-center gap-2">
                    <span className="numeric font-semibold text-success-ink">
                      −{money(p.discount)}
                    </span>
                    {p.kind === 'coupon' && pricing.data.canChangePromotions ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busy}
                        loading={remove.isPending}
                        onClick={() => {
                          setError(null);
                          remove.mutate();
                        }}
                        aria-label={`Remove coupon ${p.code}`}
                      >
                        <X aria-hidden="true" />
                        Remove
                      </Button>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
          {pricing.data.canChangePromotions ? (
            <form noValidate onSubmit={submit} className="flex flex-col gap-2">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
                <Field
                  label="Coupon code"
                  error={error ?? undefined}
                  className="sm:max-w-xs sm:flex-1"
                >
                  <Input
                    value={code}
                    autoComplete="off"
                    autoCapitalize="characters"
                    spellCheck={false}
                    maxLength={40}
                    onChange={(e) => {
                      setCode(e.target.value);
                      if (error) setError(null);
                    }}
                  />
                </Field>
                <Button type="submit" variant="secondary" loading={apply.isPending} disabled={busy}>
                  Apply
                </Button>
              </div>
              <p id={`${id}-hint`} className="text-caption text-ink-secondary">
                One coupon per booking. Changing it gives back any points or travel credit you
                applied, so you can apply them to the new price.{' '}
                <Link
                  to={INFO_PATHS.offers}
                  className="font-semibold text-brand-ink hover:underline"
                >
                  See current offers
                </Link>
              </p>
            </form>
          ) : pricing.data.promotions.length === 0 ? (
            <p className="text-body-sm text-ink-secondary">{pricing.data.reason}</p>
          ) : null}
        </div>
      )}
    </Panel>
  );
}

/** The server's price breakdown, in its order: original → offers → points → credit → to pay. */
export function PriceBreakdown({
  reference,
  fallback = null,
}: {
  reference: string;
  /** Shown while the breakdown can't be loaded (the booking's own figures). */
  fallback?: ReactNode;
}) {
  const pricing = usePricing(reference);
  if (!pricing.data?.original || !pricing.data.payable) return <>{fallback}</>;
  const p = pricing.data;
  const payable = pricing.data.payable;
  const row = 'flex items-baseline justify-between gap-4';
  const hasChanges = p.promotions.length > 0 || p.points || p.credit;
  if (!hasChanges) return null;
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-line bg-card p-5 text-body-sm shadow-xs">
      <dl aria-label="Price breakdown" className="flex flex-col gap-2">
        <div className={row}>
          <dt className="text-ink-secondary">Original price</dt>
          <dd className="numeric">{money(p.original!)}</dd>
        </div>
        {p.promotions.map((x) => (
          <div key={x.promotionId} className={row}>
            <dt className="text-ink-secondary">
              {x.kind === 'coupon' ? `Coupon ${x.code}` : x.name}
            </dt>
            <dd className="numeric text-success-ink">−{money(x.discount)}</dd>
          </div>
        ))}
        {p.points ? (
          <div className={row}>
            <dt className="text-ink-secondary">
              Points ({p.points.points.toLocaleString('en-IN')})
            </dt>
            <dd className="numeric text-success-ink">−{money(p.points.amount)}</dd>
          </div>
        ) : null}
        {p.credit ? (
          <div className={row}>
            <dt className="text-ink-secondary">Travel credit</dt>
            <dd className="numeric text-success-ink">−{money(p.credit)}</dd>
          </div>
        ) : null}
        <div className={`${row} border-t border-line pt-2`}>
          <dt className="font-semibold">To pay</dt>
          <dd className="numeric text-heading-3">{money(payable)}</dd>
        </div>
      </dl>
      {p.demo ? (
        <p className="text-caption text-ink-secondary">
          Demo booking: discounts apply to the demo price; no real money moves.
        </p>
      ) : null}
    </div>
  );
}
