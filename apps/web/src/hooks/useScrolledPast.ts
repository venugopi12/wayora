import { useEffect, useRef, useState } from 'react';

/**
 * Reports whether the page has scrolled past a sentinel element, using one
 * IntersectionObserver instead of a scroll listener (no work on every frame).
 * Attach the returned ref to a small element at the very top of the page.
 */
export function useScrolledPast<T extends Element = HTMLDivElement>() {
  const sentinelRef = useRef<T | null>(null);
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const node = sentinelRef.current;
    if (!node || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(([entry]) => setScrolled(!entry?.isIntersecting), {
      threshold: 0,
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return { sentinelRef, scrolled };
}
