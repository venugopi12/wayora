import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import {
  travelCategorySlugSchema,
  type AdminPromotion,
  type AdminPromotionInput,
  type TravelCategorySlug,
} from '@wayora/contracts';
import {
  Alert,
  Badge,
  Button,
  Checkbox,
  Field,
  Input,
  Radio,
  RadioGroup,
  Select,
  Textarea,
} from '@wayora/ui';
import { ApiClientError } from '../../lib/api-client';
import {
  adminCreatePromotion,
  adminPromotion,
  adminPromotionUsage,
  adminPromotions,
  adminSetPromotionActive,
  adminUpdatePromotion,
} from '../../services/promotions';
import { categoriesText, discountText } from '../promotions/format';
import { toMinor } from '../rewards/CheckoutRewards';
import { useCan } from './AdminLayout';
import { formatUtc, humanize } from './format';
import { adminKeys } from './keys';
import { ADMIN_PATHS } from './paths';
import {
  AdminPage,
  DetailList,
  EmptyRows,
  FilterBar,
  Note,
  Pager,
  QueryView,
  Section,
  Stat,
  StatGrid,
  Table,
  money,
  useFilters,
} from './ui';

/*
 * Admin promotions (Phase 26, docs/promotions.md#admin). Reading needs
 * admin.promotions.read; creating, editing and switching on or off need
 * admin.promotions.manage. The API validates and audits every change.
 */

const link = 'font-medium text-brand-ink underline-offset-2 hover:underline';
const mono = 'font-mono text-caption';
const STATE_TONE = {
  running: 'success',
  scheduled: 'brand',
  ended: 'neutral',
  inactive: 'warning',
} as const;

const errorText = (error: unknown) =>
  error instanceof ApiClientError
    ? [error.message, ...error.details.map((d) => `${d.path ?? ''} ${d.message}`.trim())]
        .filter(Boolean)
        .join(' ')
    : 'Something went wrong. Try again.';

export function PromotionsRoute() {
  const canManage = useCan('admin.promotions.manage');
  const { values, page } = useFilters(['state', 'kind', 'q']);
  const query = useQuery({
    queryKey: adminKeys.view('promotions', values, page),
    queryFn: ({ signal }) => adminPromotions({ ...values, page } as never, signal),
    placeholderData: (previous) => previous,
  });
  return (
    <AdminPage
      title="Promotions"
      description="Coupons and automatic offers, with how often each was reserved, redeemed (paid and confirmed), released or reversed."
      actions={
        canManage ? (
          <Link to={ADMIN_PATHS.promotionNew} className={`${link} inline-flex items-center gap-1`}>
            <Plus className="size-4" aria-hidden="true" />
            New promotion
          </Link>
        ) : null
      }
    >
      <Note>
        Discounts apply to demo bookings only, so “discount given” is demo value, not revenue. Uses
        count as redeemed only once the booking is paid and confirmed.
      </Note>
      <FilterBar
        label="Filter promotions"
        specs={[
          { name: 'q', label: 'Name or code', kind: 'text' },
          {
            name: 'state',
            label: 'State',
            kind: 'select',
            options: ['running', 'scheduled', 'ended', 'inactive'].map((v) => ({
              value: v,
              label: humanize(v),
            })),
          },
          {
            name: 'kind',
            label: 'Kind',
            kind: 'select',
            options: [
              { value: 'coupon', label: 'Coupon' },
              { value: 'automatic', label: 'Automatic' },
            ],
          },
        ]}
      />
      <QueryView query={query} label="promotions">
        {(data) =>
          data.items.length === 0 ? (
            <EmptyRows what="promotions" />
          ) : (
            <>
              <Table
                label="Promotions"
                head={['Promotion', 'Discount', 'State', 'Uses', 'Discount given', 'Ends']}
              >
                {data.items.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <Link to={ADMIN_PATHS.promotion(p.id)} className={link}>
                        {p.name}
                      </Link>
                      <span className="block text-caption text-ink-secondary">
                        {p.code ? <span className={mono}>{p.code}</span> : 'Automatic'} ·{' '}
                        {categoriesText(p.categories)}
                      </span>
                    </td>
                    <td>{discountText(p)}</td>
                    <td>
                      <Badge size="sm" tone={STATE_TONE[p.state]}>
                        {humanize(p.state)}
                      </Badge>
                    </td>
                    <td className="numeric whitespace-nowrap">
                      {p.usage.redeemed} redeemed
                      <span className="block text-caption text-ink-secondary">
                        {p.usage.reserved} reserved
                      </span>
                    </td>
                    <td className="numeric">{money(p.usage.redeemedDiscount)}</td>
                    <td className="whitespace-nowrap">{formatUtc(p.endsAt)}</td>
                  </tr>
                ))}
              </Table>
              <Pager pagination={data.pagination} label="Promotions" />
            </>
          )
        }
      </QueryView>
    </AdminPage>
  );
}

