import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { Link, useParams } from 'react-router';
import {
  bookingStatusSchema,
  paymentModeSchema,
  paymentStatusSchema,
  searchServiceTypeSchema,
  userRoleSchema,
  type AdminHealth,
} from '@wayora/contracts';
import { Alert, Badge } from '@wayora/ui';
import { adminApi } from '../../services/admin';
import { AccessDenied, useCan } from './AdminLayout';
import {
  CHECK,
  RANGE_LABEL,
  formatBucket,
  formatCount,
  formatPercent,
  formatUtc,
  humanize,
} from './format';
import { adminKeys } from './keys';
import { ADMIN_PATHS } from './paths';
import {
  AdminPage,
  BarList,
  DemoBadge,
  DetailList,
  EmptyRows,
  FilterBar,
  Note,
  Pager,
  QueryView,
  RangePicker,
  Section,
  Stat,
  StatGrid,
  StatusBadge,
  Table,
  Unavailable,
  money,
  useFilters,
  useRange,
} from './ui';

/*
 * Admin pages (docs/admin.md#web). Read-only views: no page here changes a
 * booking, payment or account. Every figure comes from the API, which
 * computes it from the database; missing data is shown as unavailable.
 */

const options = (values: readonly string[]) =>
  values.map((v) => ({ value: v, label: humanize(v) }));
const link = 'font-medium text-brand-ink underline-offset-2 hover:underline';
const mono = 'font-mono text-caption';

const DEMO_NOTE =
  'Demo bookings and payments are simulations: no supplier was contacted, no ticket or PNR exists and no money moved.';

// ─── Overview ───────────────────────────────────────────────────────────

