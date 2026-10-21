#!/usr/bin/env node
// Fails the production build if development-only code (the design-system
// showcase) leaked into the bundle. The showcase contains this marker string.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MARKER = 'wayora-dev-only:design-system';
const dist = fileURLToPath(new URL('../dist', import.meta.url));

function* files(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* files(path);
    else if (/\.(js|html|css)$/.test(name)) yield path;
  }
}

const leaks = [...files(dist)].filter((file) => readFileSync(file, 'utf8').includes(MARKER));
if (leaks.length > 0) {
  console.error(`✖ Development-only code found in the production build:\n  ${leaks.join('\n  ')}`);
  process.exit(1);
}
console.log('✓ No development-only routes in the production build.');