export function PromotionDetailRoute() {
  const { id = '' } = useParams();
  const canManage = useCan('admin.promotions.manage');
  const queryClient = useQueryClient();
  const [usagePage, setUsagePage] = useState(1);
  const query = useQuery({
    queryKey: adminKeys.view('promotion', id),
    queryFn: ({ signal }) => adminPromotion(id, signal),
  });
  const usage = useQuery({
    queryKey: adminKeys.view('promotion-usage', id, usagePage),
    queryFn: ({ signal }) => adminPromotionUsage(id, { page: usagePage }, signal),
    placeholderData: (previous) => previous,
  });
  const [editing, setEditing] = useState(false);
  const [reason, setReason] = useState('');
  const toggle = useMutation({
    mutationFn: (active: boolean) => adminSetPromotionActive(id, active, reason),
    onSuccess: (p) => {
      queryClient.setQueryData(adminKeys.view('promotion', id), p);
      void queryClient.invalidateQueries({ queryKey: adminKeys.view('promotions') });
      setReason('');
    },
  });
  return (
    <AdminPage
      title={query.data?.name ?? 'Promotion'}
      back={{ to: ADMIN_PATHS.promotions, label: 'Promotions' }}
    >
      <QueryView
        query={query}
        label="this promotion"
        notFound="There is no promotion with that id."
      >
        {(p) => (
          <>
            <StatGrid>
              <Stat label="Redeemed" value={String(p.usage.redeemed)} />
              <Stat label="Reserved now" value={String(p.usage.reserved)} />
              <Stat label="Discount given (redeemed)" value={money(p.usage.redeemedDiscount)} />
              <Stat label="Booking value (redeemed)" value={money(p.usage.redeemedBookingValue)} />
            </StatGrid>
            <Section title="Configuration">
              <DetailList
                items={[
                  [
                    'State',
                    <Badge size="sm" tone={STATE_TONE[p.state]}>
                      {humanize(p.state)}
                    </Badge>,
                  ],
                  [
                    'Kind',
                    p.kind === 'coupon' ? (
                      <span className={mono}>{p.code}</span>
                    ) : (
                      'Automatic (no code)'
                    ),
                  ],
                  ['Discount', discountText(p)],
                  ['Minimum amount', p.minAmount ? money(p.minAmount) : 'None'],
                  ['Categories', categoriesText(p.categories)],
                  ['Runs', `${formatUtc(p.startsAt)} – ${formatUtc(p.endsAt)}`],
                  ['Total uses', p.usageLimit === null ? 'No limit' : String(p.usageLimit)],
                  ['Per customer', p.perUserLimit === null ? 'No limit' : String(p.perUserLimit)],
                  ['First booking only', p.firstBookingOnly ? 'Yes' : 'No'],
                  ['Personal offer', p.userId ? <span className={mono}>{p.userId}</span> : 'No'],
                  ['Stacks with automatic offers', p.stackable ? 'Yes' : 'No'],
                  ['Listed publicly', p.listed ? 'Yes' : 'No'],
                  ['Version', `${p.version} (updated ${formatUtc(p.updatedAt)})`],
                  ['Terms', <span className="whitespace-pre-line">{p.terms}</span>],
                ]}
              />
              <p className="mt-3 text-caption text-ink-secondary">
                Released: {p.usage.released} · reversed (paid, then cancelled): {p.usage.reversed}.
                Every change is in the{' '}
                <Link
                  to={`${ADMIN_PATHS.audit}`}
                  className="font-medium text-brand-ink underline underline-offset-2"
                >
                  audit log
                </Link>
                .
              </p>
            </Section>
            {canManage ? (
              <Section title={p.active ? 'Switch off' : 'Switch on'}>
                <form
                  className="flex flex-col gap-3"
                  onSubmit={(e) => {
                    e.preventDefault();
                    toggle.mutate(!p.active);
                  }}
                >
                  <Field
                    label="Reason"
                    hint="At least 10 characters. Recorded in the audit log. Bookings holding it lose it before they pay."
                  >
                    <Input value={reason} onChange={(e) => setReason(e.target.value)} />
                  </Field>
                  {toggle.isError ? (
                    <Alert tone="danger" title="Not changed">
                      {errorText(toggle.error)}
                    </Alert>
                  ) : null}
                  <Button
                    type="submit"
                    variant={p.active ? 'destructive' : 'secondary'}
                    size="sm"
                    className="self-start"
                    loading={toggle.isPending}
                  >
                    {p.active ? 'Deactivate' : 'Activate'}
                  </Button>
                </form>
              </Section>
            ) : null}
            {canManage ? (
              editing ? (
                <PromotionForm existing={p} onDone={() => setEditing(false)} />
              ) : (
                <Button
                  variant="secondary"
                  size="sm"
                  className="self-start"
                  onClick={() => setEditing(true)}
                >
                  Edit configuration
                </Button>
              )
            ) : (
              <Note>Changing promotions needs an administrator.</Note>
            )}
            <Section title="Usage history">
              <QueryView query={usage} label="usage">
                {(u) =>
                  u.items.length === 0 ? (
                    <p className="text-body-sm text-ink-secondary">Not used yet.</p>
                  ) : (
                    <>
                      <Table
                        label="Promotion usage"
                        head={['Booking', 'Status', 'Discount', 'On', 'When', 'Closed']}
                      >
                        {u.items.map((r) => (
                          <tr key={r.id}>
                            <td>
                              <Link
                                to={ADMIN_PATHS.booking(r.bookingReference)}
                                className={`${link} ${mono}`}
                              >
                                {r.bookingReference}
                              </Link>
                            </td>
                            <td>{humanize(r.status)}</td>
                            <td className="numeric">{money(r.discount)}</td>
                            <td className="numeric">{money(r.eligibleAmount)}</td>
                            <td className="whitespace-nowrap">{formatUtc(r.createdAt)}</td>
                            <td>
                              {r.closedAt
                                ? `${humanize(r.closeReason ?? '')} · ${formatUtc(r.closedAt)}`
                                : '—'}
                            </td>
                          </tr>
                        ))}
                      </Table>
                      {u.pagination.totalPages > 1 ? (
                        <div className="mt-3 flex gap-2">
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={usagePage <= 1}
                            onClick={() => setUsagePage((n) => n - 1)}
                          >
                            Previous
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={usagePage >= u.pagination.totalPages}
                            onClick={() => setUsagePage((n) => n + 1)}
                          >
                            Next
                          </Button>
                        </div>
                      ) : null}
                    </>
                  )
                }
              </QueryView>
              <p className="mt-3 text-caption text-ink-secondary">
                Bookings only: no customer names or contact details.
              </p>
            </Section>
          </>
        )}
      </QueryView>
    </AdminPage>
  );
}

