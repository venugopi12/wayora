import { BrandLoader, BrandMark, Wordmark, cn } from '@wayora/ui';
import { Code, ShowcaseSection, Specimen, contrastRatio, useCssVar } from './showcase';

const colorGroups: Array<{ title: string; tokens: Array<{ name: string; use: string }> }> = [
  {
    title: 'Brand',
    tokens: [
      { name: 'brand', use: 'Primary actions, links, focus' },
      { name: 'brand-hover', use: 'Hover on brand fills' },
      { name: 'brand-soft', use: 'Selected and tinted surfaces' },
      { name: 'brand-ink', use: 'Brand text on soft surfaces' },
      { name: 'deep', use: 'Hero, footer, tooltips, toasts' },
    ],
  },
  {
    title: 'Surfaces',
    tokens: [
      { name: 'page', use: 'App background' },
      { name: 'card', use: 'Cards, inputs, dialogs' },
      { name: 'sunken', use: 'Inset bands and wells' },
    ],
  },
  {
    title: 'Text and lines',
    tokens: [
      { name: 'ink', use: 'Primary text' },
      { name: 'ink-secondary', use: 'Supporting text (AA on all surfaces)' },
      { name: 'ink-subtle', use: 'Placeholders, disabled only' },
      { name: 'line', use: 'Dividers, card borders' },
      { name: 'line-control', use: 'Form control outlines (3:1)' },
    ],
  },
  {
    title: 'Status',
    tokens: [
      { name: 'success', use: 'Confirmed, available' },
      { name: 'warning', use: 'Needs attention' },
      { name: 'danger', use: 'Errors, destructive actions' },
      { name: 'success-soft', use: 'Success backgrounds' },
      { name: 'warning-soft', use: 'Warning backgrounds' },
      { name: 'danger-soft', use: 'Error backgrounds' },
    ],
  },
];

const scale = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950] as const;

function Swatch({ name, use }: { name: string; use: string }) {
  const hex = useCssVar(`--color-${name}`).toLowerCase();
  const onWhite = contrastRatio(hex, '#ffffff');
  return (
    <li className="flex flex-col overflow-hidden rounded-lg border border-line bg-card">
      <span className="h-16 border-b border-line" style={{ background: `var(--color-${name})` }} />
      <span className="flex flex-col gap-0.5 p-3">
        <span className="text-label">{name}</span>
        <span className="numeric font-mono text-caption text-ink-secondary">{hex || '…'}</span>
        <span className="text-caption text-ink-secondary">{use}</span>
        {onWhite ? (
          <span className="numeric text-caption text-ink-secondary">
            {onWhite.toFixed(2)}:1 on white
          </span>
        ) : null}
      </span>
    </li>
  );
}

const typeScale = [
  { cls: 'text-display', use: 'Hero headline (one per page)', sample: 'Every way to travel' },
  { cls: 'text-heading-1', use: 'Page title', sample: 'Your trips' },
  { cls: 'text-heading-2', use: 'Section heading', sample: 'Popular destinations' },
  { cls: 'text-heading-3', use: 'Card and dialog titles', sample: 'Hotels in Udaipur' },
  { cls: 'text-title', use: 'Small titles, list headers', sample: 'Fare summary' },
  {
    cls: 'text-body-lg',
    use: 'Lead paragraphs',
    sample: 'Book flights, stays and trains as one journey.',
  },
  {
    cls: 'text-body',
    use: 'Default text',
    sample: 'Free cancellation until 24 hours before check-in.',
  },
  { cls: 'text-body-sm', use: 'Supporting text, hints', sample: 'Includes taxes and fees.' },
  { cls: 'text-label', use: 'Form labels, buttons', sample: 'Departure date' },
  { cls: 'text-caption', use: 'Metadata, timestamps', sample: 'Updated 2 minutes ago' },
  { cls: 'numeric text-numeric-lg', use: 'Prices, times (tabular)', sample: '₹12,480  06:45' },
  { cls: 'numeric text-numeric', use: 'Inline figures (tabular)', sample: '2h 45m  BLR → DEL' },
];

