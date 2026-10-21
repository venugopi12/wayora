#!/usr/bin/env node
// Copies every `.env.example` to `.env` when the `.env` does not exist yet.
// Existing `.env` files are never overwritten.
import { copyFileSync, existsSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const locations = ['.', 'apps/api', 'apps/worker', 'apps/web', 'database'];

for (const location of locations) {
  const example = join(root, location, '.env.example');
  const target = join(root, location, '.env');
  const label = relative(root, target) || '.env';
  if (!existsSync(example)) continue;
  if (existsSync(target)) {
    console.log(`skip    ${label} (already exists)`);
    continue;
  }
  copyFileSync(example, target);
  console.log(`created ${label}`);
}

console.log('\nEnvironment files are ready. Review them before running `npm run dev`.');
