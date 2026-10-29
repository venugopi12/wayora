import { useMutation, useQueryClient } from '@tanstack/react-query';
import { RotateCw } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import type { AdminBookingDetail, AdminReservation } from '@wayora/contracts';
import { Alert, Badge, Button, Field, Input, Select, Textarea, useToast } from '@wayora/ui';
import { ApiClientError } from '../../lib/api-client';
import { adminApi } from '../../services/admin';
import { RESERVATION_LABEL } from '../bookings/format';
import { useCan } from './AdminLayout';
import { formatCount, formatUtc, humanize } from './format';
import { adminKeys } from './keys';
import { DetailList, Note, Section } from './ui';

/*
 * A supplier booking's reservation, for staff (Phase 23,
 * docs/admin.md#supplier-reservations). Shows what recovery knows: state,
 * attempts, the last correlation id, the normalized error and whether the
 * outcome is ambiguous. Admins (admin.reservations.manage) may ask for one
 * status lookup, or record an outcome they confirmed with the supplier.
 * Neither ever sends a reservation; the API enforces all of it.
 */

const yesNo = (v: boolean) => (v ? 'Yes' : 'No');

export function ReservationPanel({
  reference,
  reservation: r,
}: {
  reference: string;
  reservation: AdminReservation;
}) {
  const canManage = useCan('admin.reservations.manage');
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const update = (detail: AdminBookingDetail) =>
    queryClient.setQueryData(adminKeys.view('booking', reference), detail);
  const recheck = useMutation({
    mutationFn: () => adminApi.recheckReservation(reference),
    onSuccess: (detail) => {
      update(detail);
      toast({ tone: 'success', title: 'Checked with the supplier' });
    },
  });
  const label = RESERVATION_LABEL[r.status];
  return (
    <Section title="Supplier reservation">
      <div className="flex flex-col gap-4">
        {r.needsAttention ? (
          <Alert tone="warning" title="Needs attention">
            Automatic recovery stopped. Confirm the outcome with the supplier directly, then record
            it here. Never book it again with the supplier to “retry”.
          </Alert>
        ) : null}
        <DetailList
          items={[
            [
              'Status',
              <Badge key="status" tone={label.tone}>
                {label.label}
              </Badge>,
            ],
            ['Provider', r.provider],
            ['Supplier reference', r.supplierReference ?? '—'],
            ['Outcome ambiguous', yesNo(r.ambiguous)],
            ['Needs attention', yesNo(r.needsAttention)],
            ['Last error', r.errorCategory ? humanize(r.errorCategory.toLowerCase()) : '—'],
            [
              'Requests sent',
              `${formatCount(r.attempts)} reservation · ${formatCount(r.cancelAttempts)} cancellation · ${formatCount(r.checks)} status checks`,
            ],
            ['Last request', r.lastAttemptAt ? formatUtc(r.lastAttemptAt) : '—'],
            ['Next check', r.nextCheckAt ? formatUtc(r.nextCheckAt) : '—'],
            ['Correlation id', r.requestId ?? '—'],
            ['Confirmed', r.confirmedAt ? formatUtc(r.confirmedAt) : '—'],
            [
              'Cancellation',
              r.cancelledAt
                ? `Cancelled ${formatUtc(r.cancelledAt)}`
                : r.cancellationRequestedAt
                  ? `Requested ${formatUtc(r.cancellationRequestedAt)}`
                  : '—',
            ],
            [
              'Supplier can',
              [
                r.capabilities.lookup ? 'look up status' : null,
                r.capabilities.cancel ? 'cancel' : null,
                r.capabilities.idempotentReserve ? 'de-duplicate requests' : null,
              ]
                .filter(Boolean)
                .join(', ') || 'reserve only',
            ],
            [
              'Tickets and vouchers',
              r.documents.length === 0
                ? 'None issued'
                : r.documents.map((d) => `${humanize(d.type)} ${d.reference}`).join(', '),
            ],
          ]}
        />
        {r.history.length > 0 ? (
          <ol
            aria-label="Reservation history"
            className="flex flex-col gap-2 border-t border-line pt-3"
          >
            {r.history.map((h, i) => (
              <li key={i} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-body-sm">
                <Badge
                  size="sm"
                  tone={
                    RESERVATION_LABEL[h.status as AdminReservation['status']]?.tone ?? 'neutral'
                  }
                >
                  {RESERVATION_LABEL[h.status as AdminReservation['status']]?.label ?? h.status}
                </Badge>
                <span className="text-ink-secondary">by {h.by}</span>
                {h.note ? <span>{h.note}</span> : null}
                {h.errorCategory ? (
                  <span className="text-ink-secondary">
                    ({humanize(h.errorCategory.toLowerCase())})
                  </span>
                ) : null}
                <span className="ml-auto text-caption text-ink-secondary">{formatUtc(h.at)}</span>
              </li>
            ))}
          </ol>
        ) : null}
        {canManage && r.actions.recheck ? (
          <div className="flex flex-wrap items-center gap-3">
            <Button
              variant="secondary"
              onClick={() => recheck.mutate()}
              loading={recheck.isPending}
            >
              <RotateCw aria-hidden="true" />
              Check with the supplier now
            </Button>
            <span className="text-caption text-ink-secondary">
              A read-only status lookup. It never sends another reservation.
            </span>
          </div>
        ) : null}
        {recheck.isError ? (
          <Alert tone="danger" title="The check didn’t run">
            {recheck.error instanceof ApiClientError ? recheck.error.message : 'Try again.'}
          </Alert>
        ) : null}
        {canManage && r.actions.resolve ? (
          <ResolveForm reference={reference} reservation={r} onDone={update} />
        ) : null}
        <Note>
          Supplier references are shown in full only to staff who can manage reservations. No
          supplier payloads or credentials are stored or shown.
        </Note>
      </div>
    </Section>
  );
}

