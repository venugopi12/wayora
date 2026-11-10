import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { cn } from '@wayora/ui';
import { formatCount } from './format';

/*
 * Small, dependency-free charts for the analytics pages (docs/analytics.md#charts).
 * No chart library existed, and these few forms didn't justify one.
 *
 * Every chart:
 * - starts its value axis at zero (honest bars and lines), with round ticks;
 * - names its series in a legend when there are two or more (never colour alone);
 * - has a tooltip on hover and on keyboard focus (arrow keys move it);
 * - has its numbers as a table under "Show data" (the accessible reading);
 * - leaves gaps where data wasn't recorded (null), never a made-up zero.
 *
 * Categorical colours, in fixed order (validated for colour-vision
 * deficiency on white; the lighter two also rely on the legend and table).
 */
export const SERIES_COLORS = ['#5463b1', '#eb6834', '#1baf7a', '#eda100'] as const;
const PREVIOUS_COLOR = '#8a8ea3';

export interface Line {
  label: string;
  points: (number | null)[];
  /** The comparison period: dashed and grey. */
  previous?: boolean;
}

function useWidth<T extends HTMLElement>(fallback = 640) {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([entry]) => {
      if (entry) setWidth(Math.max(260, Math.round(entry.contentRect.width)));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return { ref, width };
}

/** Round axis ticks from 0 to at least `max`. */
export function niceTicks(max: number, count = 4): number[] {
  if (!(max > 0)) return [0, 1];
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag;
  const ticks: number[] = [];
  for (let v = 0; v < max + step; v += step) {
    ticks.push(Number(v.toPrecision(12)));
    if (v >= max) break;
  }
  return ticks;
}

const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });
const tickLabel = (v: number, format: (n: number) => string) =>
  v >= 10_000 ? compact.format(v) : format(v);

