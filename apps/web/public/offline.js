/* global window */
// Reload the page the visitor asked for once the connection is back (docs/pwa.md#offline).
window.addEventListener('online', () => window.location.reload());
