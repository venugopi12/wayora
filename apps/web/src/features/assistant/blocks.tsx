import {
  ArrowRight,
  CalendarPlus,
  CheckCircle2,
  ClipboardCheck,
  Info,
  MapPin,
  Wallet,
} from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import {
  ACTIVITY_CATEGORY_LABELS,
  EXPENSE_CATEGORY_LABELS,
  type AssistantBlock,
  type AssistantBlockOf,
  type AssistantMessage,
} from '@wayora/contracts';
import { Badge, Button, Checkbox, cn } from '@wayora/ui';
import { destinationPath } from '../discover/paths';
import { money } from '../planner/budget/money';
import { formatDay, formatMinutes } from '../planner/format';
import { newPlanPath } from '../planner/paths';

/*
 * Renders validated reply blocks (docs/assistant.md#blocks). Everything is
 * rendered as plain text by React — never as HTML — so nothing a model writes
 * can become markup, a link or a script. Links only ever point to Wayora
 * pages built here from catalog ids.
 *
 * Labels say where content comes from: "From your plan" blocks are Wayora's
 * own figures; everything else is a suggestion ("AI suggestion", or "Demo
 * suggestion" from the rule-based demo) that changes nothing by itself.
 */

export interface BlockActions {
  /** The user can edit the plan this conversation is about. */
  canEditTrip: boolean;
  /** The conversation is about a plan. */
  tripId: string | null;
  applied: AssistantMessage['applied'];
  onItinerary: (block: AssistantBlockOf<'itinerary'>) => void;
  onActivity: (block: AssistantBlockOf<'activities'>, index: number) => void;
  onBudget: (block: AssistantBlockOf<'budget'>) => void;
  onMove: (block: AssistantBlockOf<'moves'>, index: number) => void;
}

function Paragraphs({ text }: { text: string }) {
  return (
    <div className="flex flex-col gap-2">
      {text.split(/\n{2,}/).map((p, i) => (
        <p key={i} className="text-body whitespace-pre-line break-words text-ink">
          {p}
        </p>
      ))}
    </div>
  );
}

