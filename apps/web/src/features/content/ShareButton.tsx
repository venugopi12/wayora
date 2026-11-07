import { Check, Share2 } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@wayora/ui';
import { absoluteUrl } from '../seo/site';
import { siteUrl } from '../seo/SeoProvider';

/**
 * Share the page's canonical URL: the system share sheet where there is one,
 * otherwise copy the link. Nothing about the visitor is added to the URL.
 */
export function ShareButton({ title, path }: { title: string; path: string }) {
  const [copied, setCopied] = useState(false);
  const url = absoluteUrl(siteUrl(), path);
  return (
    <span className="inline-flex items-center gap-2">
      <Button
        variant="secondary"
        size="sm"
        onClick={async () => {
          const nav = navigator as Navigator & { share?: (d: ShareData) => Promise<void> };
          if (nav.share) {
            try {
              await nav.share({ title, url });
              return;
            } catch {
              // Cancelled or unavailable: fall back to copying.
            }
          }
          try {
            await navigator.clipboard.writeText(url);
            setCopied(true);
            window.setTimeout(() => setCopied(false), 3000);
          } catch {
            setCopied(false);
          }
        }}
      >
        {copied ? <Check aria-hidden="true" /> : <Share2 aria-hidden="true" />}
        {copied ? 'Link copied' : 'Share'}
      </Button>
      <span role="status" aria-live="polite" className="sr-only">
        {copied ? 'Link copied to the clipboard' : ''}
      </span>
    </span>
  );
}
