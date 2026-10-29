import { useMutation } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import {
  BUDGET_CURRENCIES,
  EXPENSE_CATEGORIES,
  EXPENSE_CATEGORY_LABELS,
  minorToInput,
  parseMoneyInput,
  type Budget,
  type BudgetCurrency,
  type BudgetOverview,
  type ExpenseCategory,
  type PutBudgetInput,
} from '@wayora/contracts';
import { Alert, Button, Dialog, DialogContent, Field, Input, Select } from '@wayora/ui';
import { ApiClientError } from '../../../lib/api-client';
import { putBudget, removeBudget } from '../../../services/planner';
import { money } from './money';

/*
 * Set, change or remove the plan's budget (docs/planner.md#budget). The
 * budget is a target only: changing it never changes any expense. Each save
 * says which version it was based on, so two people editing at once can't
 * silently overwrite each other.
 */

export function BudgetDialog({
  tripId,
  budget,
  onClose,
  onSaved,
}: {
  tripId: string;
  budget: Budget | null;
  onClose: () => void;
  onSaved: (overview: BudgetOverview, message: string) => void;
}) {
  const [currency, setCurrency] = useState<BudgetCurrency>(budget?.currency ?? 'INR');
  const [total, setTotal] = useState(
    budget ? minorToInput(budget.totalMinor, budget.currency) : '',
  );
  const [categories, setCategories] = useState<Partial<Record<ExpenseCategory, string>>>(() =>
    Object.fromEntries(
      (budget?.categories ?? []).map((c) => [
        c.category,
        minorToInput(c.amountMinor, budget!.currency),
      ]),
    ),
  );
  const [problems, setProblems] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);

  const onError = (error: unknown) => {
    const api = error instanceof ApiClientError ? error : null;
    if (api?.code === 'PLAN_OUT_OF_DATE') {
      setConflict(true);
      return;
    }
    setFormError(
      api && api.code !== 'NETWORK_ERROR'
        ? [api.message, ...api.details.map((d) => d.message)].join(' ')
        : 'We couldn’t reach Wayora. Check your connection and try again.',
    );
  };
  const save = useMutation({
    mutationFn: (body: PutBudgetInput) => putBudget(tripId, body),
    onSuccess: (overview) => {
      onSaved(overview, budget ? 'Budget updated' : 'Budget set');
      onClose();
    },
    onError,
  });
  const remove = useMutation({
    mutationFn: () => removeBudget(tripId, budget!.version),
    onSuccess: (overview) => {
      onSaved(overview, 'Budget removed. Your expenses are unchanged.');
      onClose();
    },
    onError,
  });
  const busy = save.isPending || remove.isPending;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setFormError(null);
    const found: Record<string, string> = {};
    const totalMinor = parseMoneyInput(total, currency);
    if (!totalMinor) found.total = 'Enter a total above zero, like 50000.';
    const list: { category: ExpenseCategory; amountMinor: string }[] = [];
    for (const c of EXPENSE_CATEGORIES) {
      const text = categories[c]?.trim();
      if (!text) continue;
      const v = parseMoneyInput(text, currency);
      if (!v) found[c] = 'Enter an amount above zero, or leave it blank.';
      else if (totalMinor && BigInt(v) > BigInt(totalMinor))
        found[c] = 'Can’t be more than the total.';
      else list.push({ category: c, amountMinor: v });
    }
    setProblems(found);
    const first = Object.keys(found)[0];
    if (first) {
      document.getElementById(`budget-${first}`)?.focus();
      return;
    }
    save.mutate({
      ...(budget ? { version: budget.version } : {}),
      currency,
      totalMinor: totalMinor!,
      categories: list,
    });
  };

  const totalMinor = parseMoneyInput(total, currency);
  const categorySum = EXPENSE_CATEGORIES.reduce(
    (s, c) => s + BigInt(parseMoneyInput(categories[c] ?? '', currency) ?? '0'),
    0n,
  );

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent
        size="lg"
        title={budget ? 'Edit budget' : 'Set a budget'}
        description="A spending target for this trip. It doesn’t change any expense, and nothing is charged."
        footer={
          confirmRemove ? (
            <>
              <Button variant="secondary" onClick={() => setConfirmRemove(false)} disabled={busy}>
                Keep the budget
              </Button>
              <Button
                variant="destructive"
                loading={remove.isPending}
                disabled={busy || conflict}
                onClick={() => remove.mutate()}
              >
                Remove budget
              </Button>
            </>
          ) : (
            <>
              {budget ? (
                <Button
                  variant="ghost"
                  className="sm:mr-auto"
                  onClick={() => setConfirmRemove(true)}
                  disabled={busy || conflict}
                >
                  Remove budget
                </Button>
              ) : null}
              <Button variant="secondary" onClick={onClose} disabled={busy}>
                Cancel
              </Button>
              <Button
                type="submit"
                form="budget-form"
                loading={save.isPending}
                disabled={busy || conflict}
              >
                Save budget
              </Button>
            </>
          )
        }
      >
        <form
          id="budget-form"
          noValidate
          onSubmit={submit}
          className="flex flex-col gap-5 pb-2"
          aria-busy={busy || undefined}
        >
          {conflict ? (
            <Alert tone="warning" title="Someone else changed the budget">
              It changed since you opened this, so your changes weren’t saved. Close this to see the
              latest budget, then edit it again.
            </Alert>
          ) : null}
          {formError ? (
            <Alert tone="danger" title="We couldn’t save the budget">
              {formError}
            </Alert>
          ) : null}
          {confirmRemove ? (
            <Alert tone="warning" role="none" title="Remove the budget?">
              The total and category budgets are removed. Expenses, balances and settlements stay
              exactly as they are.
            </Alert>
          ) : null}
          <div className="grid gap-5 sm:grid-cols-[minmax(0,1fr)_9rem]">
            <Field
              label="Total budget"
              required
              error={problems.total}
              hint="For example 50000"
              id="budget-total"
            >
              <Input
                inputMode="decimal"
                autoComplete="off"
                value={total}
                onChange={(e) => setTotal(e.target.value)}
              />
            </Field>
            <Field
              label="Currency"
              id="budget-currency"
              hint={
                budget && budget.currency !== currency ? 'Amounts are not converted.' : undefined
              }
            >
              <Select
                value={currency}
                onChange={(e) => setCurrency(e.target.value as BudgetCurrency)}
                options={BUDGET_CURRENCIES.map((c) => ({ value: c, label: c }))}
              />
            </Field>
          </div>
          <fieldset className="flex flex-col gap-3">
            <legend className="mb-1 text-label text-ink">Category budgets (optional)</legend>
            <p className="-mt-1 text-body-sm text-ink-secondary">
              Leave a category blank to track it without a limit. Only expenses in {currency} count
              toward this budget.
            </p>
            <div className="grid gap-x-5 gap-y-3 sm:grid-cols-2">
              {EXPENSE_CATEGORIES.map((c) => (
                <Field
                  key={c}
                  label={EXPENSE_CATEGORY_LABELS[c]}
                  error={problems[c]}
                  id={`budget-${c}`}
                >
                  <Input
                    inputMode="decimal"
                    autoComplete="off"
                    value={categories[c] ?? ''}
                    onChange={(e) => setCategories((prev) => ({ ...prev, [c]: e.target.value }))}
                  />
                </Field>
              ))}
            </div>
            {totalMinor && categorySum > BigInt(totalMinor) ? (
              <p className="text-body-sm text-ink-secondary" aria-live="polite">
                Category budgets add up to {money(categorySum, currency)}, more than the total of{' '}
                {money(totalMinor, currency)}. That’s allowed, but worth a look.
              </p>
            ) : null}
          </fieldset>
        </form>
      </DialogContent>
    </Dialog>
  );
}
