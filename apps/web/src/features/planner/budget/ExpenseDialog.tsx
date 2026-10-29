import { useMutation } from '@tanstack/react-query';
import { useMemo, useRef, useState, type FormEvent } from 'react';
import {
  BUDGET_CURRENCIES,
  EXPENSE_CATEGORIES,
  EXPENSE_CATEGORY_LABELS,
  minorToInput,
  parseMoneyInput,
  parsePercentInput,
  splitByBasisPoints,
  splitEqual,
  type BudgetCurrency,
  type BudgetPerson,
  type CreateExpenseInput,
  type Expense,
  type ExpenseCategory,
  type SplitMethod,
} from '@wayora/contracts';
import {
  Alert,
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  Field,
  Input,
  Radio,
  RadioGroup,
  Select,
  Textarea,
} from '@wayora/ui';
import { ApiClientError } from '../../../lib/api-client';
import { createExpense, updateExpense } from '../../../services/planner';
import { money } from './money';

/*
 * Add or edit an expense (docs/planner.md#expenses). The form previews each
 * person's share with the same exact functions the API uses; the API still
 * computes and checks everything itself. Editing sends the whole expense
 * again (with its version), so nothing changes that the person didn't see.
 */

const SEVERAL = '__several';

interface Draft {
  description: string;
  category: ExpenseCategory | '';
  amount: string;
  currency: BudgetCurrency;
  spentOn: string;
  status: 'paid' | 'planned';
  payer: string; // a person id or SEVERAL
  payerAmounts: Record<string, string>;
  method: SplitMethod;
  participants: string[];
  customAmounts: Record<string, string>;
  percents: Record<string, string>;
  notes: string;
}

function draftFrom(
  expense: Expense | null,
  defaults: { currency: BudgetCurrency; day: string; you: string },
): Draft {
  if (!expense) {
    return {
      description: '',
      category: '',
      amount: '',
      currency: defaults.currency,
      spentOn: defaults.day,
      status: 'paid',
      payer: defaults.you,
      payerAmounts: {},
      method: 'equal',
      participants: [],
      customAmounts: {},
      percents: {},
      notes: '',
    };
  }
  const payers = expense.parts.filter((p) => BigInt(p.paidMinor) > 0n);
  const sharers = expense.parts.filter((p) => BigInt(p.shareMinor) > 0n || p.basisPoints);
  const c = expense.currency;
  return {
    description: expense.description,
    category: expense.category,
    amount: minorToInput(expense.amountMinor, c),
    currency: c,
    spentOn: expense.spentOn,
    status: expense.status,
    payer: payers.length === 1 ? payers[0]!.personId : payers.length > 1 ? SEVERAL : defaults.you,
    payerAmounts: Object.fromEntries(payers.map((p) => [p.personId, minorToInput(p.paidMinor, c)])),
    method: expense.splitMethod ?? 'equal',
    participants: sharers.map((p) => p.personId),
    customAmounts: Object.fromEntries(
      sharers.map((p) => [p.personId, minorToInput(p.shareMinor, c)]),
    ),
    percents: Object.fromEntries(
      sharers
        .filter((p) => p.basisPoints)
        .map((p) => [
          p.personId,
          `${Math.floor(p.basisPoints! / 100)}.${String(p.basisPoints! % 100).padStart(2, '0')}`,
        ]),
    ),
    notes: expense.notes ?? '',
  };
}

