import type { ReactNode } from 'react';
import { BrandMark, Container } from '@wayora/ui';

/** Message page used by the 404 page and error boundaries. */
export function FullPageMessage({
  code,
  title,
  description,
  actions,
}: {
  code: string;
  title: string;
  description: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <Container size="narrow" className="flex flex-col items-start py-section-sm">
      <BrandMark size={40} />
      <p className="mt-8 text-label text-brand-ink">{code}</p>
      <h1 className="mt-2 text-heading-1">{title}</h1>
      <div className="mt-4 max-w-prose text-body-lg text-ink-secondary">{description}</div>
      {actions ? <div className="mt-8 flex flex-wrap gap-3">{actions}</div> : null}
    </Container>
  );
}
