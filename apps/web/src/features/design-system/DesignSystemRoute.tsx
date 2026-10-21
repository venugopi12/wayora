import { Badge, Container, PageHeader } from '@wayora/ui';
import { useDocumentTitle } from '../../hooks/useDocumentTitle';
import {
  ButtonSection,
  DisplaySection,
  FeedbackSection,
  FormSection,
  LayoutSection,
  OverlaySection,
} from './ComponentSections';
import { BrandSection, ColorSection, SpaceSection, TypographySection } from './FoundationSections';
import { MotionSection } from './MotionSection';
import { TravelSection } from './TravelSection';

const sections = [
  ['brand', 'Brand'],
  ['color', 'Colour'],
  ['typography', 'Typography'],
  ['space', 'Space, shape, depth'],
  ['buttons', 'Buttons'],
  ['forms', 'Form controls'],
  ['display', 'Badges and more'],
  ['layout', 'Layout'],
  ['overlays', 'Overlays'],
  ['feedback', 'States'],
  ['motion', 'Motion'],
  ['travel', 'Travel'],
] as const;

/**
 * Development-only design-system showcase (/design-system).
 * Never shipped: see apps/web/src/app/routes.tsx.
 */
export function DesignSystemRoute() {
  useDocumentTitle('Design system');

  return (
    <div data-showcase="wayora-dev-only:design-system">
      <Container size="wide" className="py-section-sm">
        <PageHeader
          title="Wayora design system"
          meta={<Badge tone="warning">Development only</Badge>}
          description="Tokens, brand assets and components from @wayora/ui. Every example on this page is a live component; read docs/design-system.md for usage rules."
        />
        <div className="mt-12 grid grid-cols-[minmax(0,1fr)] gap-10 lg:grid-cols-[13rem_minmax(0,1fr)] lg:gap-14">
          <nav
            aria-label="Design system sections"
            className="min-w-0 lg:sticky lg:top-24 lg:self-start"
          >
            <ul className="-mx-gutter flex gap-1 overflow-x-auto px-gutter pb-2 lg:mx-0 lg:flex-col lg:overflow-visible lg:px-0">
              {sections.map(([id, label]) => (
                <li key={id} className="shrink-0">
                  <a
                    href={`#${id}`}
                    className="flex min-h-10 items-center rounded-md px-3 text-body-sm font-semibold whitespace-nowrap text-ink-secondary transition-colors hover:bg-brand-soft hover:text-brand-ink"
                  >
                    {label}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
          <div className="flex min-w-0 flex-col gap-16">
            <BrandSection />
            <ColorSection />
            <TypographySection />
            <SpaceSection />
            <ButtonSection />
            <FormSection />
            <DisplaySection />
            <LayoutSection />
            <OverlaySection />
            <FeedbackSection />
            <MotionSection />
            <TravelSection />
          </div>
        </div>
      </Container>
    </div>
  );
}
