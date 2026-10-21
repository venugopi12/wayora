import { BrandLoader } from '@wayora/ui';

/** Loading state shown in <main> while a lazily loaded page's chunk arrives. */
export function PageLoader() {
  return (
    <div className="grid min-h-[60dvh] place-items-center">
      <BrandLoader label="Loading page" />
    </div>
  );
}