/** The request body, or a list of problems to show. */
function toBody(d: Draft): { body: CreateExpenseInput } | { problems: Record<string, string> } {
  const problems: Record<string, string> = {};
  const description = d.description.trim();
  if (!description) problems.description = 'Enter a description.';
  if (!d.category) problems.category = 'Choose a category.';
  const amount = parseMoneyInput(d.amount, d.currency);
  if (!amount) problems.amount = 'Enter an amount above zero, like 1499.50.';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d.spentOn)) problems.spentOn = 'Choose a date.';
  const base = {
    description,
    category: d.category as ExpenseCategory,
    amountMinor: amount ?? '0',
    currency: d.currency,
    spentOn: d.spentOn,
    notes: d.notes,
  };
  if (d.status === 'planned') {
    return Object.keys(problems).length ? { problems } : { body: { ...base, status: 'planned' } };
  }
  // Who paid
  let paidBy: { personId: string; amountMinor: string }[] = [];
  if (d.payer === SEVERAL) {
    for (const [id, text] of Object.entries(d.payerAmounts)) {
      if (!text.trim()) continue;
      const v = parseMoneyInput(text, d.currency);
      if (!v) problems.paidBy = 'Enter each payer’s amount, like 250.00.';
      else paidBy.push({ personId: id, amountMinor: v });
    }
    if (paidBy.length === 0) problems.paidBy ??= 'Enter what each person paid.';
    else if (amount && paidBy.reduce((s, p) => s + BigInt(p.amountMinor), 0n) !== BigInt(amount)) {
      problems.paidBy = 'What each person paid must add up to the amount.';
    }
  } else if (d.payer) {
    paidBy = amount ? [{ personId: d.payer, amountMinor: amount }] : [];
  } else problems.paidBy = 'Choose who paid.';

  // How it's shared
  let split: CreateExpenseInput['split'];
  if (d.method === 'equal') {
    if (d.participants.length === 0) problems.split = 'Choose who shares this expense.';
    split = { method: 'equal', participants: d.participants };
  } else if (d.method === 'custom') {
    const shares: { personId: string; amountMinor: string }[] = [];
    for (const [id, text] of Object.entries(d.customAmounts)) {
      if (!text.trim()) continue;
      const v = parseMoneyInput(text, d.currency);
      if (!v) problems.split = 'Enter each share as an amount, like 250.00.';
      else shares.push({ personId: id, amountMinor: v });
    }
    if (shares.length === 0) problems.split ??= 'Enter at least one share.';
    else if (amount && shares.reduce((s, p) => s + BigInt(p.amountMinor), 0n) !== BigInt(amount)) {
      problems.split = 'The shares must add up exactly to the amount.';
    }
    split = { method: 'custom', shares };
  } else {
    const shares: { personId: string; basisPoints: number }[] = [];
    for (const [id, text] of Object.entries(d.percents)) {
      if (!text.trim()) continue;
      const bp = parsePercentInput(text);
      if (!bp) problems.split = 'Enter each percentage like 33.33.';
      else shares.push({ personId: id, basisPoints: bp });
    }
    if (shares.length === 0) problems.split ??= 'Enter at least one percentage.';
    else if (shares.reduce((s, x) => s + x.basisPoints, 0) !== 10_000) {
      problems.split = 'The percentages must add up to exactly 100%.';
    }
    split = { method: 'percent', shares };
  }
  return Object.keys(problems).length
    ? { problems }
    : { body: { ...base, status: 'paid', paidBy, split } };
}

/** Each person's share, as the API will compute it (for the preview). */
function preview(d: Draft): { id: string; minor: bigint }[] | null {
  const amount = parseMoneyInput(d.amount, d.currency);
  if (!amount || d.status !== 'paid') return null;
  const total = BigInt(amount);
  try {
    if (d.method === 'equal' && d.participants.length > 0) {
      return [...splitEqual(total, d.participants)].map(([id, minor]) => ({ id, minor }));
    }
    if (d.method === 'percent') {
      const shares = Object.entries(d.percents)
        .map(([id, t]) => ({ personId: id, basisPoints: parsePercentInput(t) ?? 0 }))
        .filter((s) => s.basisPoints > 0);
      if (shares.reduce((s, x) => s + x.basisPoints, 0) !== 10_000) return null;
      return [...splitByBasisPoints(total, shares)].map(([id, minor]) => ({ id, minor }));
    }
  } catch {
    return null;
  }
  return null;
}