export function DataTable({
  caption,
  labels,
  lines,
  format,
}: {
  caption: string;
  labels: string[];
  lines: Line[];
  format: (n: number) => string;
}) {
  return (
    <details className="mt-3 text-body-sm">
      <summary className="inline-flex min-h-11 cursor-pointer items-center text-ink-secondary hover:text-ink">
        Show data
      </summary>
      <div
        className="mt-2 overflow-x-auto"
        role="region"
        aria-label={`${caption} data`}
        tabIndex={0}
      >
        <table className="w-full min-w-[20rem] border-collapse text-left">
          <caption className="sr-only">{caption}</caption>
          <thead>
            <tr className="border-b border-line">
              <th scope="col" className="py-1.5 pr-4 font-semibold text-ink-secondary">
                Period
              </th>
              {lines.map((l) => (
                <th
                  key={l.label}
                  scope="col"
                  className="py-1.5 pr-4 font-semibold text-ink-secondary"
                >
                  {l.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {labels.map((label, i) => (
              <tr key={label} className="border-b border-line last:border-0">
                <th scope="row" className="py-1.5 pr-4 font-normal whitespace-nowrap">
                  {label}
                </th>
                {lines.map((l) => {
                  const v = l.points[i];
                  return (
                    <td key={l.label} className="py-1.5 pr-4 tabular-nums">
                      {v === null || v === undefined ? 'Not recorded' : format(v)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

function Legend({ lines }: { lines: Line[] }) {
  if (lines.length < 2) return null;
  let colour = 0;
  return (
    <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-caption text-ink-secondary">
      {lines.map((l) => {
        const color = l.previous ? PREVIOUS_COLOR : SERIES_COLORS[colour++ % SERIES_COLORS.length];
        return (
          <li key={l.label} className="flex items-center gap-1.5">
            <svg width="18" height="8" aria-hidden="true">
              <line
                x1="1"
                x2="17"
                y1="4"
                y2="4"
                stroke={color}
                strokeWidth="2"
                strokeLinecap="round"
                strokeDasharray={l.previous ? '4 3' : undefined}
              />
            </svg>
            {l.label}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * A trend: one line per series over the period's buckets. A `previous`
 * line is the comparison period, bucket by bucket.
 */
export function LineChart({
  title,
  labels,
  lines,
  format = formatCount,
  tickFormat,
  height = 200,
}: {
  title: string;
  labels: string[];
  lines: Line[];
  format?: (n: number) => string;
  /** Short axis labels (e.g. compact money); defaults to compact counts. */
  tickFormat?: (n: number) => string;
  height?: number;
}) {
  const { ref, width } = useWidth<HTMLDivElement>();
  const [active, setActive] = useState<number | null>(null);
  const id = useId();
  const values = lines.flatMap((l) => l.points.filter((v): v is number => v !== null));
  const empty = values.length === 0;
  const ticks = niceTicks(Math.max(0, ...values));
  const top = ticks[ticks.length - 1]!;
  const padL = 52;
  const padR = 12;
  const padT = 10;
  const padB = 26;
  const w = width - padL - padR;
  const h = height - padT - padB;
  const n = labels.length;
  const x = (i: number) => padL + (n <= 1 ? w / 2 : (i * w) / (n - 1));
  const y = (v: number) => padT + h - (v / top) * h;
  const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(w / 72))));

  const path = (points: (number | null)[]) => {
    let d = '';
    let pen = false;
    points.forEach((v, i) => {
      if (v === null) {
        pen = false;
        return;
      }
      d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
      pen = true;
    });
    return d;
  };

  const onKey = (e: KeyboardEvent) => {
    if (n === 0) return;
    if (e.key === 'ArrowRight') setActive((a) => Math.min(n - 1, (a ?? -1) + 1));
    else if (e.key === 'ArrowLeft') setActive((a) => Math.max(0, (a ?? n) - 1));
    else if (e.key === 'Home') setActive(0);
    else if (e.key === 'End') setActive(n - 1);
    else if (e.key === 'Escape') setActive(null);
    else return;
    e.preventDefault();
  };
  const indexAt = (clientX: number, rect: DOMRect) => {
    const rel = clientX - rect.left - padL;
    return Math.max(0, Math.min(n - 1, Math.round(n <= 1 ? 0 : (rel / w) * (n - 1))));
  };

  let colour = 0;
  const colours = lines.map((l) =>
    l.previous ? PREVIOUS_COLOR : SERIES_COLORS[colour++ % SERIES_COLORS.length]!,
  );

  return (
    <figure className="min-w-0">
      <div ref={ref} className="relative">
        {empty ? (
          <p
            className="grid place-items-center rounded-lg border border-dashed border-line-strong text-body-sm text-ink-secondary"
            style={{ height }}
          >
            No data recorded for this period.
          </p>
        ) : (
          <svg
            width={width}
            height={height}
            role="img"
            aria-labelledby={`${id}-t`}
            aria-describedby={`${id}-d`}
            tabIndex={0}
            className="block touch-pan-y rounded-md focus-visible:outline-2 focus-visible:outline-brand"
            onKeyDown={onKey}
            onBlur={() => setActive(null)}
            onPointerMove={(e) =>
              setActive(indexAt(e.clientX, e.currentTarget.getBoundingClientRect()))
            }
            onPointerLeave={() => setActive(null)}
          >
            <title id={`${id}-t`}>{title}</title>
            <desc id={`${id}-d`}>
              {`${lines.map((l) => l.label).join(', ')}; ${labels[0] ?? ''} to ${labels[n - 1] ?? ''}. Use the arrow keys for values, or open "Show data".`}
            </desc>
            {ticks.map((t) => (
              <g key={t}>
                <line x1={padL} x2={width - padR} y1={y(t)} y2={y(t)} stroke="#e6e7ef" />
                <text
                  x={padL - 6}
                  y={y(t)}
                  textAnchor="end"
                  dominantBaseline="middle"
                  className="fill-ink-secondary text-[11px]"
                >
                  {tickFormat ? tickFormat(t) : tickLabel(t, format)}
                </text>
              </g>
            ))}
            {labels.map((label, i) =>
              i % every === 0 ? (
                <text
                  key={label}
                  x={x(i)}
                  y={height - 8}
                  textAnchor={
                    n === 1 ? 'middle' : i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'
                  }
                  className="fill-ink-secondary text-[11px]"
                >
                  {label}
                </text>
              ) : null,
            )}
            {active !== null ? (
              <line x1={x(active)} x2={x(active)} y1={padT} y2={padT + h} stroke="#d3d5e1" />
            ) : null}
            {lines.map((l, li) => (
              <g key={l.label}>
                <path
                  d={path(l.points)}
                  fill="none"
                  stroke={colours[li]}
                  strokeWidth="2"
                  strokeLinejoin="round"
                  strokeLinecap="round"
                  strokeDasharray={l.previous ? '5 4' : undefined}
                />
                {/* Lone points (a gap on both sides) would be invisible as a path. */}
                {l.points.map((v, i) =>
                  v !== null &&
                  (n === 1 ||
                    ((l.points[i - 1] ?? null) === null && (l.points[i + 1] ?? null) === null)) ? (
                    <circle key={i} cx={x(i)} cy={y(v)} r="3" fill={colours[li]} />
                  ) : null,
                )}
                {active !== null && l.points[active] !== null && l.points[active] !== undefined ? (
                  <circle
                    cx={x(active)}
                    cy={y(l.points[active]!)}
                    r="4"
                    fill={colours[li]}
                    stroke="#fff"
                    strokeWidth="2"
                  />
                ) : null}
              </g>
            ))}
          </svg>
        )}
        {active !== null && !empty ? (
          <div
            role="status"
            className={cn(
              'pointer-events-none absolute top-1 z-(--z-raised) min-w-36 rounded-lg border border-line bg-card px-3 py-2 text-caption shadow-md',
              x(active) > width / 2 ? 'left-12' : 'right-2',
            )}
          >
            <p className="font-semibold text-ink">{labels[active]}</p>
            <ul>
              {lines.map((l) => {
                const v = l.points[active];
                return (
                  <li key={l.label} className="flex justify-between gap-3 text-ink-secondary">
                    <span>{l.label}</span>
                    <span className="tabular-nums text-ink">
                      {v === null || v === undefined ? 'Not recorded' : format(v)}
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        ) : null}
      </div>
      <Legend lines={lines} />
      {!empty ? <DataTable caption={title} labels={labels} lines={lines} format={format} /> : null}
    </figure>
  );
}

/**
 * A composition (parts of one whole), for a few categories only. Each part
 * is listed with its count and share, so the ring is never the only reading.
 */
export function Donut({
  label,
  parts,
  format = formatCount,
}: {
  label: string;
  parts: { label: string; value: number }[];
  format?: (n: number) => string;
}) {
  const total = parts.reduce((a, p) => a + p.value, 0);
  if (total === 0) {
    return <p className="text-body-sm text-ink-secondary">Nothing recorded for this period.</p>;
  }
  const r = 42;
  const c = 2 * Math.PI * r;
  const shown = parts.slice(0, SERIES_COLORS.length);
  // Where each part starts along the ring (a running sum, worked out up front).
  const starts = shown.map((_, i) =>
    shown.slice(0, i).reduce((sum, p) => sum + (p.value / total) * c, 0),
  );
  // A 2px gap between parts, unless there is only one.
  const gap = shown.filter((x) => x.value > 0).length > 1 ? 2 : 0;
  return (
    <div className="flex flex-wrap items-center gap-5">
      <svg width="112" height="112" viewBox="0 0 112 112" aria-hidden="true" className="shrink-0">
        <circle cx="56" cy="56" r={r} fill="none" stroke="#f3f2ee" strokeWidth="16" />
        {shown.map((p, i) => (
          <circle
            key={p.label}
            cx="56"
            cy="56"
            r={r}
            fill="none"
            stroke={SERIES_COLORS[i]}
            strokeWidth="16"
            strokeDasharray={`${Math.max(0, (p.value / total) * c - gap)} ${c}`}
            strokeDashoffset={-starts[i]!}
            transform="rotate(-90 56 56)"
          />
        ))}
      </svg>
      <ul aria-label={label} className="flex min-w-0 flex-1 flex-col gap-1.5 text-body-sm">
        {parts.map((p, i) => (
          <li key={p.label} className="flex items-center gap-2">
            <span
              aria-hidden="true"
              className="size-2.5 shrink-0 rounded-sm"
              style={{ background: SERIES_COLORS[i] ?? PREVIOUS_COLOR }}
            />
            <span className="flex-1 truncate">{p.label}</span>
            <span className="tabular-nums text-ink-secondary">
              {format(p.value)} · {Math.round((p.value / total) * 100)}%
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export interface FunnelBar {
  key: string;
  label: string;
  count: number;
  /** Conversion from the previous bar (0–1), shown between the bars. */
  conversion: number | null;
  note?: ReactNode;
}

/** Stages as bars on one zero-based scale, with the step conversion between them. */
export function FunnelChart({ label, stages }: { label: string; stages: FunnelBar[] }) {
  const max = Math.max(1, ...stages.map((s) => s.count));
  const pct = new Intl.NumberFormat('en-IN', { style: 'percent', maximumFractionDigits: 1 });
  return (
    <ol aria-label={label} className="flex flex-col gap-2">
      {stages.map((s, i) => (
        <li key={s.key} className="flex flex-col gap-1">
          {i > 0 ? (
            <p className="pl-1 text-caption text-ink-secondary">
              {s.conversion === null ? '—' : `↓ ${pct.format(s.conversion)}`}
              <span className="sr-only"> of the previous stage</span>
            </p>
          ) : null}
          <div className="flex items-baseline justify-between gap-3 text-body-sm">
            <span className="font-medium">{s.label}</span>
            <span className="tabular-nums">{formatCount(s.count)}</span>
          </div>
          <div aria-hidden="true" className="h-3 overflow-hidden rounded-full bg-sunken">
            <div
              className="h-full rounded-full"
              style={{ width: `${(s.count / max) * 100}%`, background: SERIES_COLORS[0] }}
            />
          </div>
          {s.note ? <p className="text-caption text-ink-secondary">{s.note}</p> : null}
        </li>
      ))}
    </ol>
  );
}
