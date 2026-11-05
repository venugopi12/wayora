import { useQuery } from '@tanstack/react-query';
import {
  ChevronLeft,
  ChevronRight,
  Clock,
  Gift,
  Hourglass,
  RotateCw,
  Sparkles,
  Ticket,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router';
import type { PublicRules, RewardsAccount, RewardTransaction } from '@wayora/contracts';
import {
  Alert,
  Badge,
  Button,
  EmptyState,
  ErrorState,
  Field,
  Select,
  Skeleton,
  cn,
} from '@wayora/ui';
import { useDocumentTitle } from '../../hooks/useDocumentTitle';
import { ApiClientError } from '../../lib/api-client';
import { getRewards, getRewardTransactions } from '../../services/rewards';
import { AccountShell, Panel } from '../account/AccountShell';
import { tripPath } from '../bookings/paths';
import {
  CATEGORY_NAME,
  CREDIT_REASON,
  CREDIT_STATUS,
  TRANSACTION_LABEL,
  formatDay,
  formatMonth,
  money,
  multiplier,
  percent,
  points,
} from './format';
import { rewardKeys } from './keys';

/*
 * /rewards (signed in): points, tier, travel credit, what's on the way and
 * what expires, the full history, and the rules (docs/rewards.md#web).
 * Every figure comes from the server; nothing is calculated here.
 */

const PAGE_SIZE = 15;
const KINDS = ['all', 'points', 'credits'] as const;
type Kind = (typeof KINDS)[number];

const errorRef = (error: unknown) =>
  error instanceof ApiClientError ? (error.requestId ?? undefined) : undefined;

export function RewardsRoute() {
  useDocumentTitle('Rewards');
  const summary = useQuery({
    queryKey: rewardKeys.summary,
    queryFn: ({ signal }) => getRewards(signal),
  });
  const account =
    summary.data?.accounts.find((a) => a.mode === 'demo') ?? summary.data?.accounts[0];

  return (
    <AccountShell
      title="Rewards"
      description="Points you earn on paid bookings, your tier, and travel credit from Wayora."
    >
      <Alert tone="warning" role="none" title="Demo rewards">
        Points and credit here come from demo bookings and demo payments. They have no cash value,
        can only be used on demo bookings, and are never a refund.
      </Alert>
      {summary.isPending ? (
        <div role="status" aria-label="Loading rewards" className="grid gap-4 md:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-36 rounded-xl" />
          ))}
        </div>
      ) : summary.isError ? (
        <ErrorState
          title="We couldn't load your rewards"
          description="Check your connection, then try again."
          reference={errorRef(summary.error)}
          action={
            <Button
              variant="secondary"
              onClick={() => void summary.refetch()}
              loading={summary.isFetching}
            >
              <RotateCw aria-hidden="true" />
              Try again
            </Button>
          }
        />
      ) : account ? (
        <>
          <Overview account={account} rules={summary.data.rules} />
          <Upcoming account={account} />
          <Credits account={account} />
          <Monthly account={account} />
          <History />
          <HowItWorks rules={summary.data.rules} />
        </>
      ) : null}
    </AccountShell>
  );
}

function Stat({
  label,
  icon,
  children,
  footer,
}: {
  label: string;
  icon: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-3 rounded-xl border border-line bg-card p-5 shadow-xs">
      <p className="flex items-center gap-2 text-label text-ink-secondary [&_svg]:size-4">
        {icon}
        {label}
      </p>
      <div className="min-w-0">{children}</div>
      {footer ? <div className="mt-auto text-caption text-ink-secondary">{footer}</div> : null}
    </div>
  );
}