function ResolveForm({
  reference,
  reservation: r,
  onDone,
}: {
  reference: string;
  reservation: AdminReservation;
  onDone: (detail: AdminBookingDetail) => void;
}) {
  const cancelling = r.status === 'cancellation-pending';
  const { toast } = useToast();
  const [outcome, setOutcome] = useState<'' | 'confirmed' | 'failed' | 'cancelled'>('');
  const [supplierReference, setSupplierReference] = useState(
    cancelling ? (r.supplierReference ?? '') : '',
  );
  const [reason, setReason] = useState('');
  const resolve = useMutation({
    mutationFn: () =>
      adminApi.resolveReservation(
        reference,
        outcome === 'confirmed'
          ? { outcome, supplierReference: supplierReference.trim(), reason: reason.trim() }
          : { outcome: outcome as 'failed' | 'cancelled', reason: reason.trim() },
      ),
    onSuccess: (detail) => {
      onDone(detail);
      toast({ tone: 'success', title: 'Outcome recorded' });
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (outcome) resolve.mutate();
  };
  const error = resolve.error instanceof ApiClientError ? resolve.error : null;
  return (
    <form
      onSubmit={submit}
      aria-labelledby="resolve-heading"
      className="flex flex-col gap-3 rounded-lg border border-line bg-sunken p-4"
    >
      <h3 id="resolve-heading" className="text-title">
        Record the outcome
      </h3>
      <p className="text-body-sm text-ink-secondary">
        Only after confirming it with the supplier yourself. This records the outcome and tells the
        customer; Wayora sends nothing to the supplier. Your reason is kept in the audit log.
      </p>
      <Field label="What the supplier confirmed" required>
        <Select
          value={outcome}
          onChange={(e) => setOutcome(e.target.value as typeof outcome)}
          required
        >
          <option value="">Choose…</option>
          {cancelling ? (
            <>
              <option value="cancelled">It is cancelled</option>
              <option value="confirmed">It is still confirmed (not cancelled)</option>
            </>
          ) : (
            <>
              <option value="confirmed">It is reserved (confirmed)</option>
              <option value="failed">It is not reserved</option>
            </>
          )}
        </Select>
      </Field>
      {outcome === 'confirmed' ? (
        <Field
          label="Supplier reference"
          required
          hint={
            cancelling ? 'Must match the reference on record.' : 'Exactly as the supplier gave it.'
          }
        >
          <Input
            value={supplierReference}
            onChange={(e) => setSupplierReference(e.target.value)}
            required
            maxLength={128}
            autoComplete="off"
          />
        </Field>
      ) : null}
      <Field label="How you confirmed it" required hint="At least 10 characters. Staff-only.">
        <Textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          required
          minLength={10}
          maxLength={500}
          rows={3}
        />
      </Field>
      {resolve.isError ? (
        <Alert tone="danger" title="Not recorded">
          {error?.message ?? 'Try again.'}
        </Alert>
      ) : null}
      <div>
        <Button
          type="submit"
          loading={resolve.isPending}
          disabled={!outcome || reason.trim().length < 10}
        >
          Record outcome
        </Button>
      </div>
    </form>
  );
}