export function OverviewRoute() {
  const range = useRange();
  const query = useQuery({
    queryKey: adminKeys.view('overview', range),
    queryFn: ({ signal }) => adminApi.overview(range, signal),
  });
  return (
    <AdminPage
      title="Overview"
      description={`${RANGE_LABEL[range]}, in UTC. Counts come straight from the database.`}
      actions={<RangePicker />}
    >
      <QueryView query={query} label="the overview">
        {(o) => (
          <>
            <StatGrid>
              <Stat
                label="Users"
                value={formatCount(o.users.total)}
                hint={`${formatCount(o.users.newInRange)} new`}
              />
              <Stat
                label="Bookings"
                value={formatCount(o.bookings.inRange)}
                hint={`${formatCount(o.bookings.demo)} demo · ${formatCount(o.bookings.real)} real · ${formatCount(o.bookings.total)} all time`}
              />
              <Stat
                label="Payment attempts"
                value={formatCount(o.payments.attemptsInRange)}
                hint={`${formatCount(o.payments.byMode.demo)} demo · ${formatCount(o.payments.byMode.live)} live`}
              />
              <Stat
                label="Searches"
                value={formatCount(o.searches.inRange)}
                hint={
                  o.searches.trackedSince
                    ? `Recorded since ${formatUtc(o.searches.trackedSince)}`
                    : 'None recorded yet'
                }
              />
            </StatGrid>
            <Unavailable items={o.unavailable} />
            <div className="grid gap-4 xl:grid-cols-2">
              <Section
                title="Bookings by status"
                description="Bookings created in the range, by their status now."
              >
                <BarList label="Bookings by status" items={o.bookings.byStatus} />
              </Section>
              <Section
                title="Payment attempts by status"
                description="Every attempt counts, including declined ones."
              >
                <BarList label="Payment attempts by status" items={o.payments.byStatus} />
              </Section>
              <Section title="Real revenue" description={o.payments.realRevenue.note}>
                {o.payments.realRevenue.totals.length === 0 ? (
                  <p className="text-body-sm text-ink-secondary">
                    None. There are no succeeded live payments in this range.
                  </p>
                ) : (
                  <ul className="flex flex-col gap-1 text-heading-3 tabular-nums">
                    {o.payments.realRevenue.totals.map((m) => (
                      <li key={m.currency}>{money(m)}</li>
                    ))}
                  </ul>
                )}
              </Section>
              <Section title="Search conversion" description={o.conversion.definition}>
                <p className="text-heading-3 tabular-nums">
                  {o.conversion.rate === null
                    ? 'No searches recorded'
                    : formatPercent(o.conversion.rate)}
                </p>
                <p className="text-body-sm text-ink-secondary">
                  {formatCount(o.conversion.searchesWithBooking)} of{' '}
                  {formatCount(o.conversion.searches)} recorded search sessions led to a booking.
                </p>
              </Section>
            </div>
            <Section
              title="Recent activity"
              description="The latest bookings and payment attempts, all time."
            >
              {o.recent.length === 0 ? (
                <p className="text-body-sm text-ink-secondary">No bookings or payments yet.</p>
              ) : (
                <ul className="flex flex-col divide-y divide-line">
                  {o.recent.map((r) => (
                    <li
                      key={`${r.kind}-${r.bookingReference}-${r.at}`}
                      className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5 text-body-sm"
                    >
                      <span className="w-16 text-ink-secondary">
                        {r.kind === 'booking' ? 'Booking' : 'Payment'}
                      </span>
                      <Link
                        to={ADMIN_PATHS.booking(r.bookingReference)}
                        className={`${link} ${mono}`}
                      >
                        {r.bookingReference}
                      </Link>
                      <StatusBadge status={r.status} />
                      {r.demo ? <DemoBadge demo /> : null}
                      <span className="ml-auto text-caption text-ink-secondary">
                        {formatUtc(r.at)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Section>
            <Note>{DEMO_NOTE}</Note>
          </>
        )}
      </QueryView>
    </AdminPage>
  );
}

// ─── Users ──────────────────────────────────────────────────────────────

export function UsersRoute() {
  const { values, page } = useFilters(['q', 'role', 'status']);
  const query = useQuery({
    queryKey: adminKeys.view('users', values, page),
    queryFn: ({ signal }) => adminApi.users({ ...values, page }, signal),
    placeholderData: (previous) => previous,
  });
  return (
    <AdminPage
      title="Users"
      description="Accounts, newest first. Read-only: roles are changed only by the provisioning script."
    >
      <FilterBar
        label="Filter users"
        specs={[
          { name: 'q', label: 'Name, email or user id', kind: 'text', placeholder: 'asha@' },
          { name: 'role', label: 'Role', kind: 'select', options: options(userRoleSchema.options) },
          {
            name: 'status',
            label: 'Status',
            kind: 'select',
            options: options(['active', 'suspended', 'deleted']),
          },
        ]}
      />
      <QueryView query={query} label="users">
        {(data) =>
          data.items.length === 0 ? (
            <EmptyRows what="users" />
          ) : (
            <>
              <Table
                label="Users"
                head={['Name', 'Email', 'Role', 'Status', 'Bookings', 'Joined (UTC)']}
              >
                {data.items.map((u) => (
                  <tr key={u.id}>
                    <td>
                      <Link to={ADMIN_PATHS.user(u.id)} className={link}>
                        {u.name || 'No name'}
                      </Link>
                    </td>
                    <td className="break-all">{u.email}</td>
                    <td>
                      {u.role === 'user' ? 'User' : <Badge tone="brand">{humanize(u.role)}</Badge>}
                    </td>
                    <td>
                      <StatusBadge status={u.status} />
                    </td>
                    <td className="tabular-nums">{formatCount(u.bookingCount)}</td>
                    <td className="whitespace-nowrap">{formatUtc(u.createdAt)}</td>
                  </tr>
                ))}
              </Table>
              <Pager pagination={data.pagination} label="Users" />
            </>
          )
        }
      </QueryView>
    </AdminPage>
  );
}

export function UserDetailRoute() {
  const { userId = '' } = useParams();
  const query = useQuery({
    queryKey: adminKeys.view('user', userId),
    queryFn: ({ signal }) => adminApi.user(userId, signal),
  });
  return (
    <AdminPage
      title={query.data?.name || query.data?.email || 'User'}
      back={{ to: ADMIN_PATHS.users, label: 'Users' }}
    >
      <QueryView query={query} label="this user" notFound="There is no user with that id.">
        {(u) => (
          <>
            <Section title="Account">
              <DetailList
                items={[
                  ['Email', <span className="break-all">{u.email}</span>],
                  ['Role', humanize(u.role)],
                  ['Status', <StatusBadge status={u.status} />],
                  [
                    'Email verified',
                    u.emailVerified ? 'Yes' : 'No (no verification flow exists yet)',
                  ],
                  ['Joined', formatUtc(u.createdAt)],
                  ['Last active', u.lastActiveAt ? formatUtc(u.lastActiveAt) : 'Never signed in'],
                  ['Active sessions', formatCount(u.activeSessions)],
                  ['Saved travellers', formatCount(u.savedTravellers)],
                  [
                    'Notifications',
                    `${formatCount(u.notifications.total)} (${formatCount(u.notifications.unread)} unread)`,
                  ],
                  ['User id', <span className={mono}>{u.id}</span>],
                ]}
              />
              <div className="mt-4">
                <Note>
                  Phone numbers, traveller details, passwords and sessions are never shown here.
                  Viewing this page is recorded in the audit log.
                </Note>
              </div>
            </Section>
            <div className="grid gap-4 lg:grid-cols-2">
              <Section title="Bookings by status">
                <BarList label="Bookings by status" items={u.bookingsByStatus} />
              </Section>
              <Section title="Payment attempts by status">
                <BarList label="Payment attempts by status" items={u.paymentsByStatus} />
              </Section>
            </div>
            <Section title="Recent bookings">
              {u.recentBookings.length === 0 ? (
                <p className="text-body-sm text-ink-secondary">No bookings.</p>
              ) : (
                <ul className="flex flex-col divide-y divide-line">
                  {u.recentBookings.map((b) => (
                    <li
                      key={b.reference}
                      className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5 text-body-sm"
                    >
                      <Link to={ADMIN_PATHS.booking(b.reference)} className={`${link} ${mono}`}>
                        {b.reference}
                      </Link>
                      <span>{humanize(b.serviceType)}</span>
                      <StatusBadge status={b.status} />
                      <DemoBadge demo={b.demo} />
                      <span className="ml-auto text-caption text-ink-secondary">
                        {formatUtc(b.createdAt)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              {u.bookingCount > u.recentBookings.length ? (
                <p className="mt-3 text-body-sm">
                  <Link to={`${ADMIN_PATHS.bookings}?userId=${u.id}`} className={link}>
                    All {formatCount(u.bookingCount)} bookings
                  </Link>
                </p>
              ) : null}
            </Section>
          </>
        )}
      </QueryView>
    </AdminPage>
  );
}

// ─── Bookings ───────────────────────────────────────────────────────────

export function BookingsRoute() {
  const { values, page } = useFilters([
    'reference',
    'serviceType',
    'status',
    'from',
    'to',
    'userId',
  ]);
  const query = useQuery({
    queryKey: adminKeys.view('bookings', values, page),
    queryFn: ({ signal }) => adminApi.bookings({ ...values, page }, signal),
    placeholderData: (previous) => previous,
  });
  return (
    <AdminPage title="Bookings" description={`Newest first. Dates are UTC days. ${DEMO_NOTE}`}>
      <FilterBar
        label="Filter bookings"
        specs={[
          { name: 'reference', label: 'Reference', kind: 'text', placeholder: 'WYD-' },
          {
            name: 'serviceType',
            label: 'Category',
            kind: 'select',
            options: options(searchServiceTypeSchema.options),
          },
          {
            name: 'status',
            label: 'Status',
            kind: 'select',
            options: options(bookingStatusSchema.options),
          },
          { name: 'from', label: 'Created from', kind: 'date' },
          { name: 'to', label: 'Created to', kind: 'date' },
        ]}
      />
      {values.userId ? (
        <p className="text-body-sm text-ink-secondary">
          Showing one user’s bookings.{' '}
          <Link to={ADMIN_PATHS.user(values.userId)} className={link}>
            View the user
          </Link>
        </p>
      ) : null}
      <QueryView query={query} label="bookings">
        {(data) =>
          data.items.length === 0 ? (
            <EmptyRows what="bookings" />
          ) : (
            <>
              <Table
                label="Bookings"
                head={[
                  'Reference',
                  'Category',
                  'Status',
                  'Kind',
                  'Total',
                  'Customer',
                  'Created (UTC)',
                ]}
              >
                {data.items.map((b) => (
                  <tr key={b.reference}>
                    <td>
                      <Link to={ADMIN_PATHS.booking(b.reference)} className={`${link} ${mono}`}>
                        {b.reference}
                      </Link>
                    </td>
                    <td>{humanize(b.serviceType)}</td>
                    <td>
                      <StatusBadge status={b.status} />
                    </td>
                    <td>
                      <DemoBadge demo={b.demo} />
                    </td>
                    <td className="whitespace-nowrap tabular-nums">
                      {b.total ? money(b.total) : 'Range price'}
                    </td>
                    <td className="break-all">
                      <Link to={ADMIN_PATHS.user(b.userId)} className={link}>
                        {b.userEmail}
                      </Link>
                    </td>
                    <td className="whitespace-nowrap">{formatUtc(b.createdAt)}</td>
                  </tr>
                ))}
              </Table>
              <Pager pagination={data.pagination} label="Bookings" />
            </>
          )
        }
      </QueryView>
    </AdminPage>
  );
}

export function BookingDetailRoute() {
  const { reference = '' } = useParams();
  const query = useQuery({
    queryKey: adminKeys.view('booking', reference),
    queryFn: ({ signal }) => adminApi.booking(reference, signal),
  });
  return (
    <AdminPage
      title={reference.toUpperCase()}
      back={{ to: ADMIN_PATHS.bookings, label: 'Bookings' }}
    >
      <QueryView
        query={query}
        label="this booking"
        notFound="There is no booking with that reference."
      >
        {(b) => (
          <>
            {b.demo ? (
              <Alert tone="info" title="Demo booking">
                No supplier was contacted, and no ticket, PNR or real reservation exists.
              </Alert>
            ) : null}
            <Section title="Booking">
              <DetailList
                items={[
                  ['Status', <StatusBadge status={b.status} />],
                  ['Category', humanize(b.serviceType)],
                  ['Provider', b.providerName || '—'],
                  ['Supplier reference', b.supplierReference ?? 'None (no supplier was contacted)'],
                  [
                    'Customer',
                    <Link to={ADMIN_PATHS.user(b.userId)} className={`${link} break-all`}>
                      {b.userEmail}
                    </Link>,
                  ],
                  ['Party size', formatCount(b.partySize)],
                  [
                    'Travellers',
                    b.travellers.map((t) => `${t.firstName} ${t.lastName}`).join(', ') || '—',
                  ],
                  ['Contact phone', b.contactPhoneMasked ?? '—'],
                  [
                    'Travel',
                    b.startsOn
                      ? b.endsOn && b.endsOn !== b.startsOn
                        ? `${b.startsOn} – ${b.endsOn}`
                        : b.startsOn
                      : 'No date',
                  ],
                  ['Total', b.total ? money(b.total) : 'Range price (no payment)'],
                  ['Payment', b.paymentMode === 'demo' ? 'Demo payment' : 'No payment'],
                  ['Payment due', b.paymentDueAt ? formatUtc(b.paymentDueAt) : '—'],
                  ['Created', formatUtc(b.createdAt)],
                  ['Confirmed', b.confirmedAt ? formatUtc(b.confirmedAt) : '—'],
                  ['Cancelled', b.cancelledAt ? formatUtc(b.cancelledAt) : '—'],
                ]}
              />
              <div className="mt-4">
                <Note>
                  Read-only. Bookings change only through their own lifecycle. Viewing this page is
                  recorded in the audit log.
                </Note>
              </div>
            </Section>
            <Section title="Status history">
              <ol className="flex flex-col gap-2">
                {b.history.map((h, i) => (
                  <li key={i} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-body-sm">
                    <StatusBadge status={h.status} />
                    <span className="text-ink-secondary">by {h.by}</span>
                    {h.note ? <span>{h.note}</span> : null}
                    <span className="ml-auto text-caption text-ink-secondary">
                      {formatUtc(h.at)}
                    </span>
                  </li>
                ))}
              </ol>
            </Section>
            <Section title="Payment attempts">
              {b.payments.length === 0 ? (
                <p className="text-body-sm text-ink-secondary">No payment attempts.</p>
              ) : (
                <PaymentsTable items={b.payments} />
              )}
            </Section>
            <Section title="Notifications sent to the customer">
              {b.notifications.length === 0 ? (
                <p className="text-body-sm text-ink-secondary">None.</p>
              ) : (
                <ul className="flex flex-col divide-y divide-line">
                  {b.notifications.map((n, i) => (
                    <li
                      key={i}
                      className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-body-sm"
                    >
                      <span>{n.title}</span>
                      <span className="text-ink-secondary">{n.read ? 'Read' : 'Unread'}</span>
                      <span className="ml-auto text-caption text-ink-secondary">
                        {formatUtc(n.createdAt)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Section>
            <details className="rounded-xl border border-line bg-card p-4 shadow-xs sm:p-5">
              <summary className="cursor-pointer text-title">Offer as booked</summary>
              <pre className="mt-3 max-h-96 overflow-auto rounded-md bg-sunken p-3 text-caption">
                {JSON.stringify(b.offerSnapshot, null, 2)}
              </pre>
            </details>
          </>
        )}
      </QueryView>
    </AdminPage>
  );
}

// ─── Payments ───────────────────────────────────────────────────────────

function PaymentsTable({
  items,
}: {
  items: Awaited<ReturnType<typeof adminApi.payments>>['items'];
}) {
  return (
    <Table
      label="Payment attempts"
      head={['Payment', 'Booking', 'Attempt', 'Status', 'Mode', 'Amount', 'Started (UTC)']}
    >
      {items.map((p) => (
        <tr key={p.id}>
          <td>
            <Link to={ADMIN_PATHS.payment(p.id)} className={`${link} ${mono}`}>
              {p.id.slice(0, 8)}…
            </Link>
          </td>
          <td>
            <Link to={ADMIN_PATHS.booking(p.bookingReference)} className={`${link} ${mono}`}>
              {p.bookingReference}
            </Link>
          </td>
          <td className="tabular-nums">#{p.attempt}</td>
          <td>
            <StatusBadge status={p.status} />
            {p.refundRequired ? (
              <Badge tone="warning" className="ml-1">
                Refund required
              </Badge>
            ) : null}
          </td>
          <td>
            <DemoBadge demo={p.mode === 'demo'} />
          </td>
          <td className="whitespace-nowrap tabular-nums">{money(p.amount)}</td>
          <td className="whitespace-nowrap">{formatUtc(p.createdAt)}</td>
        </tr>
      ))}
    </Table>
  );
}

export function PaymentsRoute() {
  const { values, page } = useFilters(['q', 'status', 'mode', 'from', 'to']);
  const query = useQuery({
    queryKey: adminKeys.view('payments', values, page),
    queryFn: ({ signal }) => adminApi.payments({ ...values, page }, signal),
    placeholderData: (previous) => previous,
  });
  return (
    <AdminPage
      title="Payments"
      description="Every payment attempt, newest first. Demo payments are simulated and never counted as revenue."
    >
      <FilterBar
        label="Filter payments"
        specs={[
          {
            name: 'q',
            label: 'Payment id or booking reference',
            kind: 'text',
            placeholder: 'WYD-',
          },
          {
            name: 'status',
            label: 'Status',
            kind: 'select',
            options: options(paymentStatusSchema.options),
          },
          {
            name: 'mode',
            label: 'Mode',
            kind: 'select',
            options: options(paymentModeSchema.options),
          },
          { name: 'from', label: 'Started from', kind: 'date' },
          { name: 'to', label: 'Started to', kind: 'date' },
        ]}
      />
      <QueryView query={query} label="payments">
        {(data) =>
          data.items.length === 0 ? (
            <EmptyRows what="payments" />
          ) : (
            <>
              <PaymentsTable items={data.items} />
              <Pager pagination={data.pagination} label="Payments" />
            </>
          )
        }
      </QueryView>
    </AdminPage>
  );
}

export function PaymentDetailRoute() {
  const { paymentId = '' } = useParams();
  const query = useQuery({
    queryKey: adminKeys.view('payment', paymentId),
    queryFn: ({ signal }) => adminApi.payment(paymentId, signal),
  });
  return (
    <AdminPage title="Payment attempt" back={{ to: ADMIN_PATHS.payments, label: 'Payments' }}>
      <QueryView query={query} label="this payment" notFound="There is no payment with that id.">
        {(p) => (
          <>
            {p.mode === 'demo' ? (
              <Alert tone="info" title="Demo payment">
                Simulated: no card was charged and no money moved.
              </Alert>
            ) : null}
            <Section title="Attempt">
              <DetailList
                items={[
                  ['Status', <StatusBadge status={p.status} />],
                  [
                    'Booking',
                    <Link
                      to={ADMIN_PATHS.booking(p.bookingReference)}
                      className={`${link} ${mono}`}
                    >
                      {p.bookingReference}
                    </Link>,
                  ],
                  ['Attempt', `#${p.attempt}`],
                  ['Amount', money(p.amount)],
                  ['Mode', p.mode === 'demo' ? 'Demo (simulated)' : 'Live'],
                  ['Provider', p.provider],
                  [
                    'Provider reference',
                    p.providerReference ? <span className={mono}>{p.providerReference}</span> : '—',
                  ],
                  ['Demo scenario', p.demoScenario ? humanize(p.demoScenario) : '—'],
                  ['Failure', p.failure ? `${p.failure.message} (${p.failure.code})` : '—'],
                  ['Started', formatUtc(p.createdAt)],
                  ['Completed', p.completedAt ? formatUtc(p.completedAt) : '—'],
                  [
                    'Customer',
                    <Link to={ADMIN_PATHS.user(p.userId)} className={link}>
                      View user
                    </Link>,
                  ],
                  ['Payment id', <span className={mono}>{p.id}</span>],
                ]}
              />
            </Section>
            <Section title="Refund">
              <p className="text-body-sm">
                {p.refund.required
                  ? 'A refund is required for this attempt.'
                  : 'No refund is required.'}
              </p>
              <Note>{p.refund.note}</Note>
            </Section>
            <Section title="Status history">
              <ol className="flex flex-col gap-2">
                {p.history.map((h, i) => (
                  <li key={i} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-body-sm">
                    <StatusBadge status={h.status} />
                    <span className="text-ink-secondary">by {h.by}</span>
                    {h.note ? <span>{h.note}</span> : null}
                    <span className="ml-auto text-caption text-ink-secondary">
                      {formatUtc(h.at)}
                    </span>
                  </li>
                ))}
              </ol>
            </Section>
            <Section
              title="Provider events"
              description="Signed events received from the payment provider for this attempt."
            >
              {p.providerEvents.length === 0 ? (
                <p className="text-body-sm text-ink-secondary">None received.</p>
              ) : (
                <Table
                  label="Provider events"
                  head={[
                    'Type',
                    'Processing',
                    'Source',
                    'Attempts',
                    'Received (UTC)',
                    'Last error',
                  ]}
                >
                  {p.providerEvents.map((e, i) => (
                    <tr key={i}>
                      <td className={mono}>{e.type}</td>
                      <td>
                        <StatusBadge status={e.status} />
                      </td>
                      <td>{e.source ?? '—'}</td>
                      <td className="tabular-nums">{e.attempts}</td>
                      <td className="whitespace-nowrap">{formatUtc(e.receivedAt)}</td>
                      <td>{e.lastError ?? '—'}</td>
                    </tr>
                  ))}
                </Table>
              )}
            </Section>
          </>
        )}
      </QueryView>
    </AdminPage>
  );
}

// ─── Search activity ────────────────────────────────────────────────────

export function SearchActivityRoute() {
  const range = useRange();
  const query = useQuery({
    queryKey: adminKeys.view('search', range),
    queryFn: ({ signal }) => adminApi.searchAnalytics(range, signal),
  });
  return (
    <AdminPage
      title="Search activity"
      description={`${RANGE_LABEL[range]}, in UTC. Only the category, outcome, timing and provider status of each search are recorded.`}
      actions={<RangePicker />}
    >
      <QueryView query={query} label="search activity">
        {(a) => (
          <>
            <StatGrid>
              <Stat label="Searches" value={formatCount(a.total)} />
              <Stat label="Succeeded" value={formatCount(a.byOutcome.success ?? 0)} />
              <Stat
                label="Partial or empty"
                value={formatCount((a.byOutcome.partial ?? 0) + (a.byOutcome.empty ?? 0))}
              />
              <Stat label="Failed" value={formatCount(a.byOutcome.failed ?? 0)} />
            </StatGrid>
            <Unavailable items={a.unavailable} />
            <div className="grid gap-4 xl:grid-cols-2">
              <Section title="By category">
                <BarList label="Searches by category" items={a.byCategory} />
              </Section>
              <Section title="By outcome">
                <BarList label="Searches by outcome" items={a.byOutcome} />
              </Section>
            </div>
            <Section
              title={a.bucket === 'hour' ? 'Searches per hour' : 'Searches per day'}
              description={
                a.trackedSince
                  ? `Recorded since ${formatUtc(a.trackedSince)}.`
                  : 'Nothing recorded yet.'
              }
            >
              {a.series.length === 0 ? (
                <p className="text-body-sm text-ink-secondary">No data for this range.</p>
              ) : (
                <Table
                  label={a.bucket === 'hour' ? 'Searches per hour' : 'Searches per day'}
                  head={['Starting', 'Searches', 'Failed']}
                >
                  {a.series
                    .filter((s) => s.count > 0)
                    .map((s) => (
                      <tr key={s.start}>
                        <td className="whitespace-nowrap">{formatBucket(s.start, a.bucket)}</td>
                        <td className="tabular-nums">{formatCount(s.count)}</td>
                        <td className="tabular-nums">{formatCount(s.failed)}</td>
                      </tr>
                    ))}
                </Table>
              )}
              <div className="mt-3">
                <Note>Periods not listed had no searches.</Note>
              </div>
            </Section>
            <Section
              title="Providers"
              description="Provider calls made by searches in the range (reused results make no calls)."
            >
              {a.providers.length === 0 ? (
                <p className="text-body-sm text-ink-secondary">
                  No provider calls recorded in this range.
                </p>
              ) : (
                <Table
                  label="Providers"
                  head={['Provider', 'Calls', 'Outcomes', 'Average', '95th percentile']}
                >
                  {a.providers.map((p) => (
                    <tr key={p.id}>
                      <td className={mono}>{p.id}</td>
                      <td className="tabular-nums">{formatCount(p.calls)}</td>
                      <td>
                        {Object.entries(p.byStatus)
                          .map(([s, n]) => `${humanize(s)} ${formatCount(n)}`)
                          .join(' · ')}
                      </td>
                      <td className="tabular-nums">
                        {p.avgMs === null ? '—' : `${formatCount(p.avgMs)} ms`}
                      </td>
                      <td className="tabular-nums">
                        {p.p95Ms === null ? '—' : `${formatCount(p.p95Ms)} ms`}
                      </td>
                    </tr>
                  ))}
                </Table>
              )}
              <div className="mt-3">
                <Note>
                  A provider appearing here only means it was called. Current availability is on the
                  platform health page and in each search’s provider status.
                </Note>
              </div>
            </Section>
          </>
        )}
      </QueryView>
    </AdminPage>
  );
}

// ─── Notifications ──────────────────────────────────────────────────────

export function NotificationHealthRoute() {
  const range = useRange();
  const query = useQuery({
    queryKey: adminKeys.view('notifications', range),
    queryFn: ({ signal }) => adminApi.notifications(range, signal),
  });
  return (
    <AdminPage
      title="Notifications"
      description={`${RANGE_LABEL[range]}, in UTC: notifications created and how their emails fared.`}
      actions={<RangePicker />}
    >
      <QueryView query={query} label="notification health">
        {(n) => (
          <>
            {n.email.configured ? null : (
              <Alert tone="warning" title="Email isn’t configured">
                {n.email.note}
              </Alert>
            )}
            <StatGrid>
              <Stat label="Notifications created" value={formatCount(n.createdInRange)} />
              <Stat
                label="Emails waiting"
                value={formatCount(n.deliveries.byStatus.pending ?? 0)}
              />
              <Stat label="Emails sent" value={formatCount(n.deliveries.byStatus.sent ?? 0)} />
              <Stat label="Emails failed" value={formatCount(n.deliveries.byStatus.failed ?? 0)} />
            </StatGrid>
            <div className="grid gap-4 xl:grid-cols-2">
              <Section title="By type">
                <BarList label="Notifications by type" items={n.byType} />
              </Section>
              <Section
                title="Email deliveries"
                description={
                  n.deliveries.oldestPendingAt
                    ? `Oldest waiting since ${formatUtc(n.deliveries.oldestPendingAt)}.`
                    : 'Nothing waiting.'
                }
              >
                <BarList label="Email deliveries by status" items={n.deliveries.byStatus} />
              </Section>
            </div>
          </>
        )}
      </QueryView>
    </AdminPage>
  );
}

// ─── Audit log ──────────────────────────────────────────────────────────

export function AuditLogRoute() {
  const allowed = useCan('admin.audit.read');
  const { values, page } = useFilters([
    'action',
    'actorId',
    'entityType',
    'entityId',
    'from',
    'to',
  ]);
  const query = useQuery({
    queryKey: adminKeys.view('audit', values, page),
    queryFn: ({ signal }) => adminApi.auditLogs({ ...values, page }, signal),
    placeholderData: (previous) => previous,
    enabled: allowed,
  });
  if (!allowed) return <AccessDenied />;
  return (
    <AdminPage
      title="Audit log"
      description="Append-only record of sensitive actions, newest first. Administrators only."
    >
      <FilterBar
        label="Filter the audit log"
        specs={[
          { name: 'action', label: 'Action (or its start)', kind: 'text', placeholder: 'admin.' },
          { name: 'actorId', label: 'Actor id', kind: 'text' },
          {
            name: 'entityType',
            label: 'Entity type',
            kind: 'select',
            options: options(['user', 'booking', 'payment', 'admin_permission']),
          },
          { name: 'entityId', label: 'Entity id', kind: 'text' },
          { name: 'from', label: 'From', kind: 'date' },
          { name: 'to', label: 'To', kind: 'date' },
        ]}
      />
      <QueryView query={query} label="the audit log">
        {(data) =>
          data.items.length === 0 ? (
            <EmptyRows what="audit entries" />
          ) : (
            <>
              <Table
                label="Audit entries"
                head={['When (UTC)', 'Action', 'Actor', 'Entity', 'Details']}
              >
                {data.items.map((e) => (
                  <tr key={e.id}>
                    <td className="whitespace-nowrap">{formatUtc(e.at)}</td>
                    <td className={mono}>{e.action}</td>
                    <td>
                      <span className="block">{humanize(e.actorType)}</span>
                      {e.actorId ? (
                        <span className={`${mono} break-all text-ink-secondary`}>{e.actorId}</span>
                      ) : null}
                    </td>
                    <td>
                      <span className="block">{humanize(e.entityType)}</span>
                      <span className={`${mono} break-all text-ink-secondary`}>{e.entityId}</span>
                    </td>
                    <td className={`${mono} max-w-xs break-words`}>
                      {e.metadata ? JSON.stringify(e.metadata) : '—'}
                    </td>
                  </tr>
                ))}
              </Table>
              <Pager pagination={data.pagination} label="Audit entries" />
            </>
          )
        }
      </QueryView>
    </AdminPage>
  );
}

// ─── Platform health ────────────────────────────────────────────────────

function Check({
  title,
  status,
  children,
}: {
  title: string;
  status: AdminHealth['database']['status'];
  children?: ReactNode;
}) {
  const c = CHECK[status];
  return (
    <Section title={title}>
      <div className="flex flex-col gap-2 text-body-sm">
        <div>
          <Badge tone={c.tone}>{c.label}</Badge>
        </div>
        {children}
      </div>
    </Section>
  );
}

export function HealthRoute() {
  const query = useQuery({
    queryKey: adminKeys.view('health'),
    queryFn: ({ signal }) => adminApi.health(signal),
    refetchInterval: 30_000,
  });
  return (
    <AdminPage
      title="Platform health"
      description="Live checks of the API, its dependencies and background work. Refreshes every 30 seconds."
    >
      <QueryView query={query} label="platform health">
        {(h) => (
          <>
            <p className="text-body-sm text-ink-secondary">
              Checked {formatUtc(h.checkedAt)} (reused for up to {h.maxAgeSeconds} seconds).
            </p>
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              <Check title="API" status={h.api.status}>
                <p>Up for {formatCount(Math.floor(h.api.uptimeSeconds / 60))} minutes.</p>
              </Check>
              <Check title="Database" status={h.database.status}>
                {h.database.latencyMs !== null ? (
                  <p>Answered in {h.database.latencyMs} ms.</p>
                ) : null}
              </Check>
              <Check title="Redis" status={h.redis.status}>
                {h.redis.status === 'not-configured' ? (
                  <p>
                    REDIS_URL isn’t set. Rate limits and search sessions are per process, and the
                    worker can’t run.
                  </p>
                ) : h.redis.latencyMs !== null ? (
                  <p>Answered in {h.redis.latencyMs} ms.</p>
                ) : null}
              </Check>
              <Check title="Worker" status={h.worker.status}>
                <p>{h.worker.note}</p>
                {h.worker.lastHeartbeatAt ? (
                  <p>Last heartbeat {formatUtc(h.worker.lastHeartbeatAt)}.</p>
                ) : null}
              </Check>
              <Check title="Job queue" status={h.queue.status}>
                {h.queue.waiting === null ? (
                  <p>Queue depth is unknown.</p>
                ) : (
                  <p>
                    {formatCount(h.queue.waiting)} waiting · {formatCount(h.queue.active ?? 0)}{' '}
                    active · {formatCount(h.queue.delayed ?? 0)} delayed ·{' '}
                    {formatCount(h.queue.failed ?? 0)} failed (kept 7 days)
                  </p>
                )}
              </Check>
              <Check title="Email outbox" status={h.outbox.status}>
                {h.outbox.pending === null ? (
                  <p>Outbox counts are unknown.</p>
                ) : (
                  <>
                    <p>
                      {formatCount(h.outbox.pending)} waiting · {formatCount(h.outbox.failed ?? 0)}{' '}
                      failed · {formatCount(h.outbox.notConfigured ?? 0)} not configured
                    </p>
                    {h.outbox.oldestPendingAt ? (
                      <p>Oldest waiting since {formatUtc(h.outbox.oldestPendingAt)}.</p>
                    ) : null}
                  </>
                )}
              </Check>
              <Check title="Payments in progress" status={h.payments.status}>
                {h.payments.inProgress === null ? (
                  <p>Unknown.</p>
                ) : (
                  <>
                    <p>{formatCount(h.payments.inProgress)} attempts in progress.</p>
                    {h.payments.oldestInProgressAt ? (
                      <p>Oldest started {formatUtc(h.payments.oldestInProgressAt)}.</p>
                    ) : null}
                  </>
                )}
              </Check>
            </div>
            <Note>
              “Unknown” means the check couldn’t run; it is never shown as healthy. No connection
              details are shown here.
            </Note>
          </>
        )}
      </QueryView>
    </AdminPage>
  );
}

export function AdminNotFoundRoute() {
  return (
    <AdminPage title="Page not found" back={{ to: ADMIN_PATHS.overview, label: 'Overview' }}>
      <p className="text-body-sm text-ink-secondary">There is no admin page at this address.</p>
    </AdminPage>
  );
}