function Card({
  title,
  label,
  tone = 'suggestion',
  children,
  icon,
}: {
  title: string;
  label: string;
  tone?: 'suggestion' | 'verified';
  children: ReactNode;
  icon?: ReactNode;
}) {
  const id = useId();
  return (
    <section
      aria-labelledby={id}
      className={cn(
        'flex flex-col gap-3 rounded-xl border p-4',
        tone === 'verified' ? 'border-brand/30 bg-brand-soft/40' : 'border-line bg-card',
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id={id} className="flex items-center gap-2 text-title">
          {icon}
          {title}
        </h3>
        <Badge size="sm" tone={tone === 'verified' ? 'brand' : 'neutral'}>
          {label}
        </Badge>
      </div>
      {children}
    </section>
  );
}

const appliedTo = (actions: BlockActions, blockId: string) =>
  actions.applied.filter((a) => a.blockId === blockId);

export function Blocks({
  blocks,
  suggestionLabel,
  actions,
}: {
  blocks: readonly AssistantBlock[];
  suggestionLabel: string;
  actions: BlockActions;
}) {
  return (
    <div className="flex flex-col gap-3">
      {blocks.map((block, i) => {
        switch (block.type) {
          case 'text':
            return <Paragraphs key={i} text={block.text} />;
          case 'facts':
            return <Facts key={block.id} block={block} />;
          case 'destinations':
            return <Destinations key={block.id} block={block} label={suggestionLabel} />;
          case 'itinerary':
            return (
              <Itinerary key={block.id} block={block} label={suggestionLabel} actions={actions} />
            );
          case 'activities':
            return (
              <Activities key={block.id} block={block} label={suggestionLabel} actions={actions} />
            );
          case 'budget':
            return (
              <Budget key={block.id} block={block} label={suggestionLabel} actions={actions} />
            );
          case 'packing':
            return <Packing key={block.id} block={block} label={suggestionLabel} />;
          case 'moves':
            return <Moves key={block.id} block={block} label={suggestionLabel} actions={actions} />;
          default:
            return null;
        }
      })}
    </div>
  );
}

function Facts({ block }: { block: AssistantBlockOf<'facts'> }) {
  const busiest = Math.max(1, ...block.days.map((d) => d.activities));
  return (
    <Card
      title="From your plan"
      label="Calculated by Wayora"
      tone="verified"
      icon={<ClipboardCheck className="size-5 text-brand-ink" aria-hidden="true" />}
    >
      <p className="text-body-sm text-ink-secondary">
        {block.trip.title}: {block.trip.dayCount} {block.trip.dayCount === 1 ? 'day' : 'days'},{' '}
        {block.trip.groupSize} {block.trip.groupSize === 1 ? 'person' : 'people'}
        {block.trip.pace ? `, ${block.trip.pace} pace` : ''}.
      </p>
      <ul aria-label="Activities per day" className="flex flex-col gap-1">
        {block.days.map((d) => (
          <li
            key={d.date}
            className="grid grid-cols-[7.5rem_minmax(0,1fr)_4.5rem] items-center gap-2 text-body-sm"
          >
            <span className="text-ink">
              Day {d.dayNumber} · {formatDay(d.date)}
            </span>
            <span aria-hidden="true" className="h-2 overflow-hidden rounded-full bg-sunken">
              <span
                className="block h-full rounded-full bg-brand"
                style={{ width: `${(d.activities / busiest) * 100}%` }}
              />
            </span>
            <span className="numeric text-right text-ink-secondary">
              {d.activities} {d.activities === 1 ? 'activity' : 'activities'}
            </span>
          </li>
        ))}
      </ul>
      {block.warnings.length > 0 ? (
        <div className="flex flex-col gap-1">
          <p className="text-label text-ink">Schedule warnings</p>
          <ul className="flex list-disc flex-col gap-1 pl-5 text-body-sm text-ink-secondary">
            {block.warnings.map((w, i) => (
              <li key={i}>
                {formatDay(w.day)}: {w.message}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {block.budget ? (
        <div className="flex flex-col gap-1 text-body-sm">
          <p className="text-label text-ink">Budget and expenses</p>
          {block.budget.totalMinor && block.budget.currency ? (
            <p className="text-ink-secondary">
              Budget {money(block.budget.totalMinor, block.budget.currency)} ·{' '}
              {BigInt(block.budget.remainingMinor ?? '0') < 0n
                ? `over by ${money((-BigInt(block.budget.remainingMinor ?? '0')).toString(), block.budget.currency)}`
                : `${money(block.budget.remainingMinor ?? '0', block.budget.currency)} remaining`}
            </p>
          ) : (
            <p className="text-ink-secondary">No budget set.</p>
          )}
          {block.budget.totals.length > 0 ? (
            <ul className="flex flex-col gap-0.5 text-ink-secondary">
              {block.budget.totals.map((t) => (
                <li key={t.currency}>
                  {t.currency}: recorded{' '}
                  <span className="numeric text-ink">{money(t.recordedMinor, t.currency)}</span>,
                  planned{' '}
                  <span className="numeric text-ink">{money(t.plannedMinor, t.currency)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-ink-secondary">No expenses yet.</p>
          )}
          {block.budget.totals.length > 1 ? (
            <p className="text-caption text-ink-secondary">
              Each currency is shown separately and never converted.
            </p>
          ) : null}
        </div>
      ) : null}
    </Card>
  );
}

function Destinations({
  block,
  label,
}: {
  block: AssistantBlockOf<'destinations'>;
  label: string;
}) {
  return (
    <Card
      title="Destination ideas"
      label={label}
      icon={<MapPin className="size-5 text-ink-secondary" aria-hidden="true" />}
    >
      <ul className="grid gap-3 sm:grid-cols-2">
        {block.items.map((item, i) => (
          <li key={i} className="flex flex-col gap-2 rounded-lg border border-line p-3">
            <p className="text-body font-semibold text-ink">
              {item.name}
              {item.country ? (
                <span className="font-normal text-ink-secondary">, {item.country}</span>
              ) : null}
            </p>
            <p className="text-body-sm text-ink-secondary">{item.reason}</p>
            {item.bestFor.length > 0 ? (
              <p className="flex flex-wrap gap-1">
                {item.bestFor.map((c) => (
                  <Badge key={c} size="sm" tone="neutral">
                    {ACTIVITY_CATEGORY_LABELS[c]}
                  </Badge>
                ))}
              </p>
            ) : null}
            {item.catalogId ? (
              <span className="mt-auto flex flex-wrap gap-2">
                <Button asChild size="sm" variant="ghost">
                  <Link to={destinationPath(item.catalogId)}>About {item.name}</Link>
                </Button>
                <Button asChild size="sm" variant="secondary">
                  <Link to={newPlanPath(item.catalogId)}>
                    Start a plan
                    <ArrowRight aria-hidden="true" />
                  </Link>
                </Button>
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </Card>
  );
}

function Itinerary({
  block,
  label,
  actions,
}: {
  block: AssistantBlockOf<'itinerary'>;
  label: string;
  actions: BlockActions;
}) {
  const applied = appliedTo(actions, block.id);
  const count = block.days.reduce((s, d) => s + d.activities.length, 0);
  return (
    <Card
      title={block.title}
      label={`${label} · not saved`}
      icon={<CalendarPlus className="size-5 text-ink-secondary" aria-hidden="true" />}
    >
      <p className="text-body-sm text-ink-secondary">
        {block.destination.name} · {block.dayCount} {block.dayCount === 1 ? 'day' : 'days'}
        {block.pace ? ` · ${block.pace} pace` : ''} · {count}{' '}
        {count === 1 ? 'activity' : 'activities'}. Durations are estimates; opening hours, prices
        and travel times aren’t checked.
      </p>
      <ol
        className="flex flex-col gap-3"
        aria-label={`Proposed days for ${block.destination.name}`}
      >
        {block.days.map((d) => (
          <li key={d.dayNumber} className="flex flex-col gap-1.5">
            <h4 className="text-label text-ink">
              Day {d.dayNumber}
              {d.theme ? (
                <span className="font-normal text-ink-secondary"> · {d.theme}</span>
              ) : null}
            </h4>
            {d.activities.length === 0 ? (
              <p className="text-body-sm text-ink-secondary">Nothing planned: free time.</p>
            ) : (
              <ul className="flex flex-col gap-1.5">
                {d.activities.map((a, i) => (
                  <li key={i} className="rounded-lg bg-sunken px-3 py-2">
                    <p className="text-body-sm font-semibold text-ink">{a.title}</p>
                    <p className="text-caption text-ink-secondary">
                      {ACTIVITY_CATEGORY_LABELS[a.category]}
                      {a.startTime ? ` · suggested ${a.startTime}` : ''}
                      {a.durationMinutes
                        ? ` · about ${formatMinutes(a.durationMinutes)} (estimate)`
                        : ''}
                      {a.area ? ` · ${a.area}` : ''}
                    </p>
                    {a.note ? <p className="text-caption text-ink-secondary">{a.note}</p> : null}
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ol>
      {block.budgetNote ? (
        <p className="text-body-sm text-ink-secondary">{block.budgetNote}</p>
      ) : null}
      <div className="flex flex-wrap items-center gap-3">
        {count > 0 ? (
          <Button variant="secondary" size="sm" onClick={() => actions.onItinerary(block)}>
            <CalendarPlus aria-hidden="true" />
            Review and add to a plan…
          </Button>
        ) : null}
        {applied.length > 0 ? (
          <span className="flex items-center gap-1.5 text-body-sm text-success-ink">
            <CheckCircle2 className="size-4" aria-hidden="true" />
            Added to a plan {applied.length === 1 ? 'once' : `${applied.length} times`}
          </span>
        ) : null}
      </div>
    </Card>
  );
}

function Activities({
  block,
  label,
  actions,
}: {
  block: AssistantBlockOf<'activities'>;
  label: string;
  actions: BlockActions;
}) {
  const applied = appliedTo(actions, block.id).length;
  return (
    <Card title="Activity ideas" label={label}>
      <ul className="grid gap-3 sm:grid-cols-2">
        {block.items.map((item, i) => (
          <li key={i} className="flex flex-col gap-1.5 rounded-lg border border-line p-3">
            <p className="text-body font-semibold text-ink">{item.title}</p>
            <p className="text-caption text-ink-secondary">
              {ACTIVITY_CATEGORY_LABELS[item.category]}
              {item.durationMinutes
                ? ` · about ${formatMinutes(item.durationMinutes)} (estimate)`
                : ''}
              {item.area ? ` · ${item.area}` : ''}
            </p>
            <p className="text-body-sm text-ink-secondary">{item.reason}</p>
            <span className="mt-auto pt-1">
              <Button size="sm" variant="ghost" onClick={() => actions.onActivity(block, i)}>
                <CalendarPlus aria-hidden="true" />
                Add to a plan…<span className="sr-only">: {item.title}</span>
              </Button>
            </span>
          </li>
        ))}
      </ul>
      {applied > 0 ? (
        <p className="flex items-center gap-1.5 text-body-sm text-success-ink">
          <CheckCircle2 className="size-4" aria-hidden="true" />
          {applied} added to a plan
        </p>
      ) : null}
    </Card>
  );
}

function Budget({
  block,
  label,
  actions,
}: {
  block: AssistantBlockOf<'budget'>;
  label: string;
  actions: BlockActions;
}) {
  const applied = appliedTo(actions, block.id).length > 0;
  return (
    <Card
      title="Budget proposal"
      label={`${label} · estimates`}
      icon={<Wallet className="size-5 text-ink-secondary" aria-hidden="true" />}
    >
      <table className="w-full max-w-md text-left text-body-sm">
        <caption className="sr-only">Proposed budget by category, in {block.currency}</caption>
        <tbody>
          {block.categories.map((c) => (
            <tr key={c.category} className="border-b border-line">
              <th scope="row" className="py-1.5 font-normal text-ink">
                {EXPENSE_CATEGORY_LABELS[c.category]}
              </th>
              <td className="numeric py-1.5 text-right text-ink">
                {money(c.amountMinor, block.currency)}
              </td>
            </tr>
          ))}
          <tr>
            <th scope="row" className="py-1.5 font-semibold text-ink">
              Total
            </th>
            <td className="numeric py-1.5 text-right font-semibold text-ink">
              {money(block.totalMinor, block.currency)}
            </td>
          </tr>
        </tbody>
      </table>
      <p className="text-caption text-ink-secondary">
        Planning estimates, not prices or quotes. The total is the exact sum of the amounts above,
        calculated by Wayora.
      </p>
      {block.tips.length > 0 ? (
        <ul className="flex list-disc flex-col gap-1 pl-5 text-body-sm text-ink-secondary">
          {block.tips.map((t, i) => (
            <li key={i}>{t}</li>
          ))}
        </ul>
      ) : null}
      <div className="flex flex-wrap items-center gap-3">
        {actions.tripId && actions.canEditTrip ? (
          <Button size="sm" variant="secondary" onClick={() => actions.onBudget(block)}>
            <Wallet aria-hidden="true" />
            Use as this plan’s budget…
          </Button>
        ) : null}
        {applied ? (
          <span className="flex items-center gap-1.5 text-body-sm text-success-ink">
            <CheckCircle2 className="size-4" aria-hidden="true" />
            Saved as the plan’s budget
          </span>
        ) : null}
      </div>
    </Card>
  );
}

function Packing({ block, label }: { block: AssistantBlockOf<'packing'>; label: string }) {
  const [done, setDone] = useState<Set<string>>(new Set());
  return (
    <Card title="Packing list" label={label}>
      <p className="text-caption text-ink-secondary">
        Tick items off as you pack (on this screen only; not saved).
      </p>
      <div className="grid gap-4 sm:grid-cols-2">
        {block.groups.map((g, gi) => (
          <fieldset key={gi} className="flex flex-col gap-1">
            <legend className="mb-1 text-label text-ink">{g.title}</legend>
            {g.items.map((item, ii) => {
              const key = `${gi}:${ii}`;
              return (
                <Checkbox
                  key={key}
                  label={item}
                  checked={done.has(key)}
                  onChange={(e) =>
                    setDone((prev) => {
                      const next = new Set(prev);
                      if (e.target.checked) next.add(key);
                      else next.delete(key);
                      return next;
                    })
                  }
                />
              );
            })}
          </fieldset>
        ))}
      </div>
    </Card>
  );
}

function Moves({
  block,
  label,
  actions,
}: {
  block: AssistantBlockOf<'moves'>;
  label: string;
  actions: BlockActions;
}) {
  const applied = appliedTo(actions, block.id).length;
  return (
    <Card title="Suggested changes" label={label}>
      <ul className="flex flex-col gap-2">
        {block.items.map((m, i) => (
          <li
            key={m.itemId}
            className="flex flex-col gap-2 rounded-lg border border-line p-3 sm:flex-row sm:items-center sm:justify-between"
          >
            <span className="flex flex-col gap-0.5">
              <span className="text-body-sm text-ink">
                Move <strong className="font-semibold">“{m.title}”</strong> from{' '}
                {formatDay(m.fromDay)} to {formatDay(m.toDay)}
              </span>
              <span className="text-caption text-ink-secondary">{m.reason}</span>
            </span>
            {actions.canEditTrip ? (
              <Button size="sm" variant="ghost" onClick={() => actions.onMove(block, i)}>
                Move it…<span className="sr-only">: {m.title}</span>
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
      {!actions.canEditTrip ? (
        <p className="flex items-center gap-1.5 text-body-sm text-ink-secondary">
          <Info className="size-4" aria-hidden="true" />
          You can view this plan but not change it. Ask its owner for editor access.
        </p>
      ) : null}
      {applied > 0 ? (
        <p className="flex items-center gap-1.5 text-body-sm text-success-ink">
          <CheckCircle2 className="size-4" aria-hidden="true" />
          {applied} {applied === 1 ? 'move' : 'moves'} applied
        </p>
      ) : null}
    </Card>
  );
}
