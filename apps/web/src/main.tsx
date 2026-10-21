import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
// Self-hosted variable font (no third-party font requests).
import '@fontsource-variable/plus-jakarta-sans';
import './styles/index.css';

const container = document.getElementById('root');
if (!container) throw new Error('Root element #root not found in index.html');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