function Overview({ account, rules }: { account: RewardsAccount; rules: PublicRules }) {
  const tier = account.tier;
  const next = tier.next;
  const progress = next
    ? Math.min(100, Math.round((tier.qualifyingPoints / next.minQualifyingPoints) * 100))
    : 100;
  return (
    <section aria-label="Your rewards" className="grid gap-4 md:grid-cols-3">
      <Stat
        label="Points balance"
        icon={<Sparkles aria-hidden="true" />}
        footer={
          account.balanceValue.length > 0 && account.pointsBalance > 0
            ? `Worth ${account.balanceValue.map(money).join(' or ')} off eligible demo bookings.`
            : `Earn points on paid demo bookings once the trip ends.`
        }
      >
        <p className="numeric text-heading-2 text-ink">{points(account.pointsBalance)}</p>
      </Stat>
      <Stat
        label="Tier"
        icon={<Gift aria-hidden="true" />}
        footer={
          tier.keptUntil
            ? `Kept at least until ${formatDay(tier.keptUntil)}.`
            : `Based on qualifying points in the last ${rules.qualificationMonths} months.`
        }
      >
        <p className="flex flex-wrap items-baseline gap-2">
          <span className="text-heading-2 text-ink">{tier.name}</span>
          <Badge size="sm" tone="brand">
            Earns {multiplier(tier.earnMultiplierBps)}
          </Badge>
        </p>
        {next ? (
          <div className="mt-3 flex flex-col gap-1.5">
            <div
              role="progressbar"
              aria-label={`Progress to ${next.name}`}
              aria-valuemin={0}
              aria-valuemax={next.minQualifyingPoints}
              aria-valuenow={Math.min(tier.qualifyingPoints, next.minQualifyingPoints)}
              aria-valuetext={`${tier.qualifyingPoints} of ${next.minQualifyingPoints} qualifying points`}
              className="h-2 overflow-hidden rounded-full bg-brand-soft"
            >
              <div className="h-full rounded-full bg-brand" style={{ width: `${progress}%` }} />
            </div>
            <p className="text-caption text-ink-secondary">
              {points(next.pointsNeeded)} more qualifying to reach {next.name}
            </p>
          </div>
        ) : (
          <p className="mt-2 text-caption text-ink-secondary">The highest tier.</p>
        )}
      </Stat>
      <Stat
        label="Travel credit"
        icon={<Ticket aria-hidden="true" />}
        footer="Credit from Wayora, separate from points. Not a cash refund."
      >
        <p className="numeric text-heading-2 text-ink">
          {account.creditBalance.length > 0 ? account.creditBalance.map(money).join(' + ') : '₹0'}
        </p>
      </Stat>
    </section>
  );
}