export function BrandSection() {
  return (
    <ShowcaseSection
      id="brand"
      title="Brand"
      description="The mark is a journey from origin to destination via a stopover: two arcs that also read as a lowercase w. Keep clear space of at least half the mark's width around it, and never recolour it outside the tones below."
    >
      <div className="grid grid-cols-[minmax(0,1fr)] gap-6 md:grid-cols-2">
        <Specimen label="Wordmark" note="sm · md · lg">
          <div className="flex flex-wrap items-center gap-8">
            <Wordmark size="sm" />
            <Wordmark />
            <Wordmark size="lg" />
          </div>
        </Specimen>
        <Specimen label="Wordmark on deep navy" tone="deep">
          <div className="flex flex-wrap items-center gap-8">
            <Wordmark surface="dark" />
            <Wordmark surface="dark" size="lg" />
          </div>
        </Specimen>
        <Specimen label="Mark tones" note="brand · deep · inverse · mono">
          <div className="flex flex-wrap items-center gap-6">
            <BrandMark size={56} />
            <BrandMark size={56} tone="deep" />
            <span className="rounded-xl bg-deep p-2">
              <BrandMark size={56} tone="inverse" />
            </span>
            <BrandMark size={56} tone="mono" className="text-brand" />
          </div>
        </Specimen>
        <Specimen
          label="Small sizes and loading"
          note="Below 20px the stopover is filled for legibility"
        >
          <div className="flex flex-wrap items-center gap-6">
            <BrandMark size={16} />
            <BrandMark size={24} />
            <BrandMark size={32} />
            <BrandLoader size={40} label="Loading example" />
          </div>
        </Specimen>
      </div>
    </ShowcaseSection>
  );
}

export function ColorSection() {
  return (
    <ShowcaseSection
      id="color"
      title="Colour"
      description={
        <>
          Values are read live from the CSS variables in{' '}
          <Code>packages/ui/src/styles/theme.css</Code>. Use the semantic role (
          <Code>bg-brand</Code>, <Code>text-ink-secondary</Code>), not the scale, unless no role
          fits. Secondary text was darkened from #70748A to #676B81 to pass WCAG AA on the warm page
          colour.
        </>
      }
    >
      {colorGroups.map((group) => (
        <Specimen key={group.title} label={group.title} tone="page">
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            {group.tokens.map((t) => (
              <Swatch key={t.name} {...t} />
            ))}
          </ul>
        </Specimen>
      ))}
      <Specimen label="Brand scale" note="brand-50 … brand-950">
        <ul className="grid grid-cols-6 overflow-hidden rounded-lg sm:grid-cols-11">
          {scale.map((step) => (
            <li
              key={step}
              className={cn(
                'flex h-20 items-end p-2 text-caption',
                step >= 500 ? 'text-ink-inverse' : 'text-ink',
              )}
              style={{ background: `var(--color-brand-${step})` }}
            >
              {step}
            </li>
          ))}
        </ul>
      </Specimen>
    </ShowcaseSection>
  );
}

export function TypographySection() {
  return (
    <ShowcaseSection
      id="typography"
      title="Typography"
      description={
        <>
          Plus Jakarta Sans, self-hosted. Each step sets size, line height, tracking and weight
          together, and the large steps scale fluidly with <Code>clamp()</Code>. Use{' '}
          <Code>numeric</Code> for tabular figures in prices and times.
        </>
      }
    >
      <Specimen label="Type scale">
        <ul className="flex flex-col divide-y divide-line">
          {typeScale.map((t) => (
            <li
              key={t.cls}
              className="grid gap-2 py-5 first:pt-0 last:pb-0 md:grid-cols-[13rem_1fr] md:items-baseline"
            >
              <span className="flex flex-col">
                <Code>{t.cls}</Code>
                <span className="mt-1 text-caption text-ink-secondary">{t.use}</span>
              </span>
              <span className={cn(t.cls, 'min-w-0 break-words')}>{t.sample}</span>
            </li>
          ))}
        </ul>
      </Specimen>
    </ShowcaseSection>
  );
}

