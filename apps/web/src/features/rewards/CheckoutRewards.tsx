import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Gift, RotateCw } from 'lucide-react';
import { useId, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import type { Booking, BookingRewards } from '@wayora/contracts';
import { Alert, Button, Checkbox, Field, Input, Skeleton, minorToDecimalString } from '@wayora/ui';
import { ApiClientError } from '../../lib/api-client';
import {
  applyBookingRewards,
  getBookingRewards,
  removeBookingRewards,
} from '../../services/rewards';
import { Panel } from '../account/AccountShell';
import { bookingKeys } from '../bookings/keys';
import { ACCOUNT_PATHS } from '../navigation/config';
import { money, points } from './format';
import { promotionKeys } from '../promotions/keys';
import { rewardKeys } from './keys';

/*
 * Rewards at checkout (docs/rewards.md#checkout). Shows what the server says
 * this booking can take, lets the customer choose within it, and asks for an
 * explicit confirmation. The server recalculates and validates everything;
 * the amount to pay always comes back from it (and the booking).
 */

/** "1,234.5" (whole units, up to 2 decimals) → minor units, without floats; null if invalid. */
export function toMinor(input: string): bigint | null {
  const v = input.replace(/[,\s₹]/g, '');
  if (v === '') return 0n;
  const m = /^(\d{1,12})(?:\.(\d{1,2}))?$/.exec(v);
  if (!m) return null;
  return BigInt(m[1]!) * 100n + BigInt((m[2] ?? '').padEnd(2, '0'));
}

const messageOf = (error: unknown) =>
  error instanceof ApiClientError ? error.message : 'Something went wrong. Try again.';

export function CheckoutRewards({ booking }: { booking: Booking }) {
  const reference = booking.reference;
  const quote = useQuery({
    queryKey: rewardKeys.booking(reference),
    queryFn: ({ signal }) => getBookingRewards(reference, signal),
  });

  return (
    <Panel
      title="Rewards"
      description="Use demo points or travel credit to pay part of this demo booking. Wayora works out the value; you confirm before anything is used."
    >
      {quote.isPending ? (
        <Skeleton className="h-28 rounded-lg" />
      ) : quote.isError ? (
        <div className="flex flex-wrap items-center gap-3 text-body-sm text-ink-secondary">
          We couldn’t load your rewards. You can still pay without them.
          <Button variant="ghost" size="sm" onClick={() => void quote.refetch()}>
            <RotateCw aria-hidden="true" />
            Try again
          </Button>
        </div>
      ) : (
        <RewardsForm
          key={JSON.stringify(quote.data.applied)}
          reference={reference}
          quote={quote.data}
        />
      )}
    </Panel>
  );
}

function RewardsForm({ reference, quote }: { reference: string; quote: BookingRewards }) {
  const queryClient = useQueryClient();
  const id = useId();
  const applied = quote.applied;
  const [pointsText, setPointsText] = useState(applied ? String(applied.points) : '');
  const [creditText, setCreditText] = useState(
    applied && applied.creditAmount.amountMinor !== '0'
      ? minorToDecimalString(applied.creditAmount.amountMinor, 2)
      : '',
  );
  const [confirmed, setConfirmed] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');

  const refresh = (data: BookingRewards) => {
    queryClient.setQueryData(rewardKeys.booking(reference), data);
    void queryClient.invalidateQueries({ queryKey: bookingKeys.detail(reference) });
    void queryClient.invalidateQueries({ queryKey: rewardKeys.summary });
    // The price breakdown shows points and credit too (Phase 26).
    void queryClient.invalidateQueries({ queryKey: promotionKeys.pricing(reference) });
  };
  const apply = useMutation({
    mutationFn: (body: { points: number; creditAmountMinor: string }) =>
      applyBookingRewards(reference, body),
    onSuccess: (data) => {
      refresh(data);
      setAnnouncement(
        data.applied ? `Rewards applied. ${money(data.payable!)} left to pay.` : 'Rewards removed.',
      );
    },
    onError: (error) => {
      setProblem(messageOf(error));
      void queryClient.invalidateQueries({ queryKey: rewardKeys.booking(reference) });
    },
  });
  const remove = useMutation({
    mutationFn: () => removeBookingRewards(reference),
    onSuccess: (data) => {
      refresh(data);
      setAnnouncement('Rewards removed. They are back in your account.');
    },
    onError: (error) => setProblem(messageOf(error)),
  });
  const busy = apply.isPending || remove.isPending;
  const currency = quote.total?.currency ?? 'INR';
  const hasAny =
    quote.points.balance > 0 || BigInt(quote.credit.available?.amountMinor ?? '0') > 0n;

  if (applied?.status === 'consumed') {
    return (
      <p className="text-body-sm">
        {applied.points > 0 ? `${points(applied.points)} ` : ''}
        {applied.points > 0 && applied.creditAmount.amountMinor !== '0' ? 'and ' : ''}
        {applied.creditAmount.amountMinor !== '0'
          ? `${money(applied.creditAmount)} of credit `
          : ''}
        went towards this booking ({money(applied.total)} off).
      </p>
    );
  }

  if (!applied && (!quote.available || !hasAny)) {
    return (
      <p className="text-body-sm text-ink-secondary">
        {hasAny ? quote.reason : 'You don’t have any points or travel credit to use yet.'}{' '}
        <Link to={ACCOUNT_PATHS.rewards} className="font-semibold text-brand-ink hover:underline">
          About rewards
        </Link>
      </p>
    );
  }

  // A preview from the server's point value (integer maths); the server confirms it on apply.
  const chosenPoints = /^\d{1,8}$/.test(pointsText.trim())
    ? BigInt(pointsText.trim())
    : pointsText.trim() === ''
      ? 0n
      : null;
  const chosenCredit = toMinor(creditText);
  const pointsValue =
    chosenPoints !== null && quote.points.value
      ? chosenPoints * BigInt(quote.points.value.amountMinor)
      : null;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setProblem(null);
    if (chosenPoints === null) return setProblem('Enter a whole number of points.');
    if (chosenCredit === null) return setProblem('Enter a credit amount like 250 or 250.50.');
    if (chosenPoints === 0n && chosenCredit === 0n)
      return setProblem('Choose points or credit to use.');
    if (!confirmed) return setProblem('Confirm that you want to use these rewards.');
    apply.mutate({ points: Number(chosenPoints), creditAmountMinor: chosenCredit.toString() });
  };

  return (
    <div className="flex flex-col gap-4">
      <p role="status" aria-live="polite" className="sr-only">
        {announcement}
      </p>
      {applied ? (
        <div className="flex flex-col gap-3 rounded-lg bg-brand-soft p-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="flex items-start gap-2 text-body-sm text-brand-ink">
            <Gift className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <span>
              Applied: <strong>{money(applied.total)} off</strong>
              {applied.points > 0 ? ` (${points(applied.points)}` : ' ('}
              {applied.points > 0 && applied.creditAmount.amountMinor !== '0' ? ' + ' : ''}
              {applied.creditAmount.amountMinor !== '0'
                ? `${money(applied.creditAmount)} credit`
                : ''}
              ). You pay {money(quote.payable!)}.
            </span>
          </p>
          <Button
            variant="secondary"
            size="sm"
            loading={remove.isPending}
            disabled={busy}
            onClick={() => remove.mutate()}
          >
            Remove
          </Button>
        </div>
      ) : null}
      {quote.available ? (
        <form
          noValidate
          onSubmit={submit}
          aria-describedby={`${id}-limits`}
          className="flex flex-col gap-4"
        >
          <p id={`${id}-limits`} className="text-body-sm text-ink-secondary">
            You have {points(quote.points.balance)}
            {quote.points.value ? ` (1 point = ${money(quote.points.value)})` : ''}
            {quote.credit.available && quote.credit.available.amountMinor !== '0'
              ? ` and ${money(quote.credit.available)} of travel credit`
              : ''}
            .{' '}
            {quote.points.max > 0
              ? `On this booking you can use ${points(quote.points.min)} to ${points(quote.points.max)}.`
              : quote.points.balance > 0
                ? `That’s below the ${points(quote.points.min)} needed to use points here.`
                : ''}
          </p>
          <div className="grid gap-4 sm:grid-cols-2">
            {quote.points.max > 0 ? (
              <Field
                label="Points to use"
                hint={
                  pointsValue !== null && pointsValue > 0n
                    ? `≈ ${money({ amountMinor: pointsValue.toString(), currency })} off`
                    : `Up to ${points(quote.points.max)}`
                }
              >
                <Input
                  inputMode="numeric"
                  value={pointsText}
                  placeholder="0"
                  onChange={(e) => {
                    setPointsText(e.target.value);
                    setConfirmed(false);
                  }}
                />
              </Field>
            ) : null}
            {quote.credit.max && quote.credit.max.amountMinor !== '0' ? (
              <Field
                label={`Travel credit to use (${currency})`}
                hint={`Up to ${money(quote.credit.max)} with no points; less when points are used`}
              >
                <Input
                  inputMode="decimal"
                  value={creditText}
                  placeholder="0"
                  onChange={(e) => {
                    setCreditText(e.target.value);
                    setConfirmed(false);
                  }}
                />
              </Field>
            ) : null}
          </div>
          {quote.points.max > 0 ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="self-start"
              onClick={() => {
                setPointsText(String(quote.points.max));
                setConfirmed(false);
              }}
            >
              Use the most points allowed
            </Button>
          ) : null}
          <Checkbox
            label="Use these rewards on this booking. If it’s cancelled or expires, they come back."
            checked={confirmed}
            onChange={(e) => setConfirmed(e.target.checked)}
          />
          {problem ? (
            <Alert tone="danger" title="Rewards not applied">
              {problem}
            </Alert>
          ) : null}
          <Button
            type="submit"
            variant="secondary"
            className="self-start"
            loading={apply.isPending}
            disabled={busy}
          >
            {applied ? 'Update rewards' : 'Apply rewards'}
          </Button>
        </form>
      ) : (
        <p className="text-body-sm text-ink-secondary">{quote.reason}</p>
      )}
    </div>
  );
}
