#!/usr/bin/env node
// Copies every `.env.example` to `.env` when the `.env` does not exist yet.
// Existing `.env` files are never overwritten. For an existing `.env`, lists
// the settings its `.env.example` has and it lacks (added by later phases);
// with `--add-missing` they are appended with the example's local values.
//
//   npm run setup                    # create missing files, report missing settings
//   npm run setup -- --add-missing   # also append the missing settings
import { appendFileSync, copyFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const locations = ['.', 'apps/api', 'apps/worker', 'apps/web', 'database'];
const addMissing = process.argv.includes('--add-missing');

/** `KEY=value` lines (commented-out examples are ignored), in file order. */
function settings(file) {
  const entries = new Map();
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (match && !entries.has(match[1])) entries.set(match[1], line);
  }
  return entries;
}

let missingTotal = 0;
for (const location of locations) {
  const example = join(root, location, '.env.example');
  const target = join(root, location, '.env');
  const label = relative(root, target) || '.env';
  if (!existsSync(example)) continue;
  if (!existsSync(target)) {
    copyFileSync(example, target);
    console.log(`created ${label}`);
    continue;
  }
  const have = settings(target);
  const missing = [...settings(example)].filter(([key]) => !have.has(key));
  if (missing.length === 0) {
    console.log(`ok      ${label}`);
    continue;
  }
  missingTotal += missing.length;
  if (addMissing) {
    const block = missing.map(([, line]) => line).join('\n');
    const existing = readFileSync(target, 'utf8');
    appendFileSync(
      target,
      `${existing.endsWith('\n') ? '' : '\n'}\n# Added by \`npm run setup -- --add-missing\` from ${relative(root, example)}\n${block}\n`,
    );
    console.log(`updated ${label}: added ${missing.map(([key]) => key).join(', ')}`);
  } else {
    console.log(`missing ${label}: ${missing.map(([key]) => key).join(', ')}`);
  }
}

if (missingTotal > 0 && !addMissing) {
  console.log(
    '\nSome .env files predate settings added later. Add them by hand (see each .env.example),' +
      '\nor run `npm run setup -- --add-missing` to append the example values (existing values are kept).',
  );
}
console.log('\nEnvironment files are ready. Review them before running `npm run dev`.');