function Upcoming({ account }: { account: RewardsAccount }) {
  if (account.pending.length === 0 && account.expiring.length === 0) return null;
  return (
    <div className="grid gap-4 md:grid-cols-2">
      {account.pending.length > 0 ? (
        <Panel
          title="On the way"
          description="Estimated points for confirmed, paid bookings. They are added the day after the trip ends."
        >
          <ul className="flex flex-col divide-y divide-line">
            {account.pending.map((p) => (
              <li
                key={p.bookingReference}
                className="flex items-center justify-between gap-3 py-2.5 text-body-sm"
              >
                <span className="flex min-w-0 items-center gap-2">
                  <Hourglass className="size-4 shrink-0 text-ink-secondary" aria-hidden="true" />
                  <Link
                    to={tripPath(p.bookingReference)}
                    className="truncate font-mono font-semibold text-brand-ink hover:underline"
                  >
                    {p.bookingReference}
                  </Link>
                </span>
                <span className="text-right">
                  <span className="numeric block font-semibold">≈ {points(p.points)}</span>
                  <span className="text-caption text-ink-secondary">
                    from {formatDay(p.availableOn)}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}
      {account.expiring.length > 0 ? (
        <Panel
          title="Expiring soon"
          description="Points that expire in the next 90 days, soonest first. Points are used soonest-expiring first."
        >
          <ul className="flex flex-col divide-y divide-line">
            {account.expiring.map((e, i) => (
              <li
                key={`${e.expiresAt}-${i}`}
                className="flex items-center justify-between gap-3 py-2.5 text-body-sm"
              >
                <span className="flex items-center gap-2">
                  <Clock className="size-4 text-warning-ink" aria-hidden="true" />
                  {formatDay(e.expiresAt)}
                </span>
                <span className="numeric font-semibold">{points(e.points)}</span>
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}
    </div>
  );
}

function Credits({ account }: { account: RewardsAccount }) {
  return (
    <Panel
      title="Travel credit"
      description="Issued by Wayora for promotions or by our support team. Use it at checkout, all at once or in parts."
    >
      {account.credits.length === 0 ? (
        <p className="text-body-sm text-ink-secondary">You don’t have any travel credit.</p>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2">
          {account.credits.map((c) => (
            <li
              key={c.reference}
              className="flex min-w-0 flex-col gap-2 rounded-lg border border-line p-4"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-mono text-body-sm font-semibold">{c.reference}</span>
                <Badge size="sm" tone={c.status === 'active' ? 'success' : 'neutral'}>
                  {CREDIT_STATUS[c.status]}
                </Badge>
              </div>
              <p className="numeric text-heading-3">
                {money(c.remaining)}
                <span className="text-body-sm font-normal text-ink-secondary">
                  {' '}
                  of {money(c.original)}
                </span>
              </p>
              <p className="text-body-sm">{c.note}</p>
              <p className="text-caption text-ink-secondary">
                {CREDIT_REASON[c.reason]} · issued {formatDay(c.issuedAt)}
                {c.expiresAt ? ` · expires ${formatDay(c.expiresAt)}` : ' · no expiry'}
              </p>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function Monthly({ account }: { account: RewardsAccount }) {
  const months = account.monthly.filter((m) => m.earned > 0 || m.redeemed > 0);
  if (months.length === 0) return null;
  return (
    <Panel
      title="Points by month"
      description="Points earned and used per month (UTC), last 12 months. Months without activity are left out."
    >
      <div className="overflow-x-auto">
        <table className="w-full text-body-sm">
          <caption className="sr-only">Points earned and used per month</caption>
          <thead>
            <tr className="border-b border-line text-left text-ink-secondary">
              <th scope="col" className="py-2 pr-4 font-medium">
                Month
              </th>
              <th scope="col" className="py-2 pr-4 text-right font-medium">
                Earned
              </th>
              <th scope="col" className="py-2 text-right font-medium">
                Used
              </th>
            </tr>
          </thead>
          <tbody>
            {months.map((m) => (
              <tr key={m.month} className="border-b border-line last:border-0">
                <th scope="row" className="py-2 pr-4 text-left font-normal">
                  {formatMonth(m.month)}
                </th>
                <td className="numeric py-2 pr-4 text-right">
                  {m.earned > 0 ? `+${points(m.earned)}` : '—'}
                </td>
                <td className="numeric py-2 text-right">
                  {m.redeemed > 0 ? `−${points(m.redeemed)}` : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

function amountOf(t: RewardTransaction): { text: string; positive: boolean } | null {
  if (t.amount) {
    const minor = BigInt(t.amount.amountMinor);
    const abs = { ...t.amount, amountMinor: (minor < 0n ? -minor : minor).toString() };
    return { text: `${minor < 0n ? '−' : '+'}${money(abs)}`, positive: minor > 0n };
  }
  if (t.points === 0) return null;
  return {
    text: `${t.points > 0 ? '+' : '−'}${points(Math.abs(t.points))}`,
    positive: t.points > 0,
  };
}

function History() {
  const [params, setParams] = useSearchParams();
  const kindParam = params.get('show');
  const kind: Kind = (KINDS as readonly string[]).includes(kindParam ?? '')
    ? (kindParam as Kind)
    : 'all';
  const pageParam = Number(params.get('page') ?? '1');
  const page = Number.isInteger(pageParam) && pageParam >= 1 && pageParam <= 1000 ? pageParam : 1;
  const history = useQuery({
    queryKey: rewardKeys.history(kind, page),
    queryFn: ({ signal }) => getRewardTransactions({ kind, page, pageSize: PAGE_SIZE }, signal),
    placeholderData: (previous) => previous,
  });
  const set = (next: { show?: Kind; page?: number }) => {
    const p = new URLSearchParams(params);
    const show = next.show ?? kind;
    const pg = next.page ?? 1;
    if (show === 'all') p.delete('show');
    else p.set('show', show);
    if (pg === 1) p.delete('page');
    else p.set('page', String(pg));
    setParams(p, { replace: next.page === undefined });
  };
  return (
    <section aria-labelledby="reward-history" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h2 id="reward-history" className="text-title">
          History
        </h2>
        <Field label="Show" className="w-44">
          <Select
            value={kind}
            onChange={(e) => set({ show: e.target.value as Kind })}
            options={[
              { value: 'all', label: 'Everything' },
              { value: 'points', label: 'Points' },
              { value: 'credits', label: 'Travel credit' },
            ]}
          />
        </Field>
      </div>
      {history.isPending ? (
        <Skeleton className="h-48 rounded-xl" />
      ) : history.isError ? (
        <ErrorState
          title="We couldn't load your history"
          description="Check your connection, then try again."
          reference={errorRef(history.error)}
          action={
            <Button variant="secondary" onClick={() => void history.refetch()}>
              <RotateCw aria-hidden="true" />
              Try again
            </Button>
          }
        />
      ) : history.data.items.length === 0 ? (
        <div className="rounded-xl border border-dashed border-line-strong bg-card">
          <EmptyState
            icon={<Sparkles />}
            title="Nothing here yet"
            description="Points you earn or use, and travel credit you receive, will be listed here."
          />
        </div>
      ) : (
        <>
          <p className="sr-only" aria-live="polite">
            {history.data.pagination.totalResults} entries, page {page}.
          </p>
          <ul
            aria-label="Rewards history"
            className={cn(
              'flex flex-col divide-y divide-line rounded-xl border border-line bg-card px-4 shadow-xs sm:px-5',
              history.isPlaceholderData && 'opacity-60',
            )}
          >
            {history.data.items.map((t) => {
              const amount = amountOf(t);
              return (
                <li key={t.id} className="flex items-start justify-between gap-4 py-3.5">
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <p className="flex flex-wrap items-center gap-2 text-body-sm font-semibold">
                      {TRANSACTION_LABEL[t.type]}
                      {t.origin === 'manual' ? (
                        <Badge size="sm" tone="neutral">
                          By Wayora support
                        </Badge>
                      ) : null}
                    </p>
                    <p className="text-body-sm text-ink-secondary">{t.description}</p>
                    <p className="text-caption text-ink-secondary">
                      {formatDay(t.createdAt)}
                      {t.bookingReference ? (
                        <>
                          {' · '}
                          <Link
                            to={tripPath(t.bookingReference)}
                            className="font-mono text-brand-ink hover:underline"
                          >
                            {t.bookingReference}
                          </Link>
                        </>
                      ) : null}
                      {t.balanceAfter !== null ? ` · balance ${points(t.balanceAfter)}` : ''}
                    </p>
                  </div>
                  {amount ? (
                    <span
                      className={cn(
                        'numeric shrink-0 text-body-sm font-semibold',
                        amount.positive ? 'text-success-ink' : 'text-ink',
                      )}
                    >
                      {amount.text}
                    </span>
                  ) : null}
                </li>
              );
            })}
          </ul>
          {history.data.pagination.totalPages > 1 ? (
            <nav aria-label="History pages" className="flex items-center justify-between gap-3">
              <Button
                variant="ghost"
                size="sm"
                disabled={page <= 1}
                onClick={() => set({ page: page - 1 })}
              >
                <ChevronLeft aria-hidden="true" />
                Previous
              </Button>
              <p className="text-body-sm text-ink-secondary">
                Page {page} of {history.data.pagination.totalPages}
              </p>
              <Button
                variant="ghost"
                size="sm"
                disabled={page >= history.data.pagination.totalPages}
                onClick={() => set({ page: page + 1 })}
              >
                Next
                <ChevronRight aria-hidden="true" />
              </Button>
            </nav>
          ) : null}
        </>
      )}
    </section>
  );
}

function HowItWorks({ rules }: { rules: PublicRules }) {
  const earnCategories = Object.entries(rules.earn.categoryMultiplierBps)
    .filter(([, bps]) => bps > 0)
    .map(([c]) => CATEGORY_NAME[c] ?? c);
  return (
    <Panel
      title="How rewards work"
      description={`Rules version ${rules.version}. Wayora calculates every figure; your app never decides a discount.`}
    >
      <div className="grid gap-6 text-body-sm md:grid-cols-2">
        <div className="flex flex-col gap-2">
          <h3 className="text-label text-ink">Earning</h3>
          <ul className="flex list-disc flex-col gap-1.5 pl-5 text-ink-secondary">
            <li>
              1 point per {rules.earn.spendPerPoint.map(money).join(' / ')} actually paid, on{' '}
              {earnCategories.join(', ')}. Points and travel credit you use don’t earn points.
            </li>
            <li>
              Added the day after the trip ends
              {rules.earn.availableAfterDays > 1 ? ` (+${rules.earn.availableAfterDays} days)` : ''}
              , if the booking is still confirmed and paid. Cancelled, expired or unpaid bookings
              earn nothing.
            </li>
            <li>Your tier multiplies the points you earn.</li>
            <li>Points expire {rules.earn.expiryMonths} months after they’re added.</li>
            {rules.earn.campaigns.map((c) => (
              <li key={c.name}>
                {c.name}: +{percent(c.bonusBps)} on bookings confirmed {formatDay(c.startsAt)} –{' '}
                {formatDay(c.endsAt)}.
              </li>
            ))}
          </ul>
        </div>
        <div className="flex flex-col gap-2">
          <h3 className="text-label text-ink">Using points</h3>
          <ul className="flex list-disc flex-col gap-1.5 pl-5 text-ink-secondary">
            <li>1 point = {rules.redeem.pointValue.map(money).join(' / ')} off at checkout.</li>
            <li>
              From {points(rules.redeem.minPoints)} up to {points(rules.redeem.maxPointsPerBooking)}{' '}
              per booking, and at most {percent(rules.redeem.maxPointsCoverageBps)} of its total.
            </li>
            <li>
              On {rules.redeem.categories.map((c) => CATEGORY_NAME[c] ?? c).join(', ')}, before you
              pay.
            </li>
            <li>
              If the booking is cancelled or expires, the points and credit you used come back.
            </li>
          </ul>
        </div>
        <div className="flex flex-col gap-2 md:col-span-2">
          <h3 className="text-label text-ink">Tiers</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-body-sm">
              <caption className="sr-only">Tiers and what they need</caption>
              <thead>
                <tr className="border-b border-line text-left text-ink-secondary">
                  <th scope="col" className="py-2 pr-4 font-medium">
                    Tier
                  </th>
                  <th scope="col" className="py-2 pr-4 font-medium">
                    Qualifying points ({rules.qualificationMonths} months)
                  </th>
                  <th scope="col" className="py-2 font-medium">
                    Earning
                  </th>
                </tr>
              </thead>
              <tbody>
                {rules.tiers.map((t) => (
                  <tr key={t.id} className="border-b border-line last:border-0">
                    <th scope="row" className="py-2 pr-4 text-left font-semibold">
                      {t.name}
                    </th>
                    <td className="numeric py-2 pr-4">
                      {t.minQualifyingPoints === 0
                        ? 'Everyone'
                        : `${points(t.minQualifyingPoints)}+`}
                    </td>
                    <td className="numeric py-2">{multiplier(t.earnMultiplierBps)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-caption text-ink-secondary">
            Qualifying points are the base points from paid bookings, before tier and campaign
            bonuses. A tier you reach is kept for {rules.qualificationMonths} months; after that it
            follows your qualifying points. The only tier benefit is the earning rate: no other
            perks are promised.
          </p>
        </div>
      </div>
    </Panel>
  );
}
