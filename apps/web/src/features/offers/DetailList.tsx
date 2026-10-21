import type { ReactNode } from 'react';

export interface DetailRow {
  label: string;
  /** `null` renders "Not provided": the source didn't include it. */
  value: ReactNode | null;
}

/**
 * Label/value rows. Missing optional data is stated plainly ("Not provided
 * in this offer") instead of being hidden or filled in.
 */
export function DetailList({ rows }: { rows: readonly DetailRow[] }) {
  return (
    <dl className="grid gap-x-8 gap-y-3 text-body-sm sm:grid-cols-[11rem_minmax(0,1fr)]">
      {rows.map(({ label, value }) => (
        <div key={label} className="contents">
          <dt className="text-ink-secondary">{label}</dt>
          <dd className={value === null ? 'text-ink-secondary italic' : 'text-ink'}>
            {value ?? 'Not provided in this offer'}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function DetailSection({ title, children }: { title: string; children: ReactNode }) {
  const id = `section-${title.toLowerCase().replace(/\W+/g, '-')}`;
  return (
    <section
      aria-labelledby={id}
      className="flex flex-col gap-4 rounded-xl border border-line bg-card p-5 shadow-xs sm:p-6"
    >
      <h2 id={id} className="text-title">
        {title}
      </h2>
      {children}
    </section>
  );
}
