/*
 * The web app's `zod` (vite.config.ts aliases the bare "zod" import here, for
 * the app and for @wayora/contracts alike).
 *
 * Zod compiles fast object parsers with `new Function`, after probing
 * whether eval is allowed. The Content-Security-Policy forbids eval
 * (config/security-headers.ts), so that probe would only produce a CSP
 * violation report on every page load. Compilation is switched off here,
 * before any schema exists — every module that defines one imports "zod",
 * i.e. this file, first. Validation is identical, just interpreted.
 */
import * as z from 'zod/v4';

z.config({ jitless: true });

export * from 'zod/v4';
export { z, z as default };
