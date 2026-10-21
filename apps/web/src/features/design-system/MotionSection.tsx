import { ArrowRight, ChevronDown, RotateCcw } from 'lucide-react';
import { MotionConfig } from 'motion/react';
import { useState, type ReactNode } from 'react';
import {
  Button,
  Card,
  Checkbox,
  DestinationImage,
  Field,
  Select,
  Skeleton,
  cn,
  effects,
  interaction,
} from '@wayora/ui';
import {
  DrawPath,
  ImageReveal,
  LineReveal,
  Parallax,
  Reveal,
  RevealGroup,
  RevealItem,
  distance,
  duration,
  easing,
  entrancePresets,
  useMotionPreferences,
  type DistanceToken,
  type DurationToken,
  type EntrancePreset,
} from '@wayora/ui/motion';
import { moodBySlug } from '../discover/data';
import { findDestination } from '../discover/search';
import { Code, ShowcaseSection, Specimen } from './showcase';

const PRESETS = Object.keys(entrancePresets) as EntrancePreset[];
const DURATIONS = Object.keys(duration) as DurationToken[];
const DISTANCES = Object.keys(distance) as DistanceToken[];

/**
 * Replays its children by remounting them. `reduced` forces Motion's
 * reduced-motion mode for this subtree only, so the policy can be previewed
 * without changing the OS setting.
 */
function Stage({
  reduced,
  children,
  deep = false,
}: {
  reduced: boolean;
  children: (key: number) => ReactNode;
  /** Dark stage for inverse content. */
  deep?: boolean;
}) {
  const [run, setRun] = useState(0);
  return (
    <div className="flex flex-col gap-4">
      <div
        className={cn(
          'relative min-h-48 overflow-hidden rounded-lg p-6',
          deep ? 'bg-deep text-ink-inverse' : 'border border-dashed border-line-strong bg-page',
        )}
      >
        <MotionConfig reducedMotion={reduced ? 'always' : 'user'}>{children(run)}</MotionConfig>
      </div>
      <Button
        variant="outline"
        size="sm"
        className="self-start"
        leadingIcon={<RotateCcw />}
        onClick={() => setRun((n) => n + 1)}
      >
        Replay
      </Button>
    </div>
  );
}

function PolicyStatus() {
  const { reduce, parallax } = useMotionPreferences();
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-body-sm">
      <dt className="text-ink-secondary">reduce</dt>
      <dd className="numeric">{String(reduce)}</dd>
      <dt className="text-ink-secondary">parallax</dt>
      <dd className="numeric">{String(parallax)}</dd>
    </dl>
  );
}

