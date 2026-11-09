import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import { captureInstallPrompt } from './pwa/install';
import { registerServiceWorker } from './pwa/register';
// Self-hosted variable font (no third-party font requests).
import '@fontsource-variable/plus-jakarta-sans';
import './styles/index.css';

const container = document.getElementById('root');
if (!container) throw new Error('Root element #root not found in index.html');

// Browsers may offer installation before React renders: listen from the start.
captureInstallPrompt();
// Production only (docs/pwa.md#service-worker); after load, so it never competes with start-up.
// VITE_PWA=off (the kill switch) ships a worker that removes itself; the app then stops registering.
if (import.meta.env.PROD && import.meta.env.VITE_PWA !== 'off') {
  window.addEventListener('load', () => void registerServiceWorker(), { once: true });
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
