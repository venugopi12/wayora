import { Info, Lightbulb } from 'lucide-react';
import type { ContentBlock } from '@wayora/contracts';
import { mediaAsset } from '@wayora/contracts';

/*
 * Renders structured content blocks as semantic elements (docs/seo.md#content-model).
 * Text is always rendered as text: there is no HTML in content and no
 * dangerouslySetInnerHTML anywhere, so nothing needs sanitizing.
 */

export function ContentBody({ blocks }: { blocks: ContentBlock[] }) {
  return (
    <div className="flex flex-col gap-5 text-body-lg text-ink [&_h2]:mt-4 [&_h3]:mt-2">
      {blocks.map((b, i) => {
        switch (b.type) {
          case 'heading':
            return b.level === 2 ? (
              <h2 key={i} className="text-heading-3">
                {b.text}
              </h2>
            ) : (
              <h3 key={i} className="text-title">
                {b.text}
              </h3>
            );
          case 'paragraph':
            return b.text.split(/\n{2,}/).map((p, j) => (
              <p key={`${i}-${j}`} className="whitespace-pre-line">
                {p}
              </p>
            ));
          case 'list': {
            const List = b.style === 'number' ? 'ol' : 'ul';
            return (
              <List
                key={i}
                className={`flex flex-col gap-2 pl-6 ${b.style === 'number' ? 'list-decimal' : 'list-disc'}`}
              >
                {b.items.map((item, j) => (
                  <li key={j}>{item}</li>
                ))}
              </List>
            );
          }
          case 'tip':
            return (
              <div
                role="note"
                key={i}
                aria-label="Tip"
                className="flex gap-3 rounded-xl bg-brand-soft p-4 text-body text-brand-ink"
              >
                <Lightbulb className="mt-0.5 size-5 shrink-0" aria-hidden="true" />
                <p>{b.text}</p>
              </div>
            );
          case 'provider':
            return (
              <div
                role="note"
                key={i}
                aria-label="Set by the provider"
                className="flex gap-3 rounded-xl border border-line bg-sunken p-4 text-body"
              >
                <Info className="mt-0.5 size-5 shrink-0 text-ink-secondary" aria-hidden="true" />
                <p>
                  <strong className="font-semibold">Set by the provider, not Wayora: </strong>
                  {b.text}
                </p>
              </div>
            );
          case 'image': {
            const asset = mediaAsset(b.media);
            if (!asset) return null;
            return (
              <figure key={i} className="flex flex-col gap-2">
                <img
                  src={asset.src}
                  alt={b.alt}
                  width={asset.width}
                  height={asset.height}
                  loading="lazy"
                  decoding="async"
                  className="h-auto w-full rounded-xl"
                />
                {b.caption ? (
                  <figcaption className="text-caption text-ink-secondary">{b.caption}</figcaption>
                ) : null}
              </figure>
            );
          }
        }
      })}
    </div>
  );
}