export function NewPromotionRoute() {
  return (
    <AdminPage title="New promotion" back={{ to: ADMIN_PATHS.promotions, label: 'Promotions' }}>
      <PromotionForm />
    </AdminPage>
  );
}

// ─── Form ─────────────────────────────────────────────────────────────────

const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;
/** ISO instant → "YYYY-MM-DDTHH:mm" in India time (for datetime-local inputs). */
const toLocal = (iso: string) =>
  new Date(Date.parse(iso) + IST_OFFSET_MS).toISOString().slice(0, 16);
/** "YYYY-MM-DDTHH:mm" (India time) → offset date-time. */
const fromLocal = (v: string) => (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(v) ? `${v}:00+05:30` : v);
/** "12.5" (%) → 1250 bps, without floats. */
function toBps(v: string): number | null {
  const m = /^(\d{1,2})(?:\.(\d{1,2}))?$/.exec(v.trim());
  if (!m) return null;
  return Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
}
const unitsOf = (minor: string | undefined) =>
  minor
    ? `${BigInt(minor) / 100n}${BigInt(minor) % 100n ? `.${(BigInt(minor) % 100n).toString().padStart(2, '0')}` : ''}`
    : '';

function PromotionForm({ existing, onDone }: { existing?: AdminPromotion; onDone?: () => void }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [f, setF] = useState(() => ({
    kind: (existing?.kind ?? 'coupon') as 'coupon' | 'automatic',
    code: existing?.code ?? '',
    name: existing?.name ?? '',
    description: existing?.description ?? '',
    terms: existing?.terms ?? '',
    discountType: (existing?.discountType ?? 'percentage') as 'percentage' | 'fixed',
    percent: existing?.percentBps ? (existing.percentBps / 100).toString() : '',
    amount: unitsOf(existing?.amount?.amountMinor),
    maxDiscount: unitsOf(existing?.maxDiscount?.amountMinor),
    minAmount: unitsOf(existing?.minAmount?.amountMinor),
    currency: existing?.currency ?? 'INR',
    categories: (existing?.categories ?? []) as TravelCategorySlug[],
    startsAt: existing ? toLocal(existing.startsAt) : '',
    endsAt: existing ? toLocal(existing.endsAt) : '',
    usageLimit: existing?.usageLimit?.toString() ?? '',
    perUserLimit: existing ? (existing.perUserLimit?.toString() ?? '') : '1',
    firstBookingOnly: existing?.firstBookingOnly ?? false,
    userId: existing?.userId ?? '',
    stackable: existing?.stackable ?? false,
    listed: existing?.listed ?? true,
    active: existing?.active ?? true,
    reason: '',
  }));
  const [problem, setProblem] = useState<string | null>(null);
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((s) => ({ ...s, [k]: v }));
  const save = useMutation({
    mutationFn: async (body: AdminPromotionInput & { reason?: string }) => {
      if (existing) {
        const { kind: _k, code: _c, ...rest } = body;
        return adminUpdatePromotion(existing.id, { ...rest, reason: body.reason ?? '' });
      }
      return adminCreatePromotion(body);
    },
    onSuccess: (p) => {
      queryClient.setQueryData(adminKeys.view('promotion', p.id), p);
      void queryClient.invalidateQueries({ queryKey: adminKeys.view('promotions') });
      if (existing) onDone?.();
      else void navigate(ADMIN_PATHS.promotion(p.id));
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setProblem(null);
    const money = (v: string) => {
      if (!v.trim()) return undefined;
      const m = toMinor(v);
      return m === null || m <= 0n ? null : m.toString();
    };
    const bps = f.discountType === 'percentage' ? toBps(f.percent) : undefined;
    const amount = f.discountType === 'fixed' ? money(f.amount) : undefined;
    const max = f.discountType === 'percentage' ? money(f.maxDiscount) : undefined;
    const min = money(f.minAmount);
    if (bps === null || amount === null || max === null || min === null) {
      return setProblem('Check the amounts: whole numbers or up to 2 decimals, above zero.');
    }
    const limit = (v: string) => (v.trim() ? Number(v) : null);
    save.mutate({
      kind: f.kind,
      ...(f.kind === 'coupon' ? { code: f.code } : {}),
      name: f.name,
      description: f.description,
      terms: f.terms,
      discountType: f.discountType,
      ...(bps !== undefined ? { percentBps: bps } : {}),
      ...(amount !== undefined ? { amountMinor: amount } : {}),
      ...(max !== undefined ? { maxDiscountMinor: max } : {}),
      minAmountMinor: min ?? '0',
      currency: f.currency.trim().toUpperCase(),
      categories: f.categories,
      startsAt: fromLocal(f.startsAt),
      endsAt: fromLocal(f.endsAt),
      usageLimit: limit(f.usageLimit),
      perUserLimit: limit(f.perUserLimit),
      firstBookingOnly: f.firstBookingOnly,
      userId: f.userId.trim() || null,
      stackable: f.kind === 'coupon' && f.stackable,
      listed: f.userId.trim() ? false : f.listed,
      active: f.active,
      ...(existing ? { reason: f.reason } : {}),
    });
  };

  return (
    <Section title={existing ? 'Edit configuration' : 'Configuration'}>
      <form noValidate onSubmit={submit} className="flex flex-col gap-4">
        {!existing ? (
          <RadioGroup legend="Kind" inline>
            <Radio
              label="Coupon (needs a code)"
              value="coupon"
              checked={f.kind === 'coupon'}
              onChange={() => set('kind', 'coupon')}
            />
            <Radio
              label="Automatic (no code)"
              value="automatic"
              checked={f.kind === 'automatic'}
              onChange={() => set('kind', 'automatic')}
            />
          </RadioGroup>
        ) : null}
        <div className="grid gap-4 sm:grid-cols-2">
          {f.kind === 'coupon' && !existing ? (
            <Field
              label="Code"
              hint="3–24 letters, digits or hyphens; stored in capitals; never reused."
            >
              <Input value={f.code} onChange={(e) => set('code', e.target.value)} />
            </Field>
          ) : null}
          <Field label="Name">
            <Input value={f.name} onChange={(e) => set('name', e.target.value)} />
          </Field>
        </div>
        <Field
          label="Description"
          hint="One line customers see, e.g. “10% off hotels, up to ₹1,000”."
        >
          <Input value={f.description} onChange={(e) => set('description', e.target.value)} />
        </Field>
        <Field label="Terms and conditions">
          <Textarea rows={4} value={f.terms} onChange={(e) => set('terms', e.target.value)} />
        </Field>
        <RadioGroup legend="Discount" inline>
          <Radio
            label="Percentage"
            value="percentage"
            checked={f.discountType === 'percentage'}
            onChange={() => set('discountType', 'percentage')}
          />
          <Radio
            label="Fixed amount"
            value="fixed"
            checked={f.discountType === 'fixed'}
            onChange={() => set('discountType', 'fixed')}
          />
        </RadioGroup>
        <div className="grid gap-4 sm:grid-cols-3">
          {f.discountType === 'percentage' ? (
            <>
              <Field label="Percent off" hint="Up to 90; e.g. 10 or 12.5">
                <Input
                  inputMode="decimal"
                  value={f.percent}
                  onChange={(e) => set('percent', e.target.value)}
                />
              </Field>
              <Field label={`Maximum discount (${f.currency})`} hint="Optional">
                <Input
                  inputMode="decimal"
                  value={f.maxDiscount}
                  onChange={(e) => set('maxDiscount', e.target.value)}
                />
              </Field>
            </>
          ) : (
            <Field label={`Amount off (${f.currency})`}>
              <Input
                inputMode="decimal"
                value={f.amount}
                onChange={(e) => set('amount', e.target.value)}
              />
            </Field>
          )}
          <Field label={`Minimum booking (${f.currency})`} hint="Optional">
            <Input
              inputMode="decimal"
              value={f.minAmount}
              onChange={(e) => set('minAmount', e.target.value)}
            />
          </Field>
          <Field label="Currency" hint="Bookings in other currencies don’t qualify.">
            <Select
              value={f.currency}
              onChange={(e) => set('currency', e.target.value)}
              options={['INR', 'USD', 'EUR', 'GBP', 'AED', 'SGD'].map((c) => ({
                value: c,
                label: c,
              }))}
            />
          </Field>
        </div>
        <fieldset className="flex flex-col gap-1">
          <legend className="mb-1 text-label text-ink">Categories (none ticked = all)</legend>
          <div className="flex flex-wrap gap-x-5">
            {travelCategorySlugSchema.options.map((c) => (
              <Checkbox
                key={c}
                label={humanize(c)}
                checked={f.categories.includes(c)}
                onChange={(e) =>
                  set(
                    'categories',
                    e.target.checked ? [...f.categories, c] : f.categories.filter((x) => x !== c),
                  )
                }
              />
            ))}
          </div>
        </fieldset>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Starts (India time)">
            <Input
              type="datetime-local"
              value={f.startsAt}
              onChange={(e) => set('startsAt', e.target.value)}
            />
          </Field>
          <Field label="Ends (India time)">
            <Input
              type="datetime-local"
              value={f.endsAt}
              onChange={(e) => set('endsAt', e.target.value)}
            />
          </Field>
          <Field label="Total uses" hint="Empty = no limit. Reserved and redeemed uses count.">
            <Input
              inputMode="numeric"
              value={f.usageLimit}
              onChange={(e) => set('usageLimit', e.target.value)}
            />
          </Field>
          <Field label="Uses per customer" hint="Empty = no limit.">
            <Input
              inputMode="numeric"
              value={f.perUserLimit}
              onChange={(e) => set('perUserLimit', e.target.value)}
            />
          </Field>
          <Field
            label="Personal offer for customer id"
            hint="Optional. Personal offers aren’t listed publicly."
          >
            <Input value={f.userId} onChange={(e) => set('userId', e.target.value)} />
          </Field>
        </div>
        <div className="flex flex-col gap-1">
          <Checkbox
            label="First confirmed booking only"
            checked={f.firstBookingOnly}
            onChange={(e) => set('firstBookingOnly', e.target.checked)}
          />
          {f.kind === 'coupon' ? (
            <Checkbox
              label="Combines with an automatic offer (applied after it)"
              checked={f.stackable}
              onChange={(e) => set('stackable', e.target.checked)}
            />
          ) : null}
          <Checkbox
            label="List on the offers page"
            checked={f.listed && !f.userId}
            disabled={Boolean(f.userId)}
            onChange={(e) => set('listed', e.target.checked)}
          />
          <Checkbox
            label="Active"
            checked={f.active}
            onChange={(e) => set('active', e.target.checked)}
          />
        </div>
        {existing ? (
          <Field
            label="Reason for the change"
            hint="At least 10 characters. Recorded in the audit log with what changed."
          >
            <Input value={f.reason} onChange={(e) => set('reason', e.target.value)} />
          </Field>
        ) : null}
        {problem || save.isError ? (
          <Alert tone="danger" title="Not saved">
            {problem ?? errorText(save.error)}
          </Alert>
        ) : null}
        <div className="flex gap-2">
          <Button type="submit" loading={save.isPending}>
            {existing ? 'Save changes' : 'Create promotion'}
          </Button>
          {existing ? (
            <Button type="button" variant="ghost" onClick={onDone}>
              Cancel
            </Button>
          ) : null}
        </div>
        <Note>
          Discounts never change an offer’s price; they are taken off at payment. Edits apply to new
          checkouts; uses already reserved keep their discount.
        </Note>
      </form>
    </Section>
  );
}
