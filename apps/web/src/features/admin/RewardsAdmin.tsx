import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router';
import {
  REWARD_TRANSACTION_TYPES,
  loyaltyRulesSchema,
  travelCreditReasonSchema,
  type AdminRewardTransaction,
  type AdminUserRewards,
  type TravelCreditReason,
} from '@wayora/contracts';
import { Alert, Badge, Button, Field, Input, Select, Textarea } from '@wayora/ui';
import { ApiClientError } from '../../lib/api-client';
import {
  adminAdjustPoints,
  adminCreateRewardRules,
  adminIssueCredit,
  adminRevokeCredit,
  adminRewardRules,
  adminRewardTransactions,
  adminUserRewards,
} from '../../services/rewards';
import { toMinor } from '../rewards/CheckoutRewards';
import {
  CREDIT_REASON,
  CREDIT_STATUS,
  TRANSACTION_LABEL,
  multiplier,
  points,
} from '../rewards/format';
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
  Table,
  money,
  useFilters,
} from './ui';

/*
 * Admin rewards (Phase 25, docs/rewards.md#admin). Reading needs
 * admin.rewards.read (support and admins); adjustments, credit and rules
 * need admin.rewards.manage (admins only). The API enforces both and audits
 * every write; hiding a form here is presentation only.
 */

const link = 'font-medium text-brand-ink underline-offset-2 hover:underline';
const mono = 'font-mono text-caption';
const DEMO_NOTE =
  'Demo rewards come from demo bookings and demo payments: they have no cash value and only pay towards demo bookings. Travel credit is never a cash refund.';

const errorText = (error: unknown) =>
  error instanceof ApiClientError
    ? [error.message, ...error.details.map((d) => d.message)].filter(Boolean).join(' ')
    : 'Something went wrong. Try again.';

function amountText(t: AdminRewardTransaction) {
  if (t.amount) {
    const m = BigInt(t.amount.amountMinor);
    return `${m < 0n ? '−' : '+'}${money({ ...t.amount, amountMinor: (m < 0n ? -m : m).toString() })}`;
  }
  return t.points === 0 ? '0 pts' : `${t.points > 0 ? '+' : '−'}${points(Math.abs(t.points))}`;
}

function TransactionsTable({
  items,
  showUser,
}: {
  items: AdminRewardTransaction[];
  showUser: boolean;
}) {
  return (
    <Table
      label="Reward transactions"
      head={['When', 'Type', ...(showUser ? ['User'] : []), 'Change', 'Description', 'Origin']}
    >
      {items.map((t) => (
        <tr key={t.id}>
          <td className="whitespace-nowrap">{formatUtc(t.createdAt)}</td>
          <td>
            {TRANSACTION_LABEL[t.type]}
            {t.mode === 'demo' ? (
              <Badge size="sm" tone="warning" className="ml-2">
                Demo
              </Badge>
            ) : null}
          </td>
          {showUser ? (
            <td>
              <Link to={ADMIN_PATHS.rewardsUser(t.userId)} className={`${link} ${mono}`}>
                {t.userId.slice(0, 8)}…
              </Link>
            </td>
          ) : null}
          <td className="numeric whitespace-nowrap">{amountText(t)}</td>
          <td>
            {t.description}
            {t.bookingReference ? (
              <>
                {' · '}
                <Link to={ADMIN_PATHS.booking(t.bookingReference)} className={`${link} ${mono}`}>
                  {t.bookingReference}
                </Link>
              </>
            ) : null}
            {t.reason ? (
              <span className="block text-caption text-ink-secondary">Reason: {t.reason}</span>
            ) : null}
          </td>
          <td>
            {t.origin === 'manual' ? (
              <Badge size="sm" tone="brand">
                Manual ({humanize(t.actorType)})
              </Badge>
            ) : (
              <span className="text-ink-secondary">Automated</span>
            )}
          </td>
        </tr>
      ))}
    </Table>
  );
}

