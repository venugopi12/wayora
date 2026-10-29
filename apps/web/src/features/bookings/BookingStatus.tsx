import { RotateCw, Store } from 'lucide-react';
import type { Booking, TravelDocumentType } from '@wayora/contracts';
import { Alert, Badge, Button } from '@wayora/ui';
import { Panel } from '../account/AccountShell';
import { money } from '../search/cards/shared';
import { OPEN_RESERVATION, REFUND_LABEL, RESERVATION_LABEL, formatMoment } from './format';

/*
 * Where a booking stands, one line per separate lifecycle (Phase 23,
 * docs/bookings.md#web): the booking, the supplier reservation, payment,
 * tickets and vouchers, cancellation and refund. Every explanation comes
 * from the API (Wayora's own words); nothing here infers a supplier state,
 * invents a reference or offers an action the API doesn't allow.
 */

const DOCUMENT_LABEL: Record<TravelDocumentType, string> = {
  ticket: 'Ticket',
  voucher: 'Voucher',
  itinerary: 'Itinerary',
};

/** "Supplier booking": a real reservation request, never labelled live or instant. */
export function SupplierBookingBadge() {
  return (
    <Badge size="sm" tone="neutral" icon={<Store />}>
      Supplier booking
    </Badge>
  );
}

/** The supplier reservation's headline, for supplier bookings only. */
export function ReservationAlert({ booking }: { booking: Booking }) {
  const r = booking.reservation;
  if (r.kind !== 'supplier' || !r.state) return null;
  if (r.state === 'failed') {
    return (
      <Alert tone="danger" title="Not booked">
        {r.explanation}
      </Alert>
    );
  }
  if (r.priceMismatch) {
    return (
      <Alert tone="warning" title="Confirmed at a different price">
        {r.explanation}
      </Alert>
    );
  }
  if (OPEN_RESERVATION.includes(r.state)) {
    return (
      <Alert
        tone={r.needsAttention ? 'warning' : 'info'}
        title={
          r.state === 'cancellation-pending'
            ? 'Cancellation not confirmed yet'
            : 'Not confirmed yet'
        }
      >
        {r.explanation}
      </Alert>
    );
  }
  return null;
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="contents">
      <dt className="text-ink-secondary">{label}</dt>
      <dd className="flex min-w-0 flex-col gap-1">{children}</dd>
    </div>
  );
}

function Explained({
  badge,
  text,
}: {
  badge: { label: string; tone: React.ComponentProps<typeof Badge>['tone'] };
  text: string;
}) {
  return (
    <>
      <span>
        <Badge size="sm" tone={badge.tone}>
          {badge.label}
        </Badge>
      </span>
      <span className="text-ink-secondary">{text}</span>
    </>
  );
}

export function BookingStatusPanel({
  booking,
  onCheck,
  checking,
}: {
  booking: Booking;
  /** Re-reads the booking (the API checks a due reservation with the supplier). */
  onCheck: () => void;
  checking: boolean;
}) {
  const r = booking.reservation;
  const supplier = r.kind === 'supplier';
  const open = supplier && r.state !== null && OPEN_RESERVATION.includes(r.state);
  const payment = supplier
    ? `Wayora takes no payment for this booking: you pay ${booking.providerName} under its own terms.`
    : booking.payment.mode === 'none'
      ? 'No payment is taken on Wayora for this booking.'
      : booking.payment.state === 'paid' || booking.payment.state === 'refund-required'
        ? 'Paid with a demo payment. No real money was charged.'
        : booking.payment.state === 'processing'
          ? 'A demo payment is in progress.'
          : booking.payment.state === 'unpaid'
            ? 'Waiting for a demo payment.'
            : 'Not paid; nothing was charged.';
  return (
    <Panel
      title="Booking status"
      description="Each part of a booking has its own status. Only a supplier can confirm a reservation."
    >
      <dl className="grid gap-x-8 gap-y-4 text-body-sm sm:grid-cols-[10rem_minmax(0,1fr)]">
        <Row label="Supplier reservation">
          {supplier && r.state ? (
            <>
              <Explained badge={RESERVATION_LABEL[r.state]} text={r.explanation} />
              {r.supplierReference ? (
                <span>
                  {booking.providerName} reference{' '}
                  <span className="font-mono text-ink">{r.supplierReference}</span>
                  {r.confirmedAt ? (
                    <span className="text-ink-secondary">
                      {' '}
                      · confirmed {formatMoment(r.confirmedAt)}
                    </span>
                  ) : null}
                </span>
              ) : null}
            </>
          ) : (
            <span className="text-ink-secondary">{r.explanation}</span>
          )}
        </Row>
        <Row label="Payment">
          <span className="text-ink-secondary">{payment}</span>
        </Row>
        <Row label="Tickets and vouchers">
          {booking.documents.items.length > 0 ? (
            <ul className="flex flex-col gap-1">
              {booking.documents.items.map((d) => (
                <li key={`${d.type}-${d.reference}`}>
                  {DOCUMENT_LABEL[d.type]} <span className="font-mono text-ink">{d.reference}</span>
                  {d.travellerName ? (
                    <span className="text-ink-secondary"> · {d.travellerName}</span>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
          <span className="text-ink-secondary">{booking.documents.explanation}</span>
        </Row>
        <Row label="Cancellation">
          <span className="text-ink-secondary">{booking.cancellation.explanation}</span>
        </Row>
        <Row label="Refund">
          {booking.refund.state === 'not-applicable' ? (
            <span className="text-ink-secondary">{booking.refund.explanation}</span>
          ) : (
            <Explained
              badge={REFUND_LABEL[booking.refund.state]}
              text={`${booking.refund.amount ? `${money(booking.refund.amount)}: ` : ''}${booking.refund.explanation}`}
            />
          )}
        </Row>
      </dl>
      {open ? (
        <div className="mt-5 flex flex-wrap items-center gap-3 border-t border-line pt-4">
          <Button variant="secondary" size="sm" onClick={onCheck} loading={checking}>
            <RotateCw aria-hidden="true" />
            Check again
          </Button>
          <p className="text-caption text-ink-secondary">
            This page checks again on its own. Checking never sends a second booking request.
          </p>
        </div>
      ) : null}
    </Panel>
  );
}