export function MotionSection() {
  const [preset, setPreset] = useState<EntrancePreset>('fadeUp');
  const [speed, setSpeed] = useState<DurationToken>('reveal');
  const [travel, setTravel] = useState<DistanceToken>('md');
  const [reduced, setReduced] = useState(false);

  return (
    <ShowcaseSection
      id="motion"
      title="Motion"
      description={
        <>
          From <Code>@wayora/ui/motion</Code>. Motion supports content, it never gates it: every
          element is in the DOM from the first frame, only opacity and transform animate, and with
          reduced motion everything renders in its final state. Read docs/ui-library.md.
        </>
      }
    >
      <Specimen label="Tokens" note="CSS: --duration-*, ease-*; JS: duration, easing">
        <div className="grid grid-cols-[minmax(0,1fr)] gap-6 md:grid-cols-2">
          <table className="w-full text-left text-body-sm">
            <thead className="text-caption text-ink-secondary">
              <tr>
                <th className="pb-2 font-medium">Duration</th>
                <th className="pb-2 font-medium">Seconds</th>
              </tr>
            </thead>
            <tbody>
              {DURATIONS.map((name) => (
                <tr key={name} className="border-t border-line">
                  <td className="py-1.5">
                    <Code>{name}</Code>
                  </td>
                  <td className="numeric py-1.5">{duration[name]}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <table className="w-full text-left text-body-sm">
            <thead className="text-caption text-ink-secondary">
              <tr>
                <th className="pb-2 font-medium">Easing</th>
                <th className="pb-2 font-medium">Cubic bézier</th>
              </tr>
            </thead>
            <tbody>
              {(Object.keys(easing) as (keyof typeof easing)[]).map((name) => (
                <tr key={name} className="border-t border-line">
                  <td className="py-1.5">
                    <Code>{name}</Code>
                  </td>
                  <td className="numeric py-1.5">{easing[name].join(', ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Specimen>

      <Specimen label="Entrance playground" note="<Reveal preset trigger delay duration distance>">
        <div className="grid grid-cols-[minmax(0,1fr)] gap-8 lg:grid-cols-[16rem_minmax(0,1fr)]">
          <div className="flex flex-col gap-4">
            <Field label="Preset">
              <Select
                value={preset}
                onChange={(e) => setPreset(e.target.value as EntrancePreset)}
                options={PRESETS.map((p) => ({ value: p, label: p }))}
              />
            </Field>
            <Field label="Duration">
              <Select
                value={speed}
                onChange={(e) => setSpeed(e.target.value as DurationToken)}
                options={DURATIONS.map((d) => ({ value: d, label: `${d} (${duration[d]}s)` }))}
              />
            </Field>
            <Field label="Distance" hint="Ignored by fadeIn and scaleIn.">
              <Select
                value={travel}
                onChange={(e) => setTravel(e.target.value as DistanceToken)}
                options={DISTANCES.map((d) => ({ value: d, label: `${d} (${distance[d]}px)` }))}
              />
            </Field>
            <Checkbox
              label="Preview reduced motion"
              description={'Wraps the stages in MotionConfig reducedMotion="always".'}
              checked={reduced}
              onChange={(e) => setReduced(e.target.checked)}
            />
            <MotionConfig reducedMotion={reduced ? 'always' : 'user'}>
              <PolicyStatus />
            </MotionConfig>
          </div>
          <Stage reduced={reduced}>
            {(run) => (
              <RevealGroup
                key={run}
                trigger="mount"
                stagger="base"
                className="grid grid-cols-[minmax(0,1fr)] gap-3 sm:grid-cols-3"
              >
                {['Origin', 'Stopover', 'Destination'].map((label) => (
                  <RevealItem key={label} preset={preset} duration={speed} distance={travel}>
                    <Card padding="md" className="flex h-24 items-end">
                      <span className="text-label">{label}</span>
                    </Card>
                  </RevealItem>
                ))}
              </RevealGroup>
            )}
          </Stage>
        </div>
        <pre className="mt-6 overflow-x-auto rounded-md bg-sunken p-4 font-mono text-caption">
          {`<RevealGroup trigger="mount" stagger="base">
  <RevealItem preset="${preset}" duration="${speed}" distance="${travel}">…</RevealItem>
</RevealGroup>`}
        </pre>
      </Specimen>

      <div className="grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-2">
        <Specimen label="LineReveal and DrawPath" note="hero headline, brand route">
          <Stage reduced={reduced} deep>
            {(run) => (
              <div key={run} className="flex flex-col gap-6">
                <LineReveal
                  as="p"
                  className="text-heading-1"
                  lines={['Some journeys', 'change everything.']}
                />
                <svg
                  viewBox="0 0 320 60"
                  aria-hidden="true"
                  className="w-full max-w-80"
                  fill="none"
                >
                  <DrawPath
                    trigger="mount"
                    delay={0.3}
                    d="M10 40 C70 0 130 0 160 30 S250 60 310 20"
                    stroke="currentColor"
                    strokeWidth="3"
                    strokeLinecap="round"
                  />
                </svg>
              </div>
            )}
          </Stage>
        </Specimen>
        <Specimen label="ImageReveal" note="clip-path window opens to full bleed">
          <Stage reduced={reduced}>
            {(run) => (
              <ImageReveal key={run} className="absolute inset-0">
                <DestinationImage
                  name="Kerala"
                  image={findDestination('kerala')?.image}
                  aspect="fill"
                />
              </ImageReveal>
            )}
          </Stage>
        </Specimen>
      </div>

      <Specimen
        label="Scroll: Reveal and Parallax"
        note="inView reveals once; parallax only ≥ 1024px with motion allowed"
      >
        <div className="grid grid-cols-[minmax(0,1fr)] gap-6 md:grid-cols-2">
          <Reveal preset="sectionReveal" className="flex flex-col gap-2">
            <p className="text-label">Section reveal</p>
            <p className="text-body-sm text-ink-secondary">
              <Code>{'<Reveal preset="sectionReveal">'}</Code> rises 32px as it enters the viewport.
              One observer per Reveal; use RevealGroup for lists.
            </p>
          </Reveal>
          <div className="relative aspect-[16/10] overflow-hidden rounded-lg">
            <Parallax offset={8} className="absolute inset-x-0 -top-[10%] -bottom-[10%]">
              <DestinationImage
                name="Mountains"
                image={moodBySlug['mountain-retreats'].image}
                aspect="fill"
                zoomOnHover={false}
              />
            </Parallax>
          </div>
        </div>
      </Specimen>

      <Specimen label="Interaction presets" note="CSS classes from `interaction`">
        <div className="flex flex-wrap items-center gap-6">
          <button
            type="button"
            className={cn(
              'rounded-md bg-brand px-4 py-2.5 text-label text-ink-inverse',
              interaction.press,
            )}
          >
            press
          </button>
          <Card padding="md" className={cn('w-44', interaction.hoverLift)}>
            <span className="text-label">hoverLift</span>
          </Card>
          <a
            href="#motion"
            className="group inline-flex items-center gap-1.5 text-label text-brand-ink"
          >
            iconNudge
            <ArrowRight aria-hidden="true" className={cn('size-4', interaction.iconNudge)} />
          </a>
          <details className="group">
            <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 text-label">
              iconRotate (open me)
              <ChevronDown
                aria-hidden="true"
                className="size-4 transition-transform duration-(--duration-base) ease-emphasized group-open:rotate-180"
              />
            </summary>
            <p className="pt-2 text-body-sm text-ink-secondary">
              With Radix triggers use <Code>interaction.iconRotate</Code> (keys on data-state).
            </p>
          </details>
        </div>
      </Specimen>

      <Specimen label="Optional effects" note="CSS classes from `effects`; opt in per element">
        <div className="grid grid-cols-[minmax(0,1fr)] gap-6 sm:grid-cols-2 lg:grid-cols-3">
          <div className="group flex flex-col gap-2">
            <DestinationImage
              name="Goa"
              image={findDestination('goa')?.image}
              aspect="16/10"
              className="rounded-lg"
            />
            <span className="text-caption text-ink-secondary">hoverZoom (hover the image)</span>
          </div>
          <Card padding="md" className={cn('flex flex-col gap-2', effects.cardHighlight)}>
            <span className="text-label">cardHighlight</span>
            <a
              href="#motion"
              className="stretched-link text-body-sm text-ink-secondary outline-none"
            >
              Hover or tab to this card
            </a>
          </Card>
          <Card padding="md" className={cn('flex flex-col gap-2', effects.gradientAccent)}>
            <span className="text-label">gradientAccent</span>
            <span className="text-body-sm text-ink-secondary">Static, soft brand wash</span>
          </Card>
          <div className="flex flex-col gap-2">
            <a
              href="#motion"
              className={cn('self-start text-label text-brand-ink', effects.underline)}
            >
              Animated underline
            </a>
            <span className="text-caption text-ink-secondary">underline</span>
          </div>
          <div className="flex flex-col gap-3">
            <Skeleton effect="sheen" className="h-16" />
            <Skeleton effect="sheen" shape="text" lines={2} />
            <span className="text-caption text-ink-secondary">
              Skeleton effect=&quot;sheen&quot; (stops with reduced motion)
            </span>
          </div>
        </div>
      </Specimen>

      <Specimen label="Overlays" note="overlayMotion presets, CSS only">
        <p className="max-w-prose text-body-sm text-ink-secondary">
          Dialog, DropdownMenu, Popover, Tooltip, Toast, the mega-menu panel and the mobile drawer
          animate with <Code>overlayMotion.*</Code> classes keyed on Radix&apos;s{' '}
          <Code>data-state</Code>. Radix keeps the element mounted for the exit animation and
          returns focus to the trigger, so no JavaScript motion is involved. Try them under Overlays
          and in the header.
        </p>
      </Specimen>
    </ShowcaseSection>
  );
}
