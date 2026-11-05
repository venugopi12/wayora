import '@testing-library/jest-dom/vitest';
import { cleanup, configure } from '@testing-library/react';
import { afterEach } from 'vitest';

afterEach(() => {
  cleanup();
  // Recent searches live in localStorage; each test starts without any.
  try {
    window.localStorage.clear();
  } catch {
    // Storage unavailable in this environment.
  }
});

// Routes load lazily (React Router `lazy`); under a parallel test run the first
// import of a chunk can take longer than the 1 s default for findBy*/waitFor.
configure({ asyncUtilTimeout: 5000 });

// jsdom gaps: Motion (matchMedia, IntersectionObserver), Radix (ResizeObserver,
// pointer capture), React Router <ScrollRestoration> (scrollTo).
window.matchMedia ??= (query: string) =>
  ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }) as MediaQueryList;

class ObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}
globalThis.ResizeObserver ??= ObserverStub as unknown as typeof ResizeObserver;
globalThis.IntersectionObserver ??= ObserverStub as unknown as typeof IntersectionObserver;
Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.releasePointerCapture ??= () => {};
Element.prototype.scrollIntoView ??= () => {};
window.scrollTo = () => {};