export function RewardsRoute() {
  const { values, page } = useFilters(['userId', 'type', 'origin', 'mode']);
  const query = useQuery({
    queryKey: adminKeys.view('rewards', values, page),
    queryFn: ({ signal }) => adminRewardTransactions({ ...values, page } as never, signal),
    placeholderData: (previous) => previous,
  });
  return (
    <AdminPage
      title="Rewards"
      description="The loyalty ledger: every change to points and travel credit, newest first."
      actions={
        <Link to={ADMIN_PATHS.rewardsRules} className={link}>
          Rules and versions
        </Link>
      }
    >
      <Note>{DEMO_NOTE}</Note>
      <FilterBar
        label="Filter reward transactions"
        specs={[
          { name: 'userId', label: 'User id', kind: 'text', placeholder: 'UUID' },
          {
            name: 'type',
            label: 'Type',
            kind: 'select',
            options: REWARD_TRANSACTION_TYPES.map((t) => ({
              value: t,
              label: TRANSACTION_LABEL[t],
            })),
          },
          {
            name: 'origin',
            label: 'Origin',
            kind: 'select',
            options: [
              { value: 'automated', label: 'Automated' },
              { value: 'manual', label: 'Manual' },
            ],
          },
          {
            name: 'mode',
            label: 'Mode',
            kind: 'select',
            options: [
              { value: 'demo', label: 'Demo' },
              { value: 'live', label: 'Live' },
            ],
          },
        ]}
      />
      <QueryView query={query} label="reward transactions">
        {(data) =>
          data.items.length === 0 ? (
            <EmptyRows what="reward transactions" />
          ) : (
            <>
              <TransactionsTable items={data.items} showUser />
              <Pager pagination={data.pagination} label="Reward transactions" />
            </>
          )
        }
      </QueryView>
    </AdminPage>
  );
}

export function UserRewardsRoute() {
  const { userId = '' } = useParams();
  const canManage = useCan('admin.rewards.manage');
  const query = useQuery({
    queryKey: adminKeys.view('rewards-user', userId),
    queryFn: ({ signal }) => adminUserRewards(userId, signal),
  });
  return (
    <AdminPage title="Customer rewards" back={{ to: ADMIN_PATHS.user(userId), label: 'User' }}>
      <QueryView
        query={query}
        label="this user's rewards"
        notFound="There is no user with that id."
      >
        {(u) => (
          <>
            <Note>{DEMO_NOTE}</Note>
            <Section title={u.name ?? 'Customer'}>
              {u.accounts.length === 0 ? (
                <p className="text-body-sm text-ink-secondary">No points account yet.</p>
              ) : (
                u.accounts.map((a) => (
                  <DetailList
                    key={a.mode}
                    items={[
                      ['Mode', a.mode === 'demo' ? 'Demo (no cash value)' : 'Live'],
                      ['Points balance', points(a.pointsBalance)],
                      [
                        'Ledger sum',
                        a.ledgerSum === a.pointsBalance ? (
                          points(a.ledgerSum)
                        ) : (
                          <span className="font-semibold text-danger-ink">
                            {points(a.ledgerSum)} — does not match the balance
                          </span>
                        ),
                      ],
                      ['Tier', `${a.tier.name} (${multiplier(a.tier.earnMultiplierBps)})`],
                      ['Qualifying points', points(a.tier.qualifyingPoints)],
                      ['Tier kept until', a.tier.keptUntil ? formatUtc(a.tier.keptUntil) : '—'],
                    ]}
                  />
                ))
              )}
              <p className="mt-3 text-caption text-ink-secondary">
                <span className={mono}>{u.userId}</span> · contact details aren’t shown here.
              </p>
            </Section>
            <CreditsSection rewards={u} canManage={canManage} />
            {canManage ? (
              <div className="grid gap-4 lg:grid-cols-2">
                <AdjustPoints userId={u.userId} />
                <IssueCredit userId={u.userId} />
              </div>
            ) : (
              <Note>Adjusting points or issuing credit needs an administrator.</Note>
            )}
            <Section title="Recent transactions">
              {u.recent.length === 0 ? (
                <p className="text-body-sm text-ink-secondary">None.</p>
              ) : (
                <TransactionsTable items={u.recent} showUser={false} />
              )}
              <p className="mt-3">
                <Link to={`${ADMIN_PATHS.rewards}?userId=${u.userId}`} className={link}>
                  All of this customer’s transactions
                </Link>
              </p>
            </Section>
          </>
        )}
      </QueryView>
    </AdminPage>
  );
}

