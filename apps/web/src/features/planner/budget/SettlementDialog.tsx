import { useMutation } from '@tanstack/react-query';
import { useRef, useState, type FormEvent } from 'react';
import {
  BUDGET_CURRENCIES,
  minorToInput,
  parseMoneyInput,
  type Balances,
  type BudgetCurrency,
  type BudgetPerson,
  type CreateSettlementInput,
} from '@wayora/contracts';
import { Alert, Button, Dialog, DialogContent, Field, Input, Select, Textarea } from '@wayora/ui';
import { ApiClientError } from '../../../lib/api-client';
import { recordSettlement } from '../../../services/planner';

/*
 * Record that one person paid another back, outside Wayora (cash, UPI, a
 * bank transfer…). Wayora never sends, receives or confirms money: this is
 * a note in the plan's ledger that changes the balances shown.
 */

export interface SettlementDraft {
  fromId: string;
  toId: string;
  amountMinor: string | null;
  currency: BudgetCurrency;
}

export function SettlementDialog({
  tripId,
  people,
  initial,
  today,
  onClose,
  onSaved,
}: {
  tripId: string;
  people: BudgetPerson[];
  initial: SettlementDraft;
  today: string;
  onClose: () => void;
  onSaved: (balances: Balances, message: string) => void;
}) {
  const [fromId, setFromId] = useState(initial.fromId);
  const [toId, setToId] = useState(initial.toId);
  const [currency, setCurrency] = useState<BudgetCurrency>(initial.currency);
  const [amount, setAmount] = useState(
    initial.amountMinor ? minorToInput(initial.amountMinor, initial.currency) : '',
  );
  const [settledOn, setSettledOn] = useState(today);
  const [note, setNote] = useState('');
  const [problems, setProblems] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const label = (p: BudgetPerson) => (p.isYou ? `${p.name} (you)` : p.name);
  const nameFor = (id: string) => {
    const p = people.find((x) => x.id === id);
    return p ? (p.isYou ? 'You' : p.name) : 'Someone';
  };

  const attempt = useRef<{ body: string; key: string } | null>(null);
  const save = useMutation({
    mutationFn: (body: CreateSettlementInput) => {
      const serialized = JSON.stringify(body);
      if (attempt.current?.body !== serialized) {
        attempt.current = { body: serialized, key: crypto.randomUUID() };
      }
      return recordSettlement(tripId, body, attempt.current.key);
    },
    onSuccess: (balances) => {
      onSaved(
        balances,
        `Recorded: ${nameFor(fromId)} paid ${nameFor(toId).replace(/^You$/, 'you')} outside Wayora`,
      );
      onClose();
    },
    onError: (error) => {
      const api = error instanceof ApiClientError ? error : null;
      setFormError(
        api && api.code !== 'NETWORK_ERROR'
          ? [api.message, ...api.details.map((d) => d.message)].join(' ')
          : 'We couldn’t reach Wayora. Check your connection and try again.',
      );
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setFormError(null);
    const found: Record<string, string> = {};
    if (!fromId) found.from = 'Choose who paid.';
    if (!toId) found.to = 'Choose who was paid.';
    else if (fromId === toId) found.to = 'Choose two different people.';
    const amountMinor = parseMoneyInput(amount, currency);
    if (!amountMinor) found.amount = 'Enter an amount above zero, like 500.00.';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(settledOn)) found.date = 'Choose a date.';
    setProblems(found);
    const first = Object.keys(found)[0];
    if (first) {
      document.getElementById(`settlement-${first}`)?.focus();
      return;
    }
    save.mutate({ fromId, toId, amountMinor: amountMinor!, currency, settledOn, note });
  };

  const choices = people.filter((p) => p.role !== 'former' || p.id === fromId || p.id === toId);

  return (
    <Dialog open onOpenChange={(open) => !open && !save.isPending && onClose()}>
      <DialogContent
        title="Record a payment made outside Wayora"
        description="Wayora doesn’t send or receive money. Record a payment only after it has actually been made, for example by cash, UPI or bank transfer."
        footer={
          <>
            <Button variant="secondary" onClick={onClose} disabled={save.isPending}>
              Cancel
            </Button>
            <Button
              type="submit"
              form="settlement-form"
              loading={save.isPending}
              disabled={save.isPending}
            >
              Record payment
            </Button>
          </>
        }
      >
        <form
          id="settlement-form"
          noValidate
          onSubmit={submit}
          className="flex flex-col gap-5 pb-2"
          aria-busy={save.isPending || undefined}
        >
          {formError ? (
            <Alert tone="danger" title="We couldn’t record this payment">
              {formError}
            </Alert>
          ) : null}
          <div className="grid gap-5 sm:grid-cols-2">
            <Field label="Who paid" required error={problems.from} id="settlement-from">
              <Select
                placeholder="Choose a person"
                value={fromId}
                onChange={(e) => setFromId(e.target.value)}
                options={choices.map((p) => ({ value: p.id, label: label(p) }))}
              />
            </Field>
            <Field label="Who was paid" required error={problems.to} id="settlement-to">
              <Select
                placeholder="Choose a person"
                value={toId}
                onChange={(e) => setToId(e.target.value)}
                options={choices.map((p) => ({ value: p.id, label: label(p) }))}
              />
            </Field>
          </div>
          <div className="grid gap-5 sm:grid-cols-[minmax(0,1fr)_9rem]">
            <Field label="Amount" required error={problems.amount} id="settlement-amount">
              <Input
                inputMode="decimal"
                autoComplete="off"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </Field>
            <Field label="Currency" id="settlement-currency">
              <Select
                value={currency}
                onChange={(e) => setCurrency(e.target.value as BudgetCurrency)}
                options={BUDGET_CURRENCIES.map((c) => ({ value: c, label: c }))}
              />
            </Field>
          </div>
          <Field label="Date paid" required error={problems.date} id="settlement-date">
            <Input type="date" value={settledOn} onChange={(e) => setSettledOn(e.target.value)} />
          </Field>
          <Field
            label="Note"
            hint="Optional. Visible to everyone on this plan."
            id="settlement-note"
          >
            <Textarea
              rows={2}
              maxLength={500}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </Field>
        </form>
      </DialogContent>
    </Dialog>
  );
}