export function ExpenseDialog({
  tripId,
  expense,
  people,
  defaults,
  onClose,
  onSaved,
}: {
  tripId: string;
  /** The expense to edit; null to add one. */
  expense: Expense | null;
  /** Current members (and, when editing, people already on the expense). */
  people: BudgetPerson[];
  defaults: { currency: BudgetCurrency; day: string; you: string };
  onClose: () => void;
  onSaved: (expense: Expense, message: string) => void;
}) {
  const [draft, setDraft] = useState<Draft>(() => draftFrom(expense, defaults));
  const [problems, setProblems] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));

  const eligible = useMemo(() => {
    const onExpense = new Set(expense?.parts.map((p) => p.personId) ?? []);
    return people.filter((p) => p.role !== 'former' || onExpense.has(p.id));
  }, [people, expense]);
  const nameOf = (id: string) => {
    const p = people.find((x) => x.id === id);
    return p ? (p.isYou ? `${p.name} (you)` : p.name) : 'Someone';
  };

  const attempt = useRef<{ body: string; key: string } | null>(null);
  const save = useMutation({
    mutationFn: (body: CreateExpenseInput) => {
      if (expense) return updateExpense(tripId, expense.id, { ...body, version: expense.version });
      const serialized = JSON.stringify(body);
      if (attempt.current?.body !== serialized) {
        attempt.current = { body: serialized, key: crypto.randomUUID() };
      }
      return createExpense(tripId, body, attempt.current.key);
    },
    onSuccess: (saved) => {
      onSaved(saved, expense ? `Saved “${saved.description}”` : `Added “${saved.description}”`);
      onClose();
    },
    onError: (error) => {
      const api = error instanceof ApiClientError ? error : null;
      if (api?.code === 'PLAN_OUT_OF_DATE' || api?.status === 404) {
        setConflict(true);
        return;
      }
      if (api?.code === 'VALIDATION_FAILED' && api.details.length > 0) {
        setFormError(api.details.map((d) => d.message).join(' '));
        return;
      }
      setFormError(
        api && api.code !== 'NETWORK_ERROR'
          ? api.message
          : 'We couldn’t reach Wayora. Check your connection and try again.',
      );
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setFormError(null);
    const result = toBody(draft);
    if ('problems' in result) {
      setProblems(result.problems);
      const first = Object.keys(result.problems)[0];
      document.getElementById(`expense-${first}`)?.focus();
      return;
    }
    setProblems({});
    save.mutate(result.body);
  };

  // Listed in the same order as the people in the form.
  const order = new Map(eligible.map((p, i) => [p.id, i]));
  const shares = preview(draft)?.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  const amountMinor = parseMoneyInput(draft.amount, draft.currency);
  const assigned = (values: Record<string, string>) =>
    Object.values(values).reduce(
      (s, t) => s + BigInt(parseMoneyInput(t, draft.currency) ?? '0'),
      0n,
    );
  const percentAssigned = Object.values(draft.percents).reduce(
    (s, t) => s + (parsePercentInput(t) ?? 0),
    0,
  );

  return (
    <Dialog open onOpenChange={(open) => !open && !save.isPending && onClose()}>
      <DialogContent
        size="lg"
        title={expense ? 'Edit expense' : 'Add an expense'}
        description="Record what was spent, who paid and who shares it. Wayora doesn’t move any money."
        footer={
          <>
            <Button variant="secondary" onClick={onClose} disabled={save.isPending}>
              Cancel
            </Button>
            <Button
              type="submit"
              form="expense-form"
              loading={save.isPending}
              disabled={save.isPending || conflict}
            >
              {expense ? 'Save expense' : 'Add expense'}
            </Button>
          </>
        }
      >
        <form
          id="expense-form"
          noValidate
          onSubmit={submit}
          className="flex flex-col gap-5 pb-2"
          aria-busy={save.isPending || undefined}
        >
          {conflict ? (
            <Alert tone="warning" title="Someone else changed this expense">
              It was changed or deleted since you opened it, so your changes weren’t saved. Close
              this, then open the latest version.
            </Alert>
          ) : null}
          {formError ? (
            <Alert tone="danger" title="We couldn’t save this expense">
              {formError}
            </Alert>
          ) : null}
          <Field label="Description" required error={problems.description} id="expense-description">
            <Input
              value={draft.description}
              maxLength={120}
              onChange={(e) => set('description', e.target.value)}
            />
          </Field>
          <div className="grid gap-5 sm:grid-cols-2">
            <Field label="Category" required error={problems.category} id="expense-category">
              <Select
                placeholder="Choose a category"
                value={draft.category}
                onChange={(e) => set('category', e.target.value as ExpenseCategory)}
                options={EXPENSE_CATEGORIES.map((c) => ({
                  value: c,
                  label: EXPENSE_CATEGORY_LABELS[c],
                }))}
              />
            </Field>
            <Field label="Date" required error={problems.spentOn} id="expense-spentOn">
              <Input
                type="date"
                value={draft.spentOn}
                onChange={(e) => set('spentOn', e.target.value)}
              />
            </Field>
          </div>
          <div className="grid gap-5 sm:grid-cols-[minmax(0,1fr)_9rem]">
            <Field
              label="Amount"
              required
              error={problems.amount}
              hint="For example 1499.50"
              id="expense-amount"
            >
              <Input
                inputMode="decimal"
                autoComplete="off"
                value={draft.amount}
                onChange={(e) => set('amount', e.target.value)}
              />
            </Field>
            <Field label="Currency" id="expense-currency">
              <Select
                value={draft.currency}
                onChange={(e) => set('currency', e.target.value as BudgetCurrency)}
                options={BUDGET_CURRENCIES.map((c) => ({ value: c, label: c }))}
              />
            </Field>
          </div>
          <RadioGroup
            legend="Status"
            inline
            hint="Planned expenses are estimates: they count toward planned costs, not balances."
          >
            <Radio
              label="Paid"
              name="expense-status"
              checked={draft.status === 'paid'}
              onChange={() => set('status', 'paid')}
            />
            <Radio
              label="Planned (estimate)"
              name="expense-status"
              checked={draft.status === 'planned'}
              onChange={() => set('status', 'planned')}
            />
          </RadioGroup>

          {draft.status === 'paid' ? (
            <>
              <fieldset className="flex flex-col gap-3">
                <legend className="mb-1 text-label text-ink">Paid by</legend>
                <Field label="Who paid" hideLabel error={problems.paidBy} id="expense-paidBy">
                  <Select value={draft.payer} onChange={(e) => set('payer', e.target.value)}>
                    {eligible.map((p) => (
                      <option key={p.id} value={p.id}>
                        {nameOf(p.id)}
                      </option>
                    ))}
                    <option value={SEVERAL}>Several people…</option>
                  </Select>
                </Field>
                {draft.payer === SEVERAL ? (
                  <div className="grid gap-3 sm:grid-cols-2">
                    {eligible.map((p) => (
                      <Field key={p.id} label={`${nameOf(p.id)} paid`}>
                        <Input
                          inputMode="decimal"
                          autoComplete="off"
                          value={draft.payerAmounts[p.id] ?? ''}
                          onChange={(e) =>
                            set('payerAmounts', { ...draft.payerAmounts, [p.id]: e.target.value })
                          }
                        />
                      </Field>
                    ))}
                    {amountMinor ? (
                      <p
                        className="text-body-sm text-ink-secondary sm:col-span-2"
                        aria-live="polite"
                      >
                        {money(assigned(draft.payerAmounts), draft.currency)} of{' '}
                        {money(amountMinor, draft.currency)} entered
                      </p>
                    ) : null}
                  </div>
                ) : null}
              </fieldset>

              <fieldset className="flex flex-col gap-3">
                <legend className="mb-1 text-label text-ink">Split</legend>
                <RadioGroup legend="How is it shared?" inline error={problems.split}>
                  {(
                    [
                      ['equal', 'Equally'],
                      ['custom', 'By amount'],
                      ['percent', 'By percentage'],
                    ] as const
                  ).map(([m, label]) => (
                    <Radio
                      key={m}
                      label={label}
                      name="expense-method"
                      checked={draft.method === m}
                      onChange={() => set('method', m)}
                    />
                  ))}
                </RadioGroup>
                <div id="expense-split" tabIndex={-1} className="grid gap-3 sm:grid-cols-2">
                  {eligible.map((p) =>
                    draft.method === 'equal' ? (
                      <Checkbox
                        key={p.id}
                        label={nameOf(p.id)}
                        checked={draft.participants.includes(p.id)}
                        onChange={(e) =>
                          set(
                            'participants',
                            e.target.checked
                              ? [...draft.participants, p.id]
                              : draft.participants.filter((x) => x !== p.id),
                          )
                        }
                      />
                    ) : draft.method === 'custom' ? (
                      <Field
                        key={p.id}
                        label={`${nameOf(p.id)}’s share`}
                        hint="Leave blank if not sharing"
                      >
                        <Input
                          inputMode="decimal"
                          autoComplete="off"
                          value={draft.customAmounts[p.id] ?? ''}
                          onChange={(e) =>
                            set('customAmounts', { ...draft.customAmounts, [p.id]: e.target.value })
                          }
                        />
                      </Field>
                    ) : (
                      <Field
                        key={p.id}
                        label={`${nameOf(p.id)} (%)`}
                        hint="Leave blank if not sharing"
                      >
                        <Input
                          inputMode="decimal"
                          autoComplete="off"
                          value={draft.percents[p.id] ?? ''}
                          onChange={(e) =>
                            set('percents', { ...draft.percents, [p.id]: e.target.value })
                          }
                        />
                      </Field>
                    ),
                  )}
                </div>
                <div aria-live="polite" className="text-body-sm text-ink-secondary">
                  {draft.method === 'custom' && amountMinor
                    ? (() => {
                        const left = BigInt(amountMinor) - assigned(draft.customAmounts);
                        return left === 0n
                          ? 'Every share is assigned.'
                          : left > 0n
                            ? `${money(left, draft.currency)} left to assign.`
                            : `${money(-left, draft.currency)} too much assigned.`;
                      })()
                    : null}
                  {draft.method === 'percent'
                    ? percentAssigned === 10_000
                      ? null
                      : `${Math.floor(percentAssigned / 100)}.${String(percentAssigned % 100).padStart(2, '0')}% of 100% assigned.`
                    : null}
                  {shares ? (
                    <ul
                      aria-label="Each person’s share"
                      className="mt-1 flex flex-wrap gap-x-4 gap-y-1"
                    >
                      {shares.map((s) => (
                        <li key={s.id}>
                          {nameOf(s.id)}:{' '}
                          <span className="numeric text-ink">{money(s.minor, draft.currency)}</span>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  {draft.method === 'equal' &&
                  shares &&
                  shares.length > 1 &&
                  amountMinor &&
                  BigInt(amountMinor) % BigInt(shares.length) !== 0n ? (
                    <p className="mt-1">
                      It doesn’t divide evenly: the extra{' '}
                      {draft.currency === 'INR' ? 'paise go' : 'cents go'} one each to the first
                      people in a fixed order, so the shares add up exactly.
                    </p>
                  ) : null}
                </div>
              </fieldset>
            </>
          ) : null}

          <Field
            label="Notes"
            hint="Optional. Visible to everyone on this plan."
            id="expense-notes"
          >
            <Textarea
              rows={2}
              maxLength={500}
              value={draft.notes}
              onChange={(e) => set('notes', e.target.value)}
            />
          </Field>
        </form>
      </DialogContent>
    </Dialog>
  );
}