function useUserRewardsUpdate(userId: string) {
  const queryClient = useQueryClient();
  return (data: AdminUserRewards) => {
    queryClient.setQueryData(adminKeys.view('rewards-user', userId), data);
    void queryClient.invalidateQueries({ queryKey: adminKeys.view('rewards') });
  };
}

function CreditsSection({ rewards, canManage }: { rewards: AdminUserRewards; canManage: boolean }) {
  const update = useUserRewardsUpdate(rewards.userId);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const revoke = useMutation({
    mutationFn: (reference: string) => adminRevokeCredit(reference, reason),
    onSuccess: (data) => {
      update(data);
      setRevoking(null);
      setReason('');
    },
  });
  return (
    <Section title="Travel credit">
      {rewards.credits.length === 0 ? (
        <p className="text-body-sm text-ink-secondary">No travel credit.</p>
      ) : (
        <Table
          label="Travel credit"
          head={['Reference', 'Remaining', 'Reason', 'Status', 'Expires', '']}
        >
          {rewards.credits.map((c) => (
            <tr key={c.reference}>
              <td className={mono}>{c.reference}</td>
              <td className="numeric whitespace-nowrap">
                {money(c.remaining)}{' '}
                <span className="text-ink-secondary">of {money(c.original)}</span>
              </td>
              <td>
                {CREDIT_REASON[c.reason]}
                <span className="block text-caption text-ink-secondary">{c.note}</span>
              </td>
              <td>{CREDIT_STATUS[c.status]}</td>
              <td className="whitespace-nowrap">
                {c.expiresAt ? formatUtc(c.expiresAt) : 'No expiry'}
              </td>
              <td>
                {canManage && c.status === 'active' ? (
                  <Button variant="ghost" size="sm" onClick={() => setRevoking(c.reference)}>
                    Withdraw…
                  </Button>
                ) : null}
              </td>
            </tr>
          ))}
        </Table>
      )}
      {revoking ? (
        <form
          className="mt-4 flex flex-col gap-3 rounded-lg border border-line p-4"
          onSubmit={(e) => {
            e.preventDefault();
            revoke.mutate(revoking);
          }}
        >
          <Field
            label={`Why withdraw ${revoking}?`}
            hint="At least 10 characters. Recorded in the audit log."
          >
            <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} />
          </Field>
          {revoke.isError ? (
            <Alert tone="danger" title="Not withdrawn">
              {errorText(revoke.error)}
            </Alert>
          ) : null}
          <div className="flex gap-2">
            <Button type="submit" variant="destructive" size="sm" loading={revoke.isPending}>
              Withdraw credit
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => setRevoking(null)}>
              Cancel
            </Button>
          </div>
        </form>
      ) : null}
    </Section>
  );
}

function AdjustPoints({ userId }: { userId: string }) {
  const update = useUserRewardsUpdate(userId);
  const [form, setForm] = useState({ points: '', reason: '' });
  // One key per intended adjustment: a double submit or retry applies once.
  const [key, setKey] = useState(() => crypto.randomUUID());
  const [done, setDone] = useState<string | null>(null);
  const adjust = useMutation({
    mutationFn: () =>
      adminAdjustPoints(userId, {
        mode: 'demo',
        points: Number(form.points),
        reason: form.reason,
        idempotencyKey: key,
      }),
    onSuccess: (data) => {
      update(data);
      setDone(`${form.points} points recorded.`);
      setForm({ points: '', reason: '' });
      setKey(crypto.randomUUID());
    },
  });
  const valid = /^-?[1-9]\d{0,6}$/.test(form.points);
  return (
    <Section title="Adjust demo points">
      <form
        noValidate
        className="flex flex-col gap-3"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          setDone(null);
          if (valid) adjust.mutate();
        }}
      >
        <Field
          label="Points"
          hint="Positive adds, negative removes. The balance can’t go below zero."
        >
          <Input
            inputMode="numeric"
            value={form.points}
            onChange={(e) => setForm((f) => ({ ...f, points: e.target.value }))}
          />
        </Field>
        <Field
          label="Reason"
          hint="Required (at least 10 characters). Shown in the audit log and history."
        >
          <Textarea
            rows={2}
            value={form.reason}
            onChange={(e) => setForm((f) => ({ ...f, reason: e.target.value }))}
          />
        </Field>
        {adjust.isError ? (
          <Alert tone="danger" title="Not adjusted">
            {errorText(adjust.error)}
          </Alert>
        ) : null}
        {done ? (
          <p role="status" className="text-body-sm text-success-ink">
            {done}
          </p>
        ) : null}
        <Button
          type="submit"
          variant="secondary"
          size="sm"
          className="self-start"
          disabled={!valid}
          loading={adjust.isPending}
        >
          Record adjustment
        </Button>
      </form>
    </Section>
  );
}

