#!/usr/bin/env node
// Production source maps must not be published with the site.
//
// `vite build` writes them as `hidden` maps (no sourceMappingURL comment in
// the bundle). This script moves every *.map out of dist/ into sourcemaps/
// (git-ignored, same relative paths) for debugging or upload to an error
// tracker, then fails the build if a map file or a map reference is still in
// dist/, so deploying dist/ as-is never exposes the original source.
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = fileURLToPath(new URL('../dist', import.meta.url));
const out = fileURLToPath(new URL('../sourcemaps', import.meta.url));

function* files(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* files(path);
    else yield path;
  }
}

// A fresh build replaces the previous build's maps; re-running the script
// without a new build keeps them.
const maps = [...files(dist)].filter((file) => file.endsWith('.map'));
if (maps.length > 0) rmSync(out, { recursive: true, force: true });
for (const file of maps) {
  const target = join(out, relative(dist, file));
  mkdirSync(dirname(target), { recursive: true });
  renameSync(file, target);
}
const moved = maps.length;

const problems = [];
for (const file of files(dist)) {
  if (file.endsWith('.map')) problems.push(`${relative(dist, file)}: source map in dist/`);
  else if (
    /\.(js|mjs|css|html)$/.test(file) &&
    /sourceMappingURL=/.test(readFileSync(file, 'utf8'))
  )
    problems.push(`${relative(dist, file)}: references a source map`);
}
if (problems.length > 0) {
  console.error(`✖ Source maps would be published with dist/:\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log(`✓ ${moved} source maps moved to sourcemaps/; none left in dist/.`);