const spacing = [1, 2, 3, 4, 6, 8, 12, 16] as const;
const spacingClass: Record<(typeof spacing)[number], string> = {
  1: 'w-1',
  2: 'w-2',
  3: 'w-3',
  4: 'w-4',
  6: 'w-6',
  8: 'w-8',
  12: 'w-12',
  16: 'w-16',
};
const radii = [
  ['rounded-xs', '6px · checkboxes'],
  ['rounded-sm', '8px · small buttons'],
  ['rounded-md', '12px · buttons, inputs'],
  ['rounded-lg', '16px · panels, alerts'],
  ['rounded-xl', '24px · cards, dialogs'],
  ['rounded-2xl', '32px · hero panels'],
] as const;
const shadows = [
  ['shadow-xs', 'Resting controls'],
  ['shadow-sm', 'Raised cards'],
  ['shadow-md', 'Hover, menus'],
  ['shadow-lg', 'Dialogs, toasts'],
] as const;

export function SpaceSection() {
  return (
    <ShowcaseSection
      id="space"
      title="Space, shape and depth"
      description={
        <>
          4px spacing base (<Code>p-4</Code> = 16px) plus fluid layout steps <Code>px-gutter</Code>,{' '}
          <Code>py-section</Code> and <Code>py-section-sm</Code>. Small radii for controls, larger
          for containers. Shadows are navy-tinted and soft.
        </>
      }
    >
      <div className="grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-2">
        <Specimen label="Spacing">
          <ul className="flex flex-col gap-3">
            {spacing.map((s) => (
              <li key={s} className="flex items-center gap-4">
                <Code>{`${s}`}</Code>
                <span className={cn('h-3 rounded-xs bg-brand', spacingClass[s])} />
                <span className="numeric text-caption text-ink-secondary">{s * 4}px</span>
              </li>
            ))}
          </ul>
        </Specimen>
        <Specimen label="Layering and motion" note="z-(--z-*) · duration-(--duration-*)">
          <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-body-sm">
            {[
              ['--z-sticky', '100 · sticky header'],
              ['--z-dropdown', '200 · menus'],
              ['--z-overlay / --z-modal', '300 / 310 · dialogs, sheets'],
              ['--z-toast', '400 · notifications'],
              ['--z-tooltip', '500 · tooltips'],
              ['--duration-fast', '160ms · hover, press'],
              ['--duration-base', '240ms · enter, small moves'],
              ['--duration-slow', '400ms · section entrances'],
              ['ease-emphasized', 'entrances'],
              ['ease-exit', 'dismissals'],
            ].map(([k, v]) => (
              <div key={k} className="contents">
                <dt>
                  <Code>{k}</Code>
                </dt>
                <dd className="text-ink-secondary">{v}</dd>
              </div>
            ))}
          </dl>
        </Specimen>
        <Specimen label="Radius" tone="page">
          <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3">
            {radii.map(([cls, note]) => (
              <li key={cls} className="flex flex-col gap-2">
                <span className={cn('h-16 border border-brand-200 bg-brand-soft', cls)} />
                <Code>{cls}</Code>
                <span className="text-caption text-ink-secondary">{note}</span>
              </li>
            ))}
          </ul>
        </Specimen>
        <Specimen label="Elevation" tone="page">
          <ul className="grid grid-cols-2 gap-5">
            {shadows.map(([cls, note]) => (
              <li key={cls} className="flex flex-col gap-2">
                <span className={cn('h-16 rounded-lg bg-card', cls)} />
                <Code>{cls}</Code>
                <span className="text-caption text-ink-secondary">{note}</span>
              </li>
            ))}
          </ul>
        </Specimen>
      </div>
    </ShowcaseSection>
  );
}