function IssueCredit({ userId }: { userId: string }) {
  const update = useUserRewardsUpdate(userId);
  const blank = {
    amount: '',
    reason: 'support_compensation' as TravelCreditReason,
    note: '',
    justification: '',
    expiresOn: '',
    bookingReference: '',
  };
  const [form, setForm] = useState(blank);
  const [key, setKey] = useState(() => crypto.randomUUID());
  const [problem, setProblem] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const issue = useMutation({
    mutationFn: (amountMinor: string) =>
      adminIssueCredit(userId, {
        mode: 'demo',
        amount: { amountMinor, currency: 'INR' },
        reason: form.reason,
        note: form.note,
        justification: form.justification,
        idempotencyKey: key,
        ...(form.expiresOn ? { expiresOn: form.expiresOn } : {}),
        ...(form.bookingReference
          ? { bookingReference: form.bookingReference.trim().toUpperCase() }
          : {}),
      }),
    onSuccess: (data) => {
      update(data);
      setDone('Credit issued.');
      setForm(blank);
      setKey(crypto.randomUUID());
    },
  });
  const set = (k: keyof typeof blank) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));
  return (
    <Section title="Issue demo travel credit">
      <form
        noValidate
        className="flex flex-col gap-3"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          setDone(null);
          const minor = toMinor(form.amount);
          if (minor === null || minor <= 0n)
            return setProblem('Enter an amount like 500 or 499.50.');
          setProblem(null);
          issue.mutate(minor.toString());
        }}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Amount (INR)">
            <Input inputMode="decimal" value={form.amount} onChange={set('amount')} />
          </Field>
          <Field label="Reason">
            <Select
              value={form.reason}
              onChange={set('reason')}
              options={travelCreditReasonSchema.options.map((r) => ({
                value: r,
                label: CREDIT_REASON[r],
              }))}
            />
          </Field>
        </div>
        <Field label="Note for the customer">
          <Input value={form.note} onChange={set('note')} />
        </Field>
        <Field label="Justification" hint="Why it’s issued (at least 10 characters). Audit only.">
          <Textarea rows={2} value={form.justification} onChange={set('justification')} />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Expires on (optional)">
            <Input type="date" value={form.expiresOn} onChange={set('expiresOn')} />
          </Field>
          <Field label="Related booking (optional)">
            <Input
              value={form.bookingReference}
              placeholder="WYD-"
              onChange={set('bookingReference')}
            />
          </Field>
        </div>
        {problem || issue.isError ? (
          <Alert tone="danger" title="Not issued">
            {problem ?? errorText(issue.error)}
          </Alert>
        ) : null}
        {done ? (
          <p role="status" className="text-body-sm text-success-ink">
            {done}
          </p>
        ) : null}
        <Button
          type="submit"
          variant="secondary"
          size="sm"
          className="self-start"
          loading={issue.isPending}
        >
          Issue credit
        </Button>
      </form>
    </Section>
  );
}

export function RewardRulesRoute() {
  const canManage = useCan('admin.rewards.manage');
  const query = useQuery({
    queryKey: adminKeys.view('reward-rules'),
    queryFn: ({ signal }) => adminRewardRules(signal),
  });
  return (
    <AdminPage
      title="Reward rules"
      description="Earning, redemption, tiers and expiry. Each change is a new version; transactions keep the version they were calculated with."
      back={{ to: ADMIN_PATHS.rewards, label: 'Rewards' }}
    >
      <QueryView query={query} label="the reward rules">
        {(data) => (
          <>
            <Section title={`In force: version ${data.active.version}`}>
              <DetailList
                items={[
                  ['Since', formatUtc(data.active.effectiveFrom)],
                  ['Reason', data.active.reason],
                  [
                    'Earning',
                    Object.entries(data.active.config.earn.spendMinorPerPoint)
                      .map(([c, m]) => `1 pt per ${money({ amountMinor: m, currency: c })}`)
                      .join(', '),
                  ],
                  [
                    'Point value',
                    Object.entries(data.active.config.redeem.pointValueMinor)
                      .map(([c, m]) => money({ amountMinor: m, currency: c }))
                      .join(', '),
                  ],
                  [
                    'Redemption',
                    `${points(data.active.config.redeem.minPoints)} – ${points(data.active.config.redeem.maxPointsPerBooking)}, at most ${data.active.config.redeem.maxPointsCoverageBps / 100}% of a booking`,
                  ],
                  [
                    'Tiers',
                    data.active.config.tiers
                      .map(
                        (t) =>
                          `${t.name} ${t.minQualifyingPoints}+ ${multiplier(t.earnMultiplierBps)}`,
                      )
                      .join(' · '),
                  ],
                  ['Expiry', `${data.active.config.earn.expiryMonths} months`],
                ]}
              />
            </Section>
            {canManage ? <NewRulesForm current={data.active.config} /> : null}
            <Section title="Versions">
              <Table
                label="Rule versions"
                head={['Version', 'In force from', 'Created by', 'Reason']}
              >
                {data.versions.map((v) => (
                  <tr key={v.version}>
                    <td className="numeric">{v.version}</td>
                    <td className="whitespace-nowrap">{formatUtc(v.effectiveFrom)}</td>
                    <td>{v.manual ? 'An administrator' : 'Shipped with Phase 25'}</td>
                    <td>{v.reason}</td>
                  </tr>
                ))}
              </Table>
            </Section>
          </>
        )}
      </QueryView>
    </AdminPage>
  );
}

function NewRulesForm({ current }: { current: unknown }) {
  const queryClient = useQueryClient();
  const [text, setText] = useState(() => JSON.stringify(current, null, 2));
  const [reason, setReason] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: (config: unknown) => adminCreateRewardRules({ config: config as never, reason }),
    onSuccess: (data) => {
      queryClient.setQueryData(adminKeys.view('reward-rules'), data);
      setReason('');
    },
  });
  return (
    <Section title="Create a new version">
      <form
        noValidate
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          let parsed: unknown;
          try {
            parsed = JSON.parse(text);
          } catch {
            return setProblem('That isn’t valid JSON.');
          }
          const check = loyaltyRulesSchema.safeParse(parsed);
          if (!check.success) {
            return setProblem(
              check.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(' '),
            );
          }
          setProblem(null);
          create.mutate(parsed);
        }}
      >
        <Note>
          Takes effect immediately for new calculations. Money is in minor units (paise) and
          multipliers in basis points (10000 = ×1). The server validates the whole rule set again.
        </Note>
        <Field label="Rules (JSON)">
          <Textarea
            rows={16}
            className="font-mono text-caption"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        </Field>
        <Field
          label="Reason"
          hint="Required (at least 10 characters). Recorded with the version and in the audit log."
        >
          <Input value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
        {problem || create.isError ? (
          <Alert tone="danger" title="Not saved">
            {problem ?? errorText(create.error)}
          </Alert>
        ) : null}
        <Button
          type="submit"
          variant="secondary"
          size="sm"
          className="self-start"
          loading={create.isPending}
        >
          Save as new version
        </Button>
      </form>
    </Section>
  );
}
