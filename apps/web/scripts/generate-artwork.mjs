#!/usr/bin/env node
/**
 * Generates Wayora's original homepage and Discover artwork as small, deterministic SVGs.
 *
 *   node apps/web/scripts/generate-artwork.mjs
 *
 * Every scene is built from the same vocabulary (graded skies, atmospheric
 * ridgelines, navy silhouettes, soft light) and the same palette, so the set
 * reads as one "editorial travel poster" series. Output is committed to
 * apps/web/public/media/artwork/. Re-running produces identical files (seeded
 * randomness). These are placeholders for licensed photography: see
 * docs/media-assets.md for how to replace any slot.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = fileURLToPath(new URL('../public/media/artwork/', import.meta.url));
mkdirSync(OUT, { recursive: true });

// ─── Palette (aligned with packages/ui theme tokens) ─────────────────────
const C = {
  navy: '#171b35',
  navy2: '#1d2244',
  deep: '#232849',
  indigo: '#5463b1',
  indigo2: '#3a4587',
  indigo3: '#2c3466',
  lavender: '#eef0ff',
  lav2: '#dde1f7',
  lav3: '#bcc3ec',
  lav4: '#8d98d4',
  peach: '#f4c9b1',
  peach2: '#f7dccb',
  rose: '#d99aa6',
  gold: '#f2c48d',
  sand: '#ecdcc8',
  cream: '#faf9f6',
};

// ─── Helpers ──────────────────────────────────────────────────────────────
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const r1 = (n) => Math.round(n * 10) / 10;
const lerp = (a, b, t) => a + (b - a) * t;
const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const mix = (a, b, t) => {
  const [x, y] = [hex(a), hex(b)];
  return `#${x
    .map((v, i) =>
      Math.round(lerp(v, y[i], t))
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;
};

/** 1-D value noise with octaves, deterministic per seed. */
function noise1D(seed) {
  const rand = rng(seed);
  const table = Array.from({ length: 512 }, () => rand());
  const smooth = (t) => t * t * (3 - 2 * t);
  const base = (x) => {
    const i = Math.floor(x);
    const f = x - i;
    return lerp(table[i & 511], table[(i + 1) & 511], smooth(f));
  };
  return (x, octaves = 4) => {
    let amp = 1;
    let freq = 1;
    let sum = 0;
    let norm = 0;
    for (let o = 0; o < octaves; o += 1) {
      sum += base(x * freq) * amp;
      norm += amp;
      amp *= 0.5;
      freq *= 2.1;
    }
    return sum / norm;
  };
}

/** Ridge path across the full width, closed to the bottom. Returns { d, minY }. */
function ridge({ w, h, seed, baseY, amp, scale = 520, octaves = 4, peaks = 1, step = 10 }) {
  const n = noise1D(seed);
  let minY = Infinity;
  const pts = [];
  for (let x = -step; x <= w + step; x += step) {
    let v = n(x / scale, octaves);
    v = Math.min(1, Math.max(0, (v - 0.12) / 0.76)); // stretch: value noise clusters mid-range
    v = Math.pow(v, peaks); // >1 sharpens peaks, <1 rounds hills
    const y = baseY - amp * v;
    minY = Math.min(minY, y);
    pts.push(`${r1(x)} ${r1(y)}`);
  }
  return { d: `M${pts.join('L')}L${w + step} ${h}L${-step} ${h}Z`, minY };
}

const svg = (w, h, body, defs = '') =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid slice">` +
  (defs ? `<defs>${defs}</defs>` : '') +
  body +
  '</svg>\n';

function linear(id, stops, { x1 = 0, y1 = 0, x2 = 0, y2 = 1, units = '' } = {}) {
  const u = units ? ` gradientUnits="${units}"` : '';
  return (
    `<linearGradient id="${id}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"${u}>` +
    stops
      .map(
        ([o, c, a = 1]) =>
          `<stop offset="${o}" stop-color="${c}"${a < 1 ? ` stop-opacity="${a}"` : ''}/>`,
      )
      .join('') +
    '</linearGradient>'
  );
}
function radial(id, stops, { cx = 0.5, cy = 0.5, r = 0.5, units = '' } = {}) {
  const u = units ? ` gradientUnits="${units}"` : '';
  return (
    `<radialGradient id="${id}" cx="${cx}" cy="${cy}" r="${r}"${u}>` +
    stops
      .map(
        ([o, c, a = 1]) =>
          `<stop offset="${o}" stop-color="${c}"${a < 1 ? ` stop-opacity="${a}"` : ''}/>`,
      )
      .join('') +
    '</radialGradient>'
  );
}

function stars({ w, seed, count, maxY, color = '#ffffff' }) {
  const rand = rng(seed);
  let out = '';
  for (let i = 0; i < count; i += 1) {
    const x = rand() * w;
    const y = Math.pow(rand(), 1.6) * maxY;
    const r = rand() < 0.08 ? 2.2 : 0.6 + rand() * 1.2;
    out += `<circle cx="${r1(x)}" cy="${r1(y)}" r="${r1(r)}" fill="${color}" opacity="${r1(0.25 + rand() * 0.6)}"/>`;
  }
  return out;
}

function sun({ id, cx, cy, r, core, glow, glowR = 4 }) {
  return {
    defs: radial(`${id}-glow`, [
      [0, glow, 0.55],
      [0.35, glow, 0.18],
      [1, glow, 0],
    ]),
    body:
      `<circle cx="${cx}" cy="${cy}" r="${r * glowR}" fill="url(#${id}-glow)"/>` +
      `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${core}"/>`,
  };
}

function haze({ id, w, y, height, color, opacity = 0.5 }) {
  return {
    defs: linear(`${id}`, [
      [0, color, 0],
      [0.3, color, opacity * 0.45],
      [0.5, color, opacity * 0.7],
      [0.7, color, opacity * 0.45],
      [1, color, 0],
    ]),
    body: `<rect x="0" y="${r1(y - height / 2)}" width="${w}" height="${height}" fill="url(#${id})"/>`,
  };
}

function birds({ seed, x, y, count, color, scale = 1 }) {
  const rand = rng(seed);
  let out = '';
  for (let i = 0; i < count; i += 1) {
    const bx = x + (rand() - 0.5) * 260 * scale;
    const by = y + (rand() - 0.5) * 90 * scale;
    const s = (8 + rand() * 7) * scale;
    out += `<path d="M${r1(bx - s)} ${r1(by)}q${r1(s * 0.5)} ${r1(-s * 0.55)} ${r1(s)} 0q${r1(s * 0.5)} ${r1(-s * 0.55)} ${r1(s)} 0" fill="none" stroke="${color}" stroke-width="${r1(1.6 * scale)}" stroke-linecap="round"/>`;
  }
  return out;
}

/** Coconut palm silhouette: tapered curved trunk + drooping fronds. */
function palm({ x, y, height, lean = 0.25, color, seed = 1, frondScale = 1 }) {
  const rand = rng(seed);
  const topX = x + lean * height;
  const topY = y - height;
  const cx = x + lean * height * 0.15;
  const cy = y - height * 0.55;
  const wBase = height * 0.035;
  const wTop = height * 0.016;
  const trunk =
    `M${r1(x - wBase)} ${y}Q${r1(cx - wBase * 0.6)} ${r1(cy)} ${r1(topX - wTop)} ${r1(topY)}` +
    `L${r1(topX + wTop)} ${r1(topY)}Q${r1(cx + wBase * 0.6)} ${r1(cy)} ${r1(x + wBase)} ${y}Z`;
  let fronds = '';
  const n = 9;
  for (let i = 0; i < n; i += 1) {
    const ang = -Math.PI + (i / (n - 1)) * Math.PI + (rand() - 0.5) * 0.25;
    const len = height * (0.34 + rand() * 0.14) * frondScale;
    const droop = height * (0.16 + rand() * 0.1) * frondScale;
    const tipX = topX + Math.cos(ang) * len;
    const tipY = topY + Math.sin(ang) * len * 0.45 + droop;
    const midX = topX + Math.cos(ang) * len * 0.55;
    const midY = topY + Math.sin(ang) * len * 0.55 - droop * 0.35;
    const thick = height * 0.028 * frondScale;
    fronds +=
      `<path d="M${r1(topX)} ${r1(topY)}Q${r1(midX)} ${r1(midY - thick)} ${r1(tipX)} ${r1(tipY)}` +
      `Q${r1(midX)} ${r1(midY + thick)} ${r1(topX)} ${r1(topY + thick * 0.4)}Z" fill="${color}"/>`;
  }
  return `<path d="${trunk}" fill="${color}"/>${fronds}`;
}

/** Conifer silhouette (three tiers). */
function pine({ x, y, h, color }) {
  const w = h * 0.36;
  let d = '';
  for (let t = 0; t < 3; t += 1) {
    const top = y - h + t * h * 0.24;
    const bottom = top + h * 0.48;
    const ww = w * (0.55 + t * 0.25);
    d += `M${r1(x)} ${r1(top)}L${r1(x + ww / 2)} ${r1(bottom)}L${r1(x - ww / 2)} ${r1(bottom)}Z`;
  }
  d += `M${r1(x - h * 0.03)} ${r1(y - h * 0.1)}h${r1(h * 0.06)}v${r1(h * 0.12)}h${r1(-h * 0.06)}Z`;
  return `<path d="${d}" fill="${color}"/>`;
}

function pineRow({ seed, w, baseFn, count, minH, maxH, color }) {
  const rand = rng(seed);
  let out = '';
  for (let i = 0; i < count; i += 1) {
    const x = rand() * w;
    out += pine({ x, y: baseFn(x) + 6, h: minH + rand() * (maxH - minH), color });
  }
  return out;
}

/** Reflection streaks on water under a light source. */
function streaks({ seed, cx, y0, y1, maxW, color }) {
  const rand = rng(seed);
  let out = '';
  for (let y = y0; y < y1; y += 9 + rand() * 9) {
    const t = (y - y0) / (y1 - y0);
    const wv = maxW * (1 - t * 0.6) * (0.35 + rand() * 0.75);
    const x = cx - wv / 2 + (rand() - 0.5) * 40 * t;
    out += `<rect x="${r1(x)}" y="${r1(y)}" width="${r1(wv)}" height="${r1(2 + rand() * 3)}" rx="2" fill="${color}" opacity="${r1(0.25 + (1 - t) * 0.45)}"/>`;
  }
  return out;
}

function write(name, content) {
  writeFileSync(join(OUT, name), content);
  return { name, bytes: Buffer.byteLength(content) };
}

// ─── Scenes ───────────────────────────────────────────────────────────────

/**
 * HERO — dawn over layered ridges, split into three parallax layers that share
 * one viewBox: sky (opaque), far ridges, near ridges (transparent).
 */
function heroLayers({ w, h, suffix, horizon, sunX }) {
  const files = [];
  const sky = linear('sky', [
    [0, '#0f1230'],
    [0.32, '#232a63'],
    [0.6, '#5b5f9e'],
    [0.78, '#c79aa8'],
    [0.9, C.peach],
    [1, C.peach2],
  ]);
  const s = sun({
    id: 'sun',
    cx: sunX,
    cy: horizon - h * 0.03,
    r: Math.min(w, h) * 0.07,
    core: '#fde8d6',
    glow: '#ffd9bd',
    glowR: 5,
  });
  const hz = haze({ id: 'hz', w, y: horizon, height: h * 0.16, color: C.peach2, opacity: 0.45 });
  files.push(
    write(
      `hero-dawn-sky${suffix}.svg`,
      svg(
        w,
        h,
        `<rect width="${w}" height="${h}" fill="url(#sky)"/>` +
          stars({ w, h, seed: 11, count: Math.round(w / 9), maxY: h * 0.42 }) +
          s.body +
          hz.body,
        sky + s.defs + hz.defs,
      ),
    ),
  );

  // Far ridges: three layers, lavender to dusk-indigo, fading into haze.
  const far = [
    { seed: 21, base: horizon + h * 0.04, amp: h * 0.26, color: '#a99bc0', scale: 520, peaks: 1.6 },
    { seed: 22, base: horizon + h * 0.1, amp: h * 0.22, color: '#7e78ad', scale: 440, peaks: 1.5 },
    { seed: 23, base: horizon + h * 0.18, amp: h * 0.2, color: '#545894', scale: 400, peaks: 1.3 },
  ];
  let farBody = '';
  let farDefs = '';
  far.forEach((l, i) => {
    const r = ridge({
      w,
      h,
      seed: l.seed,
      baseY: l.base,
      amp: l.amp,
      scale: l.scale,
      peaks: l.peaks,
    });
    farDefs += linear(
      `f${i}`,
      [
        [0, mix(l.color, '#ffffff', 0.08)],
        [1, mix(l.color, C.peach, 0.18)],
      ],
      { units: 'userSpaceOnUse', y1: r.minY, y2: l.base + h * 0.05 },
    );
    farBody += `<path d="${r.d}" fill="url(#f${i})"/>`;
    if (i < 2) {
      const mist = haze({
        id: `fm${i}`,
        w,
        y: l.base - h * 0.01,
        height: h * 0.14,
        color: C.peach2,
        opacity: 0.18,
      });
      farDefs += mist.defs;
      farBody += mist.body;
    }
  });
  files.push(write(`hero-dawn-far${suffix}.svg`, svg(w, h, farBody, farDefs)));

  // Near ridges: two dark navy layers framing the bottom.
  const near = [
    { seed: 31, base: horizon + h * 0.28, amp: h * 0.2, color: C.indigo3, scale: 520, peaks: 1.2 },
    { seed: 32, base: h * 1.02, amp: h * 0.24, color: C.navy, scale: 600, peaks: 1.1 },
  ];
  let nearBody = '';
  let nearDefs = '';
  near.forEach((l, i) => {
    const r = ridge({
      w,
      h,
      seed: l.seed,
      baseY: l.base,
      amp: l.amp,
      scale: l.scale,
      peaks: l.peaks,
    });
    nearDefs += linear(
      `n${i}`,
      [
        [0, mix(l.color, '#8b86b8', i === 0 ? 0.32 : 0.12)],
        [1, l.color],
      ],
      { units: 'userSpaceOnUse', y1: r.minY, y2: r.minY + h * 0.22 },
    );
    nearBody += `<path d="${r.d}" fill="url(#n${i})"/>`;
  });
  files.push(write(`hero-dawn-near${suffix}.svg`, svg(w, h, nearBody, nearDefs)));
  return files;
}

function beach() {
  const [w, h] = [1200, 1500];
  const horizon = h * 0.56;
  const defs =
    linear('sky', [
      [0, '#6f75b6'],
      [0.45, '#b9a6c6'],
      [0.8, '#f1c3ad'],
      [1, C.peach2],
    ]) +
    linear('sea', [
      [0, '#7d84bf'],
      [0.35, C.indigo],
      [1, C.indigo3],
    ]) +
    linear('sand', [
      [0, '#e8cdb6'],
      [1, '#d4b097'],
    ]);
  const s = sun({
    id: 's',
    cx: w * 0.4,
    cy: horizon - h * 0.08,
    r: 70,
    core: '#fff0e2',
    glow: '#ffd7bd',
    glowR: 5,
  });
  const hz = haze({ id: 'hz', w, y: horizon - 4, height: 90, color: C.peach2, opacity: 0.5 });
  const dune = ridge({
    w,
    h,
    seed: 41,
    baseY: h * 0.98,
    amp: h * 0.16,
    scale: 900,
    octaves: 2,
    peaks: 0.8,
  });
  const body =
    `<rect width="${w}" height="${h}" fill="url(#sky)"/>` +
    s.body +
    `<rect y="${horizon}" width="${w}" height="${h - horizon}" fill="url(#sea)"/>` +
    hz.body +
    streaks({ seed: 42, cx: w * 0.4, y0: horizon + 6, y1: h * 0.84, maxW: 210, color: '#ffe3cf' }) +
    `<path d="${dune.d}" fill="url(#sand)"/>` +
    palm({ x: w * 0.93, y: h * 1.01, height: h * 0.62, lean: -0.32, color: C.navy, seed: 43 }) +
    palm({
      x: w * 1.04,
      y: h * 1.03,
      height: h * 0.5,
      lean: -0.42,
      color: C.navy2,
      seed: 44,
      frondScale: 0.9,
    }) +
    birds({ seed: 45, x: w * 0.3, y: h * 0.24, count: 4, color: C.indigo3, scale: 1.2 });
  return write('mood-beach-escapes.svg', svg(w, h, body, defs + s.defs + hz.defs));
}

function mountains({
  w = 1200,
  h = 1500,
  name = 'mood-mountain-retreats.svg',
  seedBase = 50,
} = {}) {
  const horizon = h * 0.5;
  let defs = linear('sky', [
    [0, '#9aa3d6'],
    [0.5, C.lav2],
    [1, C.lavender],
  ]);
  let body = `<rect width="${w}" height="${h}" fill="url(#sky)"/>`;
  const s = sun({
    id: 's',
    cx: w * 0.7,
    cy: h * 0.2,
    r: Math.min(w, h) * 0.045,
    core: '#ffffff',
    glow: '#ffffff',
    glowR: 5,
  });
  defs += s.defs;
  body += s.body;
  const layers = [
    {
      base: horizon + h * 0.05,
      amp: h * 0.34,
      color: '#8e97cc',
      scale: 380,
      peaks: 2.1,
      snow: true,
    },
    {
      base: horizon + h * 0.18,
      amp: h * 0.3,
      color: '#6670ad',
      scale: 330,
      peaks: 1.9,
      snow: true,
    },
    { base: horizon + h * 0.3, amp: h * 0.2, color: C.indigo2, scale: 300, peaks: 1.4 },
    { base: h * 1.02, amp: h * 0.22, color: C.navy, scale: 420, peaks: 1.2 },
  ];
  layers.forEach((l, i) => {
    const r = ridge({
      w,
      h,
      seed: seedBase + i,
      baseY: l.base,
      amp: l.amp,
      scale: l.scale,
      peaks: l.peaks,
    });
    if (l.snow) {
      defs += linear(
        `m${i}`,
        [
          [0, '#ffffff'],
          [0.16, '#f4f5ff'],
          [0.34, l.color],
          [1, mix(l.color, C.navy, 0.25)],
        ],
        { units: 'userSpaceOnUse', y1: r.minY, y2: l.base },
      );
    } else {
      defs += linear(
        `m${i}`,
        [
          [0, mix(l.color, '#a9b0dd', 0.25)],
          [1, l.color],
        ],
        { units: 'userSpaceOnUse', y1: r.minY, y2: l.base },
      );
    }
    body += `<path d="${r.d}" fill="url(#m${i})"/>`;
    if (i < 2) {
      const mist = haze({
        id: `mi${i}`,
        w,
        y: l.base - h * 0.04,
        height: h * 0.16,
        color: '#ffffff',
        opacity: 0.22,
      });
      defs += mist.defs;
      body += mist.body;
    }
    if (i === 2) {
      const n = noise1D(seedBase + i);
      const baseFn = (x) => l.base - l.amp * Math.pow(n(x / l.scale, 4), l.peaks);
      body += pineRow({
        seed: 77 + seedBase,
        w,
        baseFn,
        count: Math.round(w / 26),
        minH: h * 0.035,
        maxH: h * 0.06,
        color: C.indigo3,
      });
    }
    if (i === 3) {
      const n = noise1D(seedBase + i);
      const baseFn = (x) => l.base - l.amp * Math.pow(n(x / l.scale, 4), l.peaks);
      body += pineRow({
        seed: 88 + seedBase,
        w,
        baseFn,
        count: Math.round(w / 40),
        minH: h * 0.07,
        maxH: h * 0.12,
        color: C.navy,
      });
    }
  });
  return write(name, svg(w, h, body, defs));
}

/** Indo-Islamic skyline vocabulary: domes, arches, minarets, chhatris, walls. */
function dome(x, y, wv, hv, color) {
  const finial = `<rect x="${r1(x - 1.5)}" y="${r1(y - hv - hv * 0.35)}" width="3" height="${r1(hv * 0.35)}" fill="${color}"/>`;
  return (
    `<path d="M${r1(x - wv / 2)} ${r1(y)}C${r1(x - wv / 2)} ${r1(y - hv * 0.7)} ${r1(x - wv * 0.12)} ${r1(y - hv * 0.82)} ${r1(x)} ${r1(y - hv)}` +
    `C${r1(x + wv * 0.12)} ${r1(y - hv * 0.82)} ${r1(x + wv / 2)} ${r1(y - hv * 0.7)} ${r1(x + wv / 2)} ${r1(y)}Z" fill="${color}"/>` +
    finial
  );
}
function chhatri(x, y, wv, color) {
  const hv = wv * 0.9;
  return (
    `<rect x="${r1(x - wv / 2)}" y="${r1(y - hv)}" width="${r1(wv)}" height="${r1(hv)}" fill="${color}"/>` +
    `<rect x="${r1(x - wv * 0.6)}" y="${r1(y - hv - 4)}" width="${r1(wv * 1.2)}" height="5" fill="${color}"/>` +
    dome(x, y - hv - 4, wv * 0.9, wv * 0.55, color)
  );
}
function archRow(x, y, count, aw, ah, wallColor, holeColor) {
  let out = `<rect x="${r1(x)}" y="${r1(y - ah - 18)}" width="${r1(count * aw)}" height="${r1(ah + 18)}" fill="${wallColor}"/>`;
  for (let i = 0; i < count; i += 1) {
    const cx = x + aw * i + aw / 2;
    const ow = aw * 0.56;
    out +=
      `<path d="M${r1(cx - ow / 2)} ${r1(y)}V${r1(y - ah * 0.6)}Q${r1(cx - ow / 2)} ${r1(y - ah)} ${r1(cx)} ${r1(y - ah)}` +
      `Q${r1(cx + ow / 2)} ${r1(y - ah)} ${r1(cx + ow / 2)} ${r1(y - ah * 0.6)}V${r1(y)}Z" fill="${holeColor}"/>`;
  }
  return out;
}
function minaret(x, y, hv, wv, color) {
  return (
    `<rect x="${r1(x - wv / 2)}" y="${r1(y - hv)}" width="${r1(wv)}" height="${r1(hv)}" fill="${color}"/>` +
    `<rect x="${r1(x - wv)}" y="${r1(y - hv * 0.62)}" width="${r1(wv * 2)}" height="5" fill="${color}"/>` +
    chhatri(x, y - hv, wv * 1.5, color)
  );
}
function windows({ seed, x0, x1, y0, y1, count, color }) {
  const rand = rng(seed);
  let out = '';
  for (let i = 0; i < count; i += 1) {
    out += `<rect x="${r1(x0 + rand() * (x1 - x0))}" y="${r1(y0 + rand() * (y1 - y0))}" width="3" height="5" rx="1" fill="${color}" opacity="${r1(0.4 + rand() * 0.6)}"/>`;
  }
  return out;
}

function city() {
  const [w, h] = [1200, 1500];
  const ground = h * 0.78;
  const defs =
    linear('sky', [
      [0, '#272d68'],
      [0.45, '#6a5f9e'],
      [0.75, '#c88fa3'],
      [1, '#f0bba8'],
    ]) +
    linear('fg', [
      [0, C.indigo3],
      [1, C.navy],
    ]);
  const s = sun({
    id: 's',
    cx: w * 0.62,
    cy: h * 0.6,
    r: 64,
    core: '#ffe2cf',
    glow: '#ffc8b0',
    glowR: 5,
  });
  let body =
    `<rect width="${w}" height="${h}" fill="url(#sky)"/>` +
    stars({ w, h, seed: 61, count: 70, maxY: h * 0.3 }) +
    s.body;
  // Far skyline (lilac)
  const far = '#8a7fb3';
  body += `<rect x="0" y="${r1(ground - 40)}" width="${w}" height="${r1(h - ground + 40)}" fill="${far}"/>`;
  body +=
    dome(w * 0.18, ground - 120, 150, 120, far) +
    `<rect x="${r1(w * 0.18 - 90)}" y="${r1(ground - 120)}" width="180" height="90" fill="${far}"/>`;
  body +=
    minaret(w * 0.06, ground - 40, 260, 18, far) + minaret(w * 0.3, ground - 40, 230, 16, far);
  body +=
    dome(w * 0.83, ground - 90, 120, 90, far) +
    `<rect x="${r1(w * 0.83 - 70)}" y="${r1(ground - 90)}" width="140" height="60" fill="${far}"/>`;
  // Mid skyline (indigo)
  const mid = C.indigo2;
  body += `<rect x="0" y="${r1(ground - 10)}" width="${w}" height="${r1(h)}" fill="${mid}"/>`;
  body += archRow(w * 0.38, ground - 10, 5, 70, 80, mid, '#c890a2');
  body +=
    chhatri(w * 0.38 + 35, ground - 108, 46, mid) + chhatri(w * 0.38 + 315, ground - 108, 46, mid);
  body += dome(w * 0.53, ground - 108, 120, 110, mid);
  body += minaret(w * 0.97, ground - 10, 300, 20, mid);
  body += windows({
    seed: 62,
    x0: w * 0.02,
    x1: w * 0.35,
    y0: ground - 6,
    y1: ground + 40,
    count: 22,
    color: C.gold,
  });
  // Foreground arch frame
  body += `<path d="M0 0H${w}V${h}H0Z M${r1(w * 0.12)} ${h}V${r1(h * 0.42)}C${r1(w * 0.12)} ${r1(h * 0.2)} ${r1(w * 0.34)} ${r1(h * 0.12)} ${r1(w * 0.5)} ${r1(h * 0.06)}C${r1(w * 0.66)} ${r1(h * 0.12)} ${r1(w * 0.88)} ${r1(h * 0.2)} ${r1(w * 0.88)} ${r1(h * 0.42)}V${h}Z" fill="url(#fg)" fill-rule="evenodd"/>`;
  body += `<rect x="${r1(w * 0.12)}" y="${r1(h * 0.93)}" width="${r1(w * 0.76)}" height="${r1(h * 0.07)}" fill="${C.navy}"/>`;
  return write('mood-cultural-cities.svg', svg(w, h, body, defs + s.defs));
}

function road() {
  const [w, h] = [1200, 1500];
  const horizon = h * 0.46;
  let defs =
    linear('sky', [
      [0, '#8a90c9'],
      [0.55, '#e3c3c0'],
      [1, '#f7d8bf'],
    ]) +
    linear('road', [
      [0, '#f2dccb', 0.9],
      [1, '#e9cdb8', 1],
    ]);
  const s = sun({
    id: 's',
    cx: w * 0.5,
    cy: horizon - 30,
    r: 58,
    core: '#fff1e4',
    glow: '#ffd9bf',
    glowR: 6,
  });
  let body = `<rect width="${w}" height="${h}" fill="url(#sky)"/>` + s.body;
  const hills = [
    { base: horizon + 40, amp: 110, color: '#a59ac4', scale: 520, peaks: 0.9 },
    { base: horizon + 170, amp: 150, color: '#7e78b0', scale: 460, peaks: 0.85 },
    { base: horizon + 330, amp: 170, color: '#4b5193', scale: 420, peaks: 0.8 },
    { base: h * 1.02, amp: 220, color: C.indigo3, scale: 520, peaks: 0.8 },
  ];
  hills.forEach((l, i) => {
    const r = ridge({
      w,
      h,
      seed: 70 + i,
      baseY: l.base,
      amp: l.amp,
      scale: l.scale,
      octaves: 3,
      peaks: l.peaks,
    });
    defs += linear(
      `h${i}`,
      [
        [0, mix(l.color, '#f3d1c0', 0.18)],
        [1, l.color],
      ],
      { units: 'userSpaceOnUse', y1: r.minY, y2: l.base },
    );
    body += `<path d="${r.d}" fill="url(#h${i})"/>`;
  });
  // Winding road: centreline sampled, widened with perspective.
  const left = [];
  const right = [];
  for (let t = 0; t <= 1.0001; t += 0.02) {
    const y = lerp(h * 1.02, horizon + 52, Math.pow(t, 0.75));
    const x = w * 0.5 + Math.sin(t * 7.2) * w * 0.26 * (1 - t) + (1 - t) * w * 0.08;
    const half = lerp(150, 2, Math.pow(t, 0.7));
    left.push(`${r1(x - half)} ${r1(y)}`);
    right.unshift(`${r1(x + half)} ${r1(y)}`);
  }
  body += `<path d="M${left.join('L')}L${right.join('L')}Z" fill="url(#road)" opacity="0.9"/>`;
  // Trees along the near hill
  const rand = rng(79);
  for (let i = 0; i < 9; i += 1) {
    const x = rand() * w;
    const y = h * (0.88 + rand() * 0.1);
    const rr = 30 + rand() * 40;
    body += `<ellipse cx="${r1(x)}" cy="${r1(y - rr)}" rx="${r1(rr * 0.8)}" ry="${r1(rr)}" fill="${C.navy}"/><rect x="${r1(x - 3)}" y="${r1(y - rr * 0.3)}" width="6" height="${r1(rr * 0.6)}" fill="${C.navy}"/>`;
  }
  body += birds({ seed: 78, x: w * 0.68, y: h * 0.2, count: 3, color: C.indigo3, scale: 1.1 });
  return write('mood-weekend-getaways.svg', svg(w, h, body, defs + s.defs));
}

function goa() {
  const [w, h] = [1600, 1200];
  const horizon = h * 0.55;
  const defs =
    linear('sky', [
      [0, '#4f4f97'],
      [0.45, '#b6849f'],
      [0.8, '#f0a98f'],
      [1, '#f7c3a3'],
    ]) +
    linear('sea', [
      [0, '#a26f98'],
      [0.3, '#5d5a9c'],
      [1, C.indigo3],
    ]);
  const s = sun({
    id: 's',
    cx: w * 0.56,
    cy: horizon - 4,
    r: 78,
    core: '#ffd9b8',
    glow: '#ffb990',
    glowR: 5,
  });
  let body =
    `<rect width="${w}" height="${h}" fill="url(#sky)"/>` +
    s.body +
    `<rect y="${horizon}" width="${w}" height="${h - horizon}" fill="url(#sea)"/>` +
    streaks({ seed: 81, cx: w * 0.56, y0: horizon + 4, y1: h * 0.9, maxW: 260, color: '#ffd2b3' });
  // Fishing boats
  const boat = (x, y, s2) =>
    `<path d="M${r1(x - 70 * s2)} ${r1(y)}Q${r1(x)} ${r1(y + 22 * s2)} ${r1(x + 80 * s2)} ${r1(y - 6 * s2)}L${r1(x + 60 * s2)} ${r1(y + 12 * s2)}Q${r1(x)} ${r1(y + 30 * s2)} ${r1(x - 60 * s2)} ${r1(y + 10 * s2)}Z" fill="${C.navy}"/>` +
    `<rect x="${r1(x - 2)}" y="${r1(y - 80 * s2)}" width="${r1(3 * s2)}" height="${r1(82 * s2)}" fill="${C.navy}"/>` +
    `<path d="M${r1(x + 2)} ${r1(y - 76 * s2)}L${r1(x + 48 * s2)} ${r1(y - 8 * s2)}L${r1(x + 2)} ${r1(y - 8 * s2)}Z" fill="${C.navy2}"/>`;
  body += boat(w * 0.3, horizon + 90, 1) + boat(w * 0.73, horizon + 40, 0.55);
  const shore = ridge({
    w,
    h,
    seed: 82,
    baseY: h * 1.02,
    amp: h * 0.12,
    scale: 700,
    octaves: 2,
    peaks: 0.9,
  });
  body += `<path d="${shore.d}" fill="${C.navy}"/>`;
  body += palm({ x: w * 0.08, y: h * 1.02, height: h * 0.78, lean: 0.28, color: C.navy, seed: 83 });
  body += palm({ x: w * 0.16, y: h * 1.04, height: h * 0.6, lean: 0.1, color: C.navy2, seed: 84 });
  body += palm({ x: w * 0.97, y: h * 1.03, height: h * 0.66, lean: -0.3, color: C.navy, seed: 85 });
  body += birds({ seed: 86, x: w * 0.62, y: h * 0.22, count: 4, color: C.indigo3, scale: 1.3 });
  return write('destination-goa.svg', svg(w, h, body, defs + s.defs));
}

function jaipur() {
  const [w, h] = [1600, 1200];
  const defs =
    linear('sky', [
      [0, '#6e5c9c'],
      [0.5, '#d38f95'],
      [1, '#f3bfa2'],
    ]) +
    linear('hill', [
      [0, '#a8648a'],
      [1, '#6c4a86'],
    ]) +
    linear('wall', [
      [0, '#e1a49a'],
      [1, '#c97f86'],
    ]);
  const s = sun({
    id: 's',
    cx: w * 0.78,
    cy: h * 0.3,
    r: 60,
    core: '#ffeadb',
    glow: '#ffd2bf',
    glowR: 5,
  });
  let body = `<rect width="${w}" height="${h}" fill="url(#sky)"/>` + s.body;
  const hillBase = h * 0.66;
  const hill = ridge({
    w,
    h,
    seed: 91,
    baseY: hillBase,
    amp: h * 0.24,
    scale: 600,
    octaves: 3,
    peaks: 0.9,
  });
  body += `<path d="${hill.d}" fill="url(#hill)"/>`;
  // Fort wall with merlons following the hill crest.
  const n = noise1D(91);
  const crest = (x) => hillBase - h * 0.24 * Math.pow(n(x / 600, 3), 0.9);
  let merlons = '';
  for (let x = w * 0.12; x < w * 0.66; x += 22) {
    const y = crest(x) - 26;
    merlons += `<rect x="${r1(x)}" y="${r1(y - 14)}" width="12" height="16" fill="#7d4f86"/><rect x="${r1(x - 10)}" y="${r1(y)}" width="32" height="28" fill="#7d4f86"/>`;
  }
  body += merlons;
  body +=
    chhatri(w * 0.24, crest(w * 0.24) - 40, 40, '#7d4f86') +
    chhatri(w * 0.5, crest(w * 0.5) - 40, 48, '#7d4f86');
  // Pink-city facade: a stepped, pyramid-crowned screen of small oriel
  // windows, inspired by Jaipur's palace architecture (not a replica).
  const fx = w * 0.4;
  const fw = w * 0.56;
  const tiers = 6;
  const tierH = h * 0.085;
  const baseTop = h * 0.66;
  for (let t = 0; t < tiers; t += 1) {
    const inset = t * fw * 0.075;
    const x0 = fx + inset;
    const x1 = fx + fw - inset;
    const y1 = baseTop - t * tierH;
    const y0 = y1 - tierH;
    const tone = mix('#e7aa9f', '#cf868c', t / tiers);
    body += `<rect x="${r1(x0)}" y="${r1(y0)}" width="${r1(x1 - x0)}" height="${r1(tierH + 2)}" fill="${tone}"/>`;
    body += `<rect x="${r1(x0 - 6)}" y="${r1(y0 - 4)}" width="${r1(x1 - x0 + 12)}" height="6" fill="#b56f84"/>`;
    const n = Math.max(2, Math.floor((x1 - x0) / 46));
    for (let c = 0; c < n; c += 1) {
      const cx = x0 + (x1 - x0) * ((c + 0.5) / n);
      const cy = y0 + tierH * 0.28;
      body += `<path d="M${r1(cx - 13)} ${r1(cy + tierH * 0.6)}V${r1(cy + 10)}Q${r1(cx - 13)} ${r1(cy - 4)} ${r1(cx)} ${r1(cy - 8)}Q${r1(cx + 13)} ${r1(cy - 4)} ${r1(cx + 13)} ${r1(cy + 10)}V${r1(cy + tierH * 0.6)}Z" fill="#9a5679"/>`;
      body += `<path d="M${r1(cx - 17)} ${r1(cy - 4)}Q${r1(cx)} ${r1(cy - 22)} ${r1(cx + 17)} ${r1(cy - 4)}Z" fill="${mix(tone, '#ffffff', 0.18)}"/>`;
    }
  }
  const crownY = baseTop - tiers * tierH;
  body += dome(fx + fw / 2, crownY - 2, 60, 46, '#cf868c');
  body += `<rect x="${r1(fx - 20)}" y="${r1(baseTop)}" width="${r1(fw + 40)}" height="${r1(h - baseTop)}" fill="#c27a86"/>`;
  for (let c = 0; c < 7; c += 1) {
    const cx = fx + (fw * (c + 0.5)) / 7;
    body += `<path d="M${r1(cx - 26)} ${h}V${r1(baseTop + 110)}Q${r1(cx - 26)} ${r1(baseTop + 60)} ${r1(cx)} ${r1(baseTop + 48)}Q${r1(cx + 26)} ${r1(baseTop + 60)} ${r1(cx + 26)} ${r1(baseTop + 110)}V${h}Z" fill="#8b4c72"/>`;
  }
  // Foreground arch silhouette on the left
  body += `<path d="M0 ${h}V0H${r1(w * 0.36)}V${h}H${r1(w * 0.3)}V${r1(h * 0.52)}C${r1(w * 0.3)} ${r1(h * 0.34)} ${r1(w * 0.2)} ${r1(h * 0.24)} ${r1(w * 0.16)} ${r1(h * 0.2)}C${r1(w * 0.12)} ${r1(h * 0.24)} ${r1(w * 0.04)} ${r1(h * 0.34)} ${r1(w * 0.04)} ${r1(h * 0.52)}V${h}Z" fill="${C.navy}"/>`;
  body += birds({ seed: 92, x: w * 0.62, y: h * 0.16, count: 5, color: '#6b4a86', scale: 1.2 });
  return write('destination-jaipur.svg', svg(w, h, body, defs + s.defs));
}

function kerala() {
  const [w, h] = [1600, 1200];
  const waterY = h * 0.6;
  const defs =
    linear('sky', [
      [0, '#8cb0b3'],
      [0.5, '#d9e3d8'],
      [1, '#f6eadb'],
    ]) +
    linear('water', [
      [0, '#cfdcd2'],
      [0.25, '#8fb0aa'],
      [1, '#3c5f66'],
    ]);
  const s = sun({
    id: 's',
    cx: w * 0.36,
    cy: h * 0.32,
    r: 54,
    core: '#fff8ec',
    glow: '#fff2dc',
    glowR: 6,
  });
  let body = `<rect width="${w}" height="${h}" fill="url(#sky)"/>` + s.body;
  const bank = ridge({
    w,
    h,
    seed: 101,
    baseY: waterY + 4,
    amp: h * 0.08,
    scale: 520,
    octaves: 3,
    peaks: 0.8,
  });
  body += `<path d="${bank.d}" fill="#4f7a77"/>`;
  body += `<rect y="${waterY}" width="${w}" height="${h - waterY}" fill="url(#water)"/>`;
  // Distant palms along the bank + reflections
  const rand = rng(102);
  for (let i = 0; i < 14; i += 1) {
    const x = rand() * w;
    const ph = h * (0.16 + rand() * 0.12);
    const p = palm({
      x,
      y: waterY + 2,
      height: ph,
      lean: (rand() - 0.5) * 0.4,
      color: '#2f5257',
      seed: 103 + i,
      frondScale: 1.1,
    });
    body +=
      p + `<g transform="translate(0 ${r1(waterY * 2 + 4)}) scale(1 -1)" opacity="0.22">${p}</g>`;
  }
  body += streaks({
    seed: 104,
    cx: w * 0.36,
    y0: waterY + 10,
    y1: h * 0.82,
    maxW: 160,
    color: '#fffaf0',
  });
  // Houseboat (kettuvallam) silhouette
  const bx = w * 0.62;
  const by = h * 0.76;
  body += `<path d="M${r1(bx - 230)} ${r1(by - 30)}Q${r1(bx - 120)} ${r1(by + 26)} ${r1(bx + 10)} ${r1(by + 22)}Q${r1(bx + 160)} ${r1(by + 22)} ${r1(bx + 250)} ${r1(by - 40)}L${r1(bx + 220)} ${r1(by)}Q${r1(bx)} ${r1(by + 46)} ${r1(bx - 200)} ${r1(by)}Z" fill="${C.navy}"/>`;
  body += `<path d="M${r1(bx - 160)} ${r1(by + 2)}V${r1(by - 42)}Q${r1(bx - 20)} ${r1(by - 110)} ${r1(bx + 150)} ${r1(by - 46)}V${r1(by + 4)}Z" fill="#26334f"/>`;
  for (let i = 0; i < 6; i += 1) {
    body += `<rect x="${r1(bx - 130 + i * 48)}" y="${r1(by - 40)}" width="22" height="22" rx="3" fill="#f2c48d" opacity="0.75"/>`;
  }
  body += `<rect x="${r1(bx - 240)}" y="${r1(by + 30)}" width="500" height="6" rx="3" fill="#2a3f48" opacity="0.5"/>`;
  // Foreground palm framing the right edge
  body += palm({
    x: w * 1.02,
    y: h * 1.04,
    height: h * 0.95,
    lean: -0.38,
    color: '#1f3036',
    seed: 120,
  });
  body += palm({
    x: w * -0.02,
    y: h * 1.04,
    height: h * 0.7,
    lean: 0.36,
    color: '#1f3036',
    seed: 121,
    frondScale: 0.9,
  });
  return write('destination-kerala.svg', svg(w, h, body, defs + s.defs));
}

function cta({ w, h, suffix }) {
  let defs = linear('sky', [
    [0, '#090b1c'],
    [0.5, '#1a1f4a'],
    [0.82, '#343a78'],
    [1, '#3f4483'],
  ]);
  let body =
    `<rect width="${w}" height="${h}" fill="url(#sky)"/>` +
    stars({ w, h, seed: 131, count: Math.round(w / 5), maxY: h * 0.62 });
  // Crescent moon
  const mx = w * 0.78;
  const my = h * 0.2;
  const mr = Math.min(w, h) * 0.045;
  defs += radial('moonglow', [
    [0, '#dde1f7', 0.35],
    [1, '#dde1f7', 0],
  ]);
  body += `<circle cx="${r1(mx)}" cy="${r1(my)}" r="${r1(mr * 5)}" fill="url(#moonglow)"/>`;
  defs += `<mask id="crescent"><rect width="${w}" height="${h}" fill="#fff"/><circle cx="${r1(mx + mr * 0.42)}" cy="${r1(my - mr * 0.22)}" r="${r1(mr * 0.86)}" fill="#000"/></mask>`;
  body += `<circle cx="${r1(mx)}" cy="${r1(my)}" r="${r1(mr)}" fill="#f4f5ff" mask="url(#crescent)"/>`;
  const layers = [
    { base: h * 0.72, amp: h * 0.24, color: '#323873', scale: 480, peaks: 1.5 },
    { base: h * 0.86, amp: h * 0.22, color: '#232857', scale: 420, peaks: 1.3 },
  ];
  layers.forEach((l, i) => {
    const r = ridge({
      w,
      h,
      seed: 140 + i,
      baseY: l.base,
      amp: l.amp,
      scale: l.scale,
      peaks: l.peaks,
    });
    defs += linear(
      `c${i}`,
      [
        [0, mix(l.color, '#8d98d4', 0.55)],
        [0.3, l.color],
        [1, C.navy],
      ],
      { units: 'userSpaceOnUse', y1: r.minY, y2: h },
    );
    body += `<path d="${r.d}" fill="url(#c${i})"/>`;
  });
  // Fade to exactly the footer navy so the section flows into it.
  defs += linear('fade', [
    [0, C.navy, 0],
    [1, C.navy, 1],
  ]);
  body += `<rect y="${r1(h * 0.78)}" width="${w}" height="${r1(h * 0.22 + 1)}" fill="url(#fade)"/>`;
  return write(`cta-night-ridges${suffix}.svg`, svg(w, h, body, defs));
}

// ─── Phase 6: more destinations and moods ─────────────────────────────────

/** Row of towers with lit windows. Returns SVG. */
function skyline({
  seed,
  x0,
  x1,
  baseY,
  minH,
  maxH,
  minW,
  maxW,
  color,
  windowColor = C.gold,
  windowChance = 0.18,
  gap = 4,
  spires = 0.15,
}) {
  const rand = rng(seed);
  let out = '';
  let x = x0;
  while (x < x1) {
    const bw = minW + rand() * (maxW - minW);
    const bh = minH + Math.pow(rand(), 1.4) * (maxH - minH);
    const top = baseY - bh;
    out += `<rect x="${r1(x)}" y="${r1(top)}" width="${r1(bw)}" height="${r1(bh + 2)}" fill="${color}"/>`;
    const r = rand();
    if (r < spires) {
      out += `<rect x="${r1(x + bw / 2 - 1.5)}" y="${r1(top - bh * 0.18)}" width="3" height="${r1(bh * 0.18)}" fill="${color}"/>`;
    } else if (r < spires + 0.25) {
      out += `<rect x="${r1(x + bw * 0.2)}" y="${r1(top - bh * 0.07)}" width="${r1(bw * 0.6)}" height="${r1(bh * 0.07 + 1)}" fill="${color}"/>`;
    }
    if (windowColor) {
      const cols = Math.max(1, Math.floor(bw / 9));
      const rows = Math.max(1, Math.floor(bh / 13));
      for (let c = 0; c < cols; c += 1) {
        for (let rr = 1; rr < rows; rr += 1) {
          if (rand() < windowChance) {
            out += `<rect x="${r1(x + 4 + c * ((bw - 8) / cols))}" y="${r1(top + rr * 13)}" width="3" height="5" fill="${windowColor}" opacity="${r1(0.45 + rand() * 0.5)}"/>`;
          }
        }
      }
    }
    x += bw + gap * rand();
  }
  return out;
}

/** Broad, umbrella-shaped canopy (rain tree). */
function rainTree({ x, y, w, h, color, seed }) {
  const rand = rng(seed);
  let out = `<path d="M${r1(x - w * 0.025)} ${r1(y)}L${r1(x - w * 0.012)} ${r1(y - h * 0.62)}L${r1(x + w * 0.012)} ${r1(y - h * 0.62)}L${r1(x + w * 0.025)} ${r1(y)}Z" fill="${color}"/>`;
  out += `<path d="M${r1(x)} ${r1(y - h * 0.45)}L${r1(x - w * 0.22)} ${r1(y - h * 0.72)}M${r1(x)} ${r1(y - h * 0.5)}L${r1(x + w * 0.24)} ${r1(y - h * 0.74)}" stroke="${color}" stroke-width="${r1(w * 0.016)}" stroke-linecap="round"/>`;
  const n = 9;
  for (let i = 0; i < n; i += 1) {
    const t = i / (n - 1);
    const cx = x + (t - 0.5) * w * 0.86;
    const arch = Math.sin(t * Math.PI);
    const cy = y - h * (0.68 + arch * 0.2) + (rand() - 0.5) * h * 0.05;
    out += `<ellipse cx="${r1(cx)}" cy="${r1(cy)}" rx="${r1(w * (0.1 + rand() * 0.05))}" ry="${r1(h * (0.11 + rand() * 0.05))}" fill="${color}"/>`;
  }
  out += `<ellipse cx="${r1(x)}" cy="${r1(y - h * 0.86)}" rx="${r1(w * 0.3)}" ry="${r1(h * 0.13)}" fill="${color}"/>`;
  return out;
}

/** Pointed (Indo-Islamic) arch opening. */
function pointedArch(cx, bottom, wv, hv, color) {
  const shoulder = bottom - hv * 0.62;
  return `<path d="M${r1(cx - wv / 2)} ${r1(bottom)}V${r1(shoulder)}Q${r1(cx - wv / 2)} ${r1(bottom - hv * 0.9)} ${r1(cx)} ${r1(bottom - hv)}Q${r1(cx + wv / 2)} ${r1(bottom - hv * 0.9)} ${r1(cx + wv / 2)} ${r1(shoulder)}V${r1(bottom)}Z" fill="${color}"/>`;
}

function lamp(x, y, hv, color, glow) {
  return (
    `<rect x="${r1(x - 2)}" y="${r1(y - hv)}" width="4" height="${r1(hv)}" fill="${color}"/>` +
    `<circle cx="${r1(x)}" cy="${r1(y - hv - 6)}" r="22" fill="url(#lampglow)"/>` +
    `<circle cx="${r1(x)}" cy="${r1(y - hv - 6)}" r="6" fill="${glow}"/>`
  );
}
const lampGlowDef = radial('lampglow', [
  [0, '#ffd9a8', 0.75],
  [1, '#ffd9a8', 0],
]);

function bengaluru() {
  const [w, h] = [1600, 1200];
  let defs = linear('sky', [
    [0, '#5a5f9f'],
    [0.5, '#a796c0'],
    [0.85, '#efc0ad'],
    [1, '#f6d3bd'],
  ]);
  const s = sun({
    id: 's',
    cx: w * 0.3,
    cy: h * 0.5,
    r: 56,
    core: '#fff0e2',
    glow: '#ffd2b6',
    glowR: 5,
  });
  defs += s.defs + lampGlowDef;
  let body = `<rect width="${w}" height="${h}" fill="url(#sky)"/>` + s.body;
  body += skyline({
    seed: 201,
    x0: -20,
    x1: w + 20,
    baseY: h * 0.72,
    minH: 120,
    maxH: 300,
    minW: 50,
    maxW: 110,
    color: '#8f88bd',
    windowColor: null,
  });
  const hz = haze({ id: 'hz', w, y: h * 0.66, height: 160, color: '#f6d3bd', opacity: 0.35 });
  defs += hz.defs;
  body += hz.body;
  body += skyline({
    seed: 202,
    x0: w * 0.36,
    x1: w * 0.96,
    baseY: h * 0.76,
    minH: 220,
    maxH: 520,
    minW: 70,
    maxW: 140,
    color: C.indigo2,
    windowChance: 0.22,
    gap: 18,
    spires: 0.25,
  });
  body += `<rect y="${r1(h * 0.75)}" width="${w}" height="${r1(h * 0.25)}" fill="${C.indigo3}"/>`;
  body += rainTree({ x: w * 0.12, y: h * 1.02, w: 700, h: 560, color: C.navy, seed: 203 });
  body += rainTree({ x: w * 0.55, y: h * 1.04, w: 520, h: 330, color: C.navy2, seed: 204 });
  body += rainTree({ x: w * 0.95, y: h * 1.02, w: 640, h: 480, color: C.navy, seed: 205 });
  body +=
    lamp(w * 0.38, h * 0.98, 120, C.navy, '#ffe2b8') +
    lamp(w * 0.74, h * 0.99, 110, C.navy, '#ffe2b8');
  body += birds({ seed: 206, x: w * 0.6, y: h * 0.2, count: 4, color: C.indigo3, scale: 1.2 });
  return write('destination-bengaluru.svg', svg(w, h, body, defs));
}

function hyderabad() {
  const [w, h] = [1600, 1200];
  let defs =
    linear('sky', [
      [0, '#3b3f7f'],
      [0.45, '#8a6f9f'],
      [0.8, '#dc9f9c'],
      [1, '#f1bfa3'],
    ]) +
    linear('stone', [
      [0, '#f0c7b4'],
      [1, '#c98f92'],
    ]) +
    lampGlowDef;
  let body =
    `<rect width="${w}" height="${h}" fill="url(#sky)"/>` +
    stars({ w, h, seed: 211, count: 60, maxY: h * 0.35 });
  const mo = sun({
    id: 'm',
    cx: w * 0.82,
    cy: h * 0.2,
    r: 34,
    core: '#fdf1e6',
    glow: '#ffe5d0',
    glowR: 4,
  });
  defs += mo.defs;
  body += mo.body;
  // Old-city roofline behind
  body += skyline({
    seed: 212,
    x0: -10,
    x1: w + 10,
    baseY: h * 0.78,
    minH: 60,
    maxH: 160,
    minW: 60,
    maxW: 130,
    color: '#7b6496',
    windowColor: C.gold,
    windowChance: 0.08,
    gap: 6,
    spires: 0,
  });
  body +=
    dome(w * 0.12, h * 0.62, 110, 80, '#7b6496') + minaret(w * 0.05, h * 0.66, 170, 12, '#7b6496');
  body += dome(w * 0.9, h * 0.64, 90, 64, '#7b6496');
  // Gateway monument: square body, great arch, four corner minarets (inspired by, not a replica)
  const cx = w * 0.5;
  const base = h * 0.82;
  const bw = 520;
  const bh = 330;
  const left = cx - bw / 2;
  body += `<rect x="${r1(left)}" y="${r1(base - bh)}" width="${bw}" height="${bh}" fill="url(#stone)"/>`;
  body += `<rect x="${r1(left - 10)}" y="${r1(base - bh - 14)}" width="${bw + 20}" height="16" fill="#b9788a"/>`;
  // upper gallery of small arches
  const gy = base - bh - 14;
  body += `<rect x="${r1(left + 30)}" y="${r1(gy - 90)}" width="${bw - 60}" height="92" fill="url(#stone)"/>`;
  for (let i = 0; i < 9; i += 1) {
    body += pointedArch(left + 60 + i * ((bw - 120) / 8), gy - 12, 26, 58, '#8b5a7a');
  }
  body += `<rect x="${r1(left + 24)}" y="${r1(gy - 100)}" width="${bw - 48}" height="12" fill="#b9788a"/>`;
  body += pointedArch(cx, base, 230, 280, '#5c3f6e');
  body += pointedArch(cx, base, 190, 236, '#3a2d5c');
  // decorative band of small niches either side of the arch
  for (const side of [-1, 1]) {
    for (let r = 0; r < 3; r += 1) {
      body += pointedArch(cx + side * 190, base - 30 - r * 92, 40, 66, '#a36a83');
    }
  }
  // four minarets
  for (const mx of [left - 6, left + bw + 6]) {
    const mh = bh + 300;
    body += `<rect x="${r1(mx - 22)}" y="${r1(base - mh)}" width="44" height="${mh}" fill="url(#stone)"/>`;
    for (let b = 0; b < 3; b += 1) {
      const by = base - bh - 40 - b * 80;
      body += `<rect x="${r1(mx - 34)}" y="${r1(by)}" width="68" height="10" fill="#b9788a"/>`;
    }
    body += dome(mx, base - mh, 54, 50, '#e7b6a8');
  }
  // foreground street: awnings + lamps + crowd silhouettes
  body += `<rect y="${r1(base)}" width="${w}" height="${r1(h - base)}" fill="${C.navy}"/>`;
  const rand = rng(213);
  for (let i = 0; i < 9; i += 1) {
    const ax = i < 4 ? i * 90 - 20 : w - (i - 3) * 90 + 10;
    body += `<path d="M${r1(ax)} ${r1(base + 10)}L${r1(ax + 80)} ${r1(base + 10)}L${r1(ax + 70)} ${r1(base + 46)}L${r1(ax + 10)} ${r1(base + 46)}Z" fill="${mix(C.navy, '#c98f92', 0.25 + rand() * 0.25)}"/>`;
  }
  body +=
    lamp(w * 0.24, base + 40, 150, C.navy, '#ffe2b8') +
    lamp(w * 0.76, base + 40, 150, C.navy, '#ffe2b8');
  for (let i = 0; i < 26; i += 1) {
    const px = rand() * w;
    const ph = 50 + rand() * 40;
    body += `<ellipse cx="${r1(px)}" cy="${r1(h - ph)}" rx="9" ry="10" fill="${C.navy2}"/><rect x="${r1(px - 11)}" y="${r1(h - ph + 8)}" width="22" height="${r1(ph)}" rx="9" fill="${C.navy2}"/>`;
  }
  return write('destination-hyderabad.svg', svg(w, h, body, defs));
}

function mumbai() {
  const [w, h] = [1600, 1200];
  let defs =
    linear('sky', [
      [0, '#0f1230'],
      [0.55, '#2c3466'],
      [0.85, '#6a5f9e'],
      [1, '#a77ea0'],
    ]) +
    linear('sea', [
      [0, '#3a3f7a'],
      [1, '#141833'],
    ]) +
    radial('lightglow', [
      [0, '#ffd8a0', 0.8],
      [1, '#ffd8a0', 0],
    ]);
  let body =
    `<rect width="${w}" height="${h}" fill="url(#sky)"/>` +
    stars({ w, h, seed: 221, count: 120, maxY: h * 0.45 });
  const mo = sun({
    id: 'm',
    cx: w * 0.2,
    cy: h * 0.18,
    r: 26,
    core: '#f4f5ff',
    glow: '#dde1f7',
    glowR: 4,
  });
  defs += mo.defs;
  body += mo.body;
  // Promenade curve: quadratic bezier from near-left to far-right.
  const P0 = [-80, h * 0.92];
  const P1 = [w * 0.45, h * 0.6];
  const P2 = [w * 1.08, h * 0.56];
  const at = (t) => [
    (1 - t) ** 2 * P0[0] + 2 * (1 - t) * t * P1[0] + t ** 2 * P2[0],
    (1 - t) ** 2 * P0[1] + 2 * (1 - t) * t * P1[1] + t ** 2 * P2[1],
  ];
  // Land + towers behind the curve
  const landTop = [];
  for (let t = 0; t <= 1.0001; t += 0.02) landTop.push(at(t));
  // towers along the curve, larger when near
  const rand = rng(222);
  let towers = '';
  for (let t = 0.98; t >= 0.0; t -= 0.035) {
    const [x, y] = at(t);
    const near = 1 - t;
    const scale = 0.35 + near * 1.3;
    const bw = (40 + rand() * 50) * scale;
    const bh = (90 + Math.pow(rand(), 1.3) * 260) * scale;
    const tone = mix('#6b6aa6', C.navy, near * 0.75);
    towers += `<rect x="${r1(x - bw / 2)}" y="${r1(y - bh - 8 * scale)}" width="${r1(bw)}" height="${r1(bh + 40)}" fill="${tone}"/>`;
    const cols = Math.max(1, Math.floor(bw / (9 * scale)));
    const rows = Math.max(1, Math.floor(bh / (14 * scale)));
    for (let c = 0; c < cols; c += 1) {
      for (let r = 1; r < rows; r += 1) {
        if (rand() < 0.2) {
          towers += `<rect x="${r1(x - bw / 2 + 3 * scale + c * ((bw - 6 * scale) / cols))}" y="${r1(y - bh - 8 * scale + r * 14 * scale)}" width="${r1(3 * scale)}" height="${r1(5 * scale)}" fill="${C.gold}" opacity="${r1(0.5 + rand() * 0.5)}"/>`;
        }
      }
    }
  }
  body += towers;
  // ground band following the curve (promenade wall)
  const wall = landTop.map(([x, y]) => `${r1(x)} ${r1(y)}`);
  body += `<path d="M${wall.join('L')}L${r1(w + 100)} ${r1(h * 0.5)}L${r1(w + 100)} ${r1(h * 0.62)}" fill="none"/>`;
  // Sea: everything below the curve
  const below = landTop.map(([x, y]) => `${r1(x)} ${r1(y + 2)}`);
  body += `<path d="M${below.join('L')}L${r1(w + 100)} ${h}L-100 ${h}Z" fill="url(#sea)"/>`;
  // promenade road edge
  body += `<path d="M${landTop.map(([x, y]) => `${r1(x)} ${r1(y)}`).join('L')}" fill="none" stroke="#2a2f5c" stroke-width="10"/>`;
  // The necklace of lights + reflections
  let lights = '';
  for (let t = 0.0; t <= 1.0001; t += 0.012) {
    const [x, y] = at(t);
    const near = 1 - t;
    const r = 1.6 + near * 5.5;
    lights += `<circle cx="${r1(x)}" cy="${r1(y - 4 - near * 10)}" r="${r1(r * 3.4)}" fill="url(#lightglow)"/>`;
    lights += `<circle cx="${r1(x)}" cy="${r1(y - 4 - near * 10)}" r="${r1(r)}" fill="#ffe6bf"/>`;
    if (rand() < 0.75) {
      lights += `<rect x="${r1(x - r * 0.6)}" y="${r1(y + 8)}" width="${r1(r * 1.2)}" height="${r1(30 + near * 90)}" fill="#ffd8a0" opacity="${r1(0.12 + near * 0.18)}"/>`;
    }
  }
  body += lights;
  return write('destination-mumbai.svg', svg(w, h, body, defs));
}

function delhi() {
  const [w, h] = [1600, 1200];
  const ground = h * 0.66;
  let defs =
    linear('sky', [
      [0, '#8f95cc'],
      [0.55, '#dcc3cf'],
      [1, '#f7d8c4'],
    ]) +
    linear('sand', [
      [0, '#e6b3a4'],
      [1, '#c98a8e'],
    ]) +
    linear('lawn', [
      [0, '#6f8f86'],
      [1, '#2f5257'],
    ]) +
    linear('water', [
      [0, '#cdbfdc'],
      [1, '#8d98d4'],
    ]);
  const s = sun({
    id: 's',
    cx: w * 0.78,
    cy: h * 0.22,
    r: 46,
    core: '#fff3e8',
    glow: '#ffe0cc',
    glowR: 5,
  });
  defs += s.defs;
  let body = `<rect width="${w}" height="${h}" fill="url(#sky)"/>` + s.body;
  const cx = w * 0.5;
  const monument = () => {
    let m = '';
    // plinth with arch row
    const pw = 900;
    const ph = 90;
    m += `<rect x="${r1(cx - pw / 2)}" y="${r1(ground - ph)}" width="${pw}" height="${ph}" fill="url(#sand)"/>`;
    for (let i = 0; i < 15; i += 1) {
      m += pointedArch(cx - pw / 2 + 30 + i * ((pw - 60) / 14), ground - 10, 34, 62, '#9c6577');
    }
    // main block
    const bw = 520;
    const bh = 210;
    const top = ground - ph - bh;
    m += `<rect x="${r1(cx - bw / 2)}" y="${r1(top)}" width="${bw}" height="${bh}" fill="url(#sand)"/>`;
    m += `<rect x="${r1(cx - 110)}" y="${r1(top - 10)}" width="220" height="${bh + 10}" fill="#e9bdae"/>`;
    m += pointedArch(cx, ground - ph, 150, 190, '#8a566f');
    m += pointedArch(cx, ground - ph, 110, 150, '#6b4766');
    for (const side of [-1, 1]) {
      m += pointedArch(cx + side * 180, ground - ph - 20, 60, 100, '#9c6577');
      m += pointedArch(cx + side * 180, top + 90, 46, 66, '#9c6577');
    }
    // drum + dome
    m += `<rect x="${r1(cx - 120)}" y="${r1(top - 60)}" width="240" height="62" fill="#ead2cc"/>`;
    m += dome(cx, top - 58, 300, 230, '#f4e9e7');
    m += chhatri(cx - 220, top, 50, '#e9bdae') + chhatri(cx + 220, top, 50, '#e9bdae');
    return m;
  };
  body += monument();
  // gardens + water channel
  body += `<rect y="${r1(ground)}" width="${w}" height="${r1(h - ground)}" fill="url(#lawn)"/>`;
  const channel = `M${r1(cx - 70)} ${r1(ground)}L${r1(cx + 70)} ${r1(ground)}L${r1(cx + 330)} ${h}L${r1(cx - 330)} ${h}Z`;
  defs += `<clipPath id="ch"><path d="${channel}"/></clipPath>`;
  body += `<path d="${channel}" fill="url(#water)"/>`;
  body += `<g clip-path="url(#ch)" opacity="0.35"><g transform="translate(0 ${r1(ground * 2)}) scale(1 -1)">${monument()}</g></g>`;
  body += `<path d="M${r1(cx - 76)} ${r1(ground)}L${r1(cx - 344)} ${h}M${r1(cx + 76)} ${r1(ground)}L${r1(cx + 344)} ${h}" stroke="#f1dcd3" stroke-width="10"/>`;
  // cypress rows in perspective
  for (let i = 0; i < 7; i += 1) {
    const t = i / 6;
    const y = lerp(ground + 20, h * 1.02, Math.pow(t, 1.3));
    const sc = lerp(0.35, 1.6, Math.pow(t, 1.3));
    for (const side of [-1, 1]) {
      const x = cx + side * lerp(160, 620, Math.pow(t, 1.1));
      body += `<ellipse cx="${r1(x)}" cy="${r1(y - 70 * sc)}" rx="${r1(20 * sc)}" ry="${r1(75 * sc)}" fill="${C.navy}"/>`;
    }
  }
  body += birds({ seed: 231, x: w * 0.3, y: h * 0.16, count: 5, color: C.indigo3, scale: 1.2 });
  return write('destination-delhi.svg', svg(w, h, body, defs));
}

function bali() {
  const [w, h] = [1600, 1200];
  let defs = linear('sky', [
    [0, '#8fb0c0'],
    [0.55, '#dfe6d9'],
    [1, '#f7e6d3'],
  ]);
  const s = sun({
    id: 's',
    cx: w * 0.72,
    cy: h * 0.2,
    r: 48,
    core: '#fffaf0',
    glow: '#fff2dc',
    glowR: 6,
  });
  defs += s.defs;
  let body = `<rect width="${w}" height="${h}" fill="url(#sky)"/>` + s.body;
  // volcano
  const vx = w * 0.58;
  const vy = h * 0.2;
  defs += linear('volc', [
    [0, '#a5a9cf'],
    [1, '#c9cde0'],
  ]);
  body += `<path d="M${r1(vx - 640)} ${r1(h * 0.56)}Q${r1(vx - 260)} ${r1(h * 0.42)} ${r1(vx - 60)} ${r1(vy)}L${r1(vx + 60)} ${r1(vy)}Q${r1(vx + 260)} ${r1(h * 0.42)} ${r1(vx + 700)} ${r1(h * 0.56)}Z" fill="url(#volc)"/>`;
  const hz = haze({ id: 'hz', w, y: h * 0.48, height: 180, color: '#ffffff', opacity: 0.5 });
  defs += hz.defs;
  body += hz.body;
  // terraces back to front
  const greens = [
    '#b9cfae',
    '#a6c4a0',
    '#8fb59a',
    '#7ba68f',
    '#679683',
    '#548677',
    '#43766d',
    '#346561',
    '#2a5357',
  ];
  const n = greens.length;
  for (let i = 0; i < n; i += 1) {
    const t = i / (n - 1);
    const base = lerp(h * 0.5, h * 1.02, Math.pow(t, 0.85));
    const amp = lerp(30, 120, t);
    const r = ridge({
      w,
      h,
      seed: 241 + i,
      baseY: base,
      amp,
      scale: lerp(520, 300, t),
      octaves: 2,
      peaks: 0.8,
      step: 8,
    });
    body += `<path d="${r.d}" fill="${greens[i]}"/>`;
    body += `<path d="${r.d.split('L' + (w + 8) + ' ' + h)[0]}" fill="none" stroke="${mix(greens[i], '#ffffff', 0.35)}" stroke-width="${r1(lerp(2, 5, t))}" opacity="0.8"/>`;
  }
  // palms on the right
  body += palm({
    x: w * 0.93,
    y: h * 1.02,
    height: h * 0.56,
    lean: -0.22,
    color: '#1f3036',
    seed: 245,
    frondScale: 0.8,
  });
  body += palm({
    x: w * 1.0,
    y: h * 1.04,
    height: h * 0.44,
    lean: -0.32,
    color: '#24393e',
    seed: 246,
    frondScale: 0.75,
  });
  // split gate (candi bentar), left foreground
  const gx = w * 0.2;
  const gb = h * 1.01;
  const half = (dir) => {
    let d = '';
    const steps = 7;
    const gw = 170;
    const gh = 640;
    for (let k = 0; k < steps; k += 1) {
      const y0 = gb - (gh * k) / steps;
      const y1v = gb - (gh * (k + 1)) / steps;
      const wv = gw * (1 - k * 0.11);
      const inner = gx + dir * 26;
      const outer = inner + dir * wv;
      d += `M${r1(inner)} ${r1(y0)}L${r1(outer)} ${r1(y0)}L${r1(outer)} ${r1(y1v + 10)}L${r1(outer - dir * 10)} ${r1(y1v)}L${r1(inner)} ${r1(y1v)}Z`;
    }
    return `<path d="${d}" fill="${C.navy}"/>`;
  };
  body += half(-1) + half(1);
  body += birds({ seed: 247, x: w * 0.42, y: h * 0.14, count: 3, color: C.indigo3, scale: 1.1 });
  return write('destination-bali.svg', svg(w, h, body, defs));
}

function pagodaRoof(cx, y, wv, hv, color) {
  return `<path d="M${r1(cx - wv / 2)} ${r1(y - hv * 0.4)}Q${r1(cx - wv * 0.36)} ${r1(y + hv * 0.02)} ${r1(cx - wv * 0.28)} ${r1(y)}L${r1(cx + wv * 0.28)} ${r1(y)}Q${r1(cx + wv * 0.36)} ${r1(y + hv * 0.02)} ${r1(cx + wv / 2)} ${r1(y - hv * 0.4)}Q${r1(cx + wv * 0.28)} ${r1(y - hv * 0.5)} ${r1(cx + wv * 0.17)} ${r1(y - hv)}L${r1(cx - wv * 0.17)} ${r1(y - hv)}Q${r1(cx - wv * 0.28)} ${r1(y - hv * 0.5)} ${r1(cx - wv / 2)} ${r1(y - hv * 0.4)}Z" fill="${color}"/>`;
}

function maple({ x, y, r, color, seed }) {
  const rand = rng(seed);
  let out = `<rect x="${r1(x - r * 0.07)}" y="${r1(y - r * 0.9)}" width="${r1(r * 0.14)}" height="${r1(r * 0.9)}" fill="${C.navy}"/>`;
  for (let i = 0; i < 7; i += 1) {
    const a = (i / 7) * Math.PI * 2;
    out += `<circle cx="${r1(x + Math.cos(a) * r * 0.55)}" cy="${r1(y - r * 1.25 + Math.sin(a) * r * 0.4)}" r="${r1(r * (0.42 + rand() * 0.18))}" fill="${color}"/>`;
  }
  out += `<circle cx="${r1(x)}" cy="${r1(y - r * 1.3)}" r="${r1(r * 0.6)}" fill="${color}"/>`;
  return out;
}

function kyoto() {
  const [w, h] = [1600, 1200];
  let defs = linear('sky', [
    [0, '#6f6aa8'],
    [0.5, '#c79aa8'],
    [0.85, '#f1c3ad'],
    [1, '#f7d8c4'],
  ]);
  const s = sun({
    id: 's',
    cx: w * 0.7,
    cy: h * 0.42,
    r: 60,
    core: '#fff0e2',
    glow: '#ffd2b6',
    glowR: 5,
  });
  defs += s.defs + lampGlowDef;
  let body = `<rect width="${w}" height="${h}" fill="url(#sky)"/>` + s.body;
  const hills = [
    { base: h * 0.62, amp: h * 0.22, color: '#a28fb9', scale: 600 },
    { base: h * 0.72, amp: h * 0.2, color: '#806fa3', scale: 480 },
  ];
  hills.forEach((l, i) => {
    const r = ridge({
      w,
      h,
      seed: 251 + i,
      baseY: l.base,
      amp: l.amp,
      scale: l.scale,
      octaves: 3,
      peaks: 0.9,
    });
    body += `<path d="${r.d}" fill="${l.color}"/>`;
    const m = haze({
      id: `km${i}`,
      w,
      y: l.base - 10,
      height: 140,
      color: '#f7d8c4',
      opacity: 0.3,
    });
    defs += m.defs;
    body += m.body;
  });
  // pagoda
  const px = w * 0.36;
  const pb = h * 0.86;
  const col = C.navy;
  let y = pb;
  const tiers = 5;
  for (let t = 0; t < tiers; t += 1) {
    const bodyW = 150 - t * 18;
    const bodyH = t === 0 ? 70 : 46;
    body += `<rect x="${r1(px - bodyW / 2)}" y="${r1(y - bodyH)}" width="${r1(bodyW)}" height="${r1(bodyH)}" fill="${C.navy2}"/>`;
    for (let k = 0; k < 3; k += 1) {
      body += `<rect x="${r1(px - bodyW / 2 + 12 + k * ((bodyW - 24) / 3))}" y="${r1(y - bodyH + 10)}" width="${r1((bodyW - 24) / 3 - 8)}" height="${r1(bodyH - 18)}" fill="#3a2d5c"/>`;
    }
    y -= bodyH;
    const roofW = 330 - t * 34;
    body += pagodaRoof(px, y + 6, roofW, 58, col);
    y -= 52;
  }
  // spire with rings
  body += `<rect x="${r1(px - 4)}" y="${r1(y - 150)}" width="8" height="160" fill="${col}"/>`;
  for (let k = 0; k < 7; k += 1) {
    body += `<rect x="${r1(px - 14)}" y="${r1(y - 140 + k * 15)}" width="28" height="5" rx="2" fill="${col}"/>`;
  }
  body += `<rect x="${r1(px - 110)}" y="${r1(pb - 4)}" width="220" height="40" fill="${col}"/>`;
  // ground + maples
  const g = ridge({
    w,
    h,
    seed: 255,
    baseY: h * 1.02,
    amp: h * 0.16,
    scale: 700,
    octaves: 2,
    peaks: 0.9,
  });
  body += `<path d="${g.d}" fill="${C.navy}"/>`;
  const reds = ['#c76b7e', '#a8506a', '#d98a8f', '#b75f74'];
  const rand = rng(256);
  for (let i = 0; i < 10; i += 1) {
    const x = i < 5 ? rand() * w * 0.22 + (i % 2 ? w * 0.48 : 0) : w * 0.6 + rand() * w * 0.42;
    const yy = h * (0.9 + rand() * 0.12);
    body += maple({ x, y: yy, r: 70 + rand() * 70, color: reds[i % reds.length], seed: 257 + i });
  }
  body += lamp(w * 0.56, h * 0.97, 90, C.navy, '#ffe2b8');
  body += birds({ seed: 258, x: w * 0.72, y: h * 0.18, count: 4, color: '#5b4f8f', scale: 1.2 });
  return write('destination-kyoto.svg', svg(w, h, body, defs));
}

function singapore() {
  const [w, h] = [1600, 1200];
  const water = h * 0.66;
  let defs =
    linear('sky', [
      [0, '#0f1230'],
      [0.6, '#2c3466'],
      [1, '#5b5f9e'],
    ]) +
    linear('bay', [
      [0, '#3a4087'],
      [1, '#12162e'],
    ]);
  let body =
    `<rect width="${w}" height="${h}" fill="url(#sky)"/>` +
    stars({ w, h, seed: 261, count: 140, maxY: h * 0.5 });
  body += skyline({
    seed: 262,
    x0: -10,
    x1: w + 10,
    baseY: water,
    minH: 80,
    maxH: 220,
    minW: 40,
    maxW: 90,
    color: '#4a4f8a',
    windowChance: 0.12,
    gap: 6,
  });
  body += skyline({
    seed: 263,
    x0: w * 0.18,
    x1: w * 0.8,
    baseY: water,
    minH: 200,
    maxH: 470,
    minW: 60,
    maxW: 120,
    color: '#2b3163',
    windowChance: 0.24,
    gap: 12,
    spires: 0.3,
  });
  // observation wheel
  const wx = w * 0.86;
  const wy = water - 190;
  const wr = 150;
  let wheel = `<circle cx="${r1(wx)}" cy="${r1(wy)}" r="${wr}" fill="none" stroke="#8d98d4" stroke-width="5"/>`;
  for (let i = 0; i < 16; i += 1) {
    const a = (i / 16) * Math.PI * 2;
    wheel += `<line x1="${r1(wx)}" y1="${r1(wy)}" x2="${r1(wx + Math.cos(a) * wr)}" y2="${r1(wy + Math.sin(a) * wr)}" stroke="#8d98d4" stroke-width="1.5" opacity="0.7"/>`;
    wheel += `<circle cx="${r1(wx + Math.cos(a) * wr)}" cy="${r1(wy + Math.sin(a) * wr)}" r="7" fill="${C.gold}"/>`;
  }
  wheel += `<path d="M${r1(wx - 70)} ${r1(water)}L${r1(wx)} ${r1(wy)}L${r1(wx + 70)} ${r1(water)}" fill="none" stroke="#8d98d4" stroke-width="7"/>`;
  body += wheel;
  body += `<rect y="${r1(water)}" width="${w}" height="${r1(h - water)}" fill="url(#bay)"/>`;
  // reflections of lit towers
  const rand = rng(264);
  for (let i = 0; i < 70; i += 1) {
    const x = rand() * w;
    body += `<rect x="${r1(x)}" y="${r1(water + 6 + rand() * 150)}" width="${r1(2 + rand() * 4)}" height="${r1(10 + rand() * 40)}" fill="${C.gold}" opacity="${r1(0.15 + rand() * 0.35)}"/>`;
  }
  body += `<rect y="${r1(water - 4)}" width="${w}" height="8" fill="#1b2046"/>`;
  // foreground tropical trees
  body += palm({
    x: w * 0.03,
    y: h * 1.03,
    height: h * 0.52,
    lean: 0.22,
    color: '#0b0d20',
    seed: 265,
    frondScale: 0.8,
  });
  body += rainTree({ x: w * 0.2, y: h * 1.05, w: 520, h: 300, color: '#0b0d20', seed: 266 });
  body += rainTree({ x: w * 0.98, y: h * 1.04, w: 600, h: 380, color: '#0b0d20', seed: 267 });
  return write('destination-singapore.svg', svg(w, h, body, defs));
}

function dubai() {
  const [w, h] = [1600, 1200];
  const horizon = h * 0.62;
  let defs = linear('sky', [
    [0, '#6e6ba9'],
    [0.45, '#c996a6'],
    [0.8, '#f2b796'],
    [1, '#f8d2b4'],
  ]);
  const s = sun({
    id: 's',
    cx: w * 0.36,
    cy: horizon - 70,
    r: 72,
    core: '#fff0e0',
    glow: '#ffc9a3',
    glowR: 5,
  });
  defs += s.defs;
  let body = `<rect width="${w}" height="${h}" fill="url(#sky)"/>` + s.body;
  // skyline: one tall stepped needle + others (generic)
  const sky = '#9b85ad';
  body += skyline({
    seed: 271,
    x0: w * 0.42,
    x1: w * 0.98,
    baseY: horizon,
    minH: 60,
    maxH: 230,
    minW: 26,
    maxW: 60,
    color: sky,
    windowColor: null,
    gap: 14,
    spires: 0.35,
  });
  // Tallest tower: a plain slab with a slim crown (generic, not a landmark replica).
  const nx = w * 0.62;
  let needle = `<rect x="${r1(nx - 34)}" y="${r1(horizon - 430)}" width="68" height="431" fill="${sky}"/>`;
  needle += `<path d="M${r1(nx - 34)} ${r1(horizon - 430)}L${r1(nx + 34)} ${r1(horizon - 470)}L${r1(nx + 34)} ${r1(horizon - 430)}Z" fill="${sky}"/>`;
  needle += `<rect x="${r1(nx + 14)}" y="${r1(horizon - 540)}" width="4" height="80" fill="${sky}"/>`;
  needle += `<rect x="${r1(nx - 90)}" y="${r1(horizon - 300)}" width="46" height="301" fill="${sky}"/>`;
  body += needle;
  body += skyline({
    seed: 272,
    x0: w * 0.66,
    x1: w * 0.82,
    baseY: horizon,
    minH: 120,
    maxH: 260,
    minW: 24,
    maxW: 44,
    color: sky,
    windowColor: null,
    gap: 10,
    spires: 0.5,
  });
  const hz = haze({ id: 'hz', w, y: horizon - 10, height: 120, color: '#f8d2b4', opacity: 0.55 });
  defs += hz.defs;
  body += hz.body;
  // dunes
  const dunes = [
    { base: horizon + 80, amp: 90, c0: '#efc3a4', c1: '#d9a08b', scale: 700 },
    { base: horizon + 250, amp: 190, c0: '#e4a283', c1: '#b9727a', scale: 560 },
    { base: h * 1.02, amp: 260, c0: '#c97f78', c1: '#6c4a86', scale: 720 },
  ];
  dunes.forEach((l, i) => {
    const r = ridge({
      w,
      h,
      seed: 273 + i,
      baseY: l.base,
      amp: l.amp,
      scale: l.scale,
      octaves: 2,
      peaks: 0.85,
      step: 8,
    });
    defs += linear(
      `d${i}`,
      [
        [0, l.c0],
        [1, l.c1],
      ],
      { units: 'userSpaceOnUse', y1: r.minY, y2: l.base },
    );
    body += `<path d="${r.d}" fill="url(#d${i})"/>`;
    body += `<path d="${r.d.split('L' + (w + 8) + ' ' + h)[0]}" fill="none" stroke="#fbe1cc" stroke-width="${2 + i}" opacity="0.55"/>`;
  });
  body += birds({ seed: 276, x: w * 0.25, y: h * 0.22, count: 3, color: '#6b5a8f', scale: 1.2 });
  return write('destination-dubai.svg', svg(w, h, body, defs));
}

function natureWellness() {
  const [w, h] = [1200, 1500];
  let defs = linear('sky', [
    [0, '#9fb9bb'],
    [0.5, '#dfe7dc'],
    [1, '#f4ecdf'],
  ]);
  const s = sun({
    id: 's',
    cx: w * 0.3,
    cy: h * 0.16,
    r: 50,
    core: '#fffaf0',
    glow: '#fff2dc',
    glowR: 6,
  });
  defs += s.defs;
  let body = `<rect width="${w}" height="${h}" fill="url(#sky)"/>` + s.body;
  const layers = [
    { base: h * 0.45, amp: h * 0.2, color: '#a9c2b8', scale: 380, peaks: 1.4 },
    { base: h * 0.58, amp: h * 0.24, color: '#7fa29a', scale: 320, peaks: 1.3 },
  ];
  layers.forEach((l, i) => {
    const r = ridge({
      w,
      h,
      seed: 281 + i,
      baseY: l.base,
      amp: l.amp,
      scale: l.scale,
      peaks: l.peaks,
    });
    body += `<path d="${r.d}" fill="${l.color}"/>`;
    const n = noise1D(281 + i);
    const baseFn = (x) =>
      l.base -
      l.amp * Math.pow(Math.min(1, Math.max(0, (n(x / l.scale, 4) - 0.12) / 0.76)), l.peaks);
    body += pineRow({
      seed: 290 + i,
      w,
      baseFn,
      count: Math.round(w / 22),
      minH: 30 + i * 14,
      maxH: 60 + i * 20,
      color: mix(l.color, '#2f5257', 0.35),
    });
    const m = haze({ id: `nm${i}`, w, y: l.base, height: 160, color: '#ffffff', opacity: 0.4 });
    defs += m.defs;
    body += m.body;
  });
  // cliff with waterfall
  const cliff = `M${r1(w * 0.48)} ${r1(h * 0.42)}L${r1(w * 1.05)} ${r1(h * 0.38)}L${r1(w * 1.05)} ${h}L${r1(w * 0.42)} ${h}Q${r1(w * 0.5)} ${r1(h * 0.7)} ${r1(w * 0.48)} ${r1(h * 0.42)}Z`;
  defs += linear(
    'cliff',
    [
      [0, '#5c8580'],
      [0.5, '#3c5f66'],
      [1, '#2a454c'],
    ],
    { x2: 1, y2: 0.4 },
  );
  body += `<path d="${cliff}" fill="url(#cliff)"/>`;
  const ledges = rng(282);
  for (let i = 0; i < 9; i += 1) {
    const ly = h * (0.46 + i * 0.045);
    const lx = w * (0.52 + ledges() * 0.06) + (i % 2 ? w * 0.22 : 0);
    body += `<path d="M${r1(lx)} ${r1(ly)}h${r1(60 + ledges() * 120)}" stroke="#2a454c" stroke-width="4" stroke-linecap="round" opacity="0.6"/>`;
  }
  defs += linear('fall', [
    [0, '#ffffff', 0.95],
    [1, '#ffffff', 0.55],
  ]);
  const fx = w * 0.62;
  body += `<path d="M${r1(fx)} ${r1(h * 0.41)}C${r1(fx - 20)} ${r1(h * 0.55)} ${r1(fx - 30)} ${r1(h * 0.68)} ${r1(fx - 40)} ${r1(h * 0.8)}L${r1(fx + 60)} ${r1(h * 0.8)}C${r1(fx + 50)} ${r1(h * 0.68)} ${r1(fx + 60)} ${r1(h * 0.55)} ${r1(fx + 70)} ${r1(h * 0.405)}Z" fill="url(#fall)"/>`;
  const rand = rng(283);
  for (let i = 0; i < 14; i += 1) {
    const x = fx - 25 + rand() * 80;
    body += `<rect x="${r1(x)}" y="${r1(h * 0.43 + rand() * h * 0.2)}" width="3" height="${r1(80 + rand() * 140)}" rx="1.5" fill="#ffffff" opacity="0.6"/>`;
  }
  const mist = haze({ id: 'mist', w, y: h * 0.8, height: 220, color: '#ffffff', opacity: 0.85 });
  defs += mist.defs;
  body += mist.body;
  // foreground pool + forest
  const fg = ridge({ w, h, seed: 284, baseY: h * 1.02, amp: h * 0.16, scale: 420, peaks: 1.1 });
  body += `<path d="${fg.d}" fill="#1f3036"/>`;
  const nfg = noise1D(284);
  body += pineRow({
    seed: 285,
    w,
    baseFn: (x) =>
      h * 1.02 -
      h * 0.16 * Math.pow(Math.min(1, Math.max(0, (nfg(x / 420, 4) - 0.12) / 0.76)), 1.1),
    count: 26,
    minH: 120,
    maxH: 220,
    color: '#1f3036',
  });
  return write('mood-nature-wellness.svg', svg(w, h, body, defs));
}

function cityBreaks() {
  const [w, h] = [1200, 1500];
  const river = h * 0.64;
  let defs =
    linear('sky', [
      [0, '#2c3466'],
      [0.5, '#6a5f9e'],
      [0.85, '#d39aa4'],
      [1, '#f0bba8'],
    ]) +
    linear('river', [
      [0, '#6c5f9c'],
      [1, '#171b35'],
    ]);
  const s = sun({
    id: 's',
    cx: w * 0.62,
    cy: river - 60,
    r: 54,
    core: '#ffe2cf',
    glow: '#ffc8b0',
    glowR: 5,
  });
  defs += s.defs;
  let body =
    `<rect width="${w}" height="${h}" fill="url(#sky)"/>` +
    stars({ w, h, seed: 291, count: 50, maxY: h * 0.25 }) +
    s.body;
  body += skyline({
    seed: 292,
    x0: -10,
    x1: w + 10,
    baseY: river,
    minH: 90,
    maxH: 260,
    minW: 40,
    maxW: 90,
    color: '#7a6fa8',
    windowColor: null,
    gap: 4,
  });
  body += skyline({
    seed: 293,
    x0: -10,
    x1: w + 10,
    baseY: river,
    minH: 60,
    maxH: 420,
    minW: 50,
    maxW: 110,
    color: C.indigo2,
    windowChance: 0.2,
    gap: 30,
    spires: 0.3,
  });
  body += `<rect y="${r1(river)}" width="${w}" height="${r1(h - river)}" fill="url(#river)"/>`;
  body += streaks({
    seed: 294,
    cx: w * 0.62,
    y0: river + 8,
    y1: h * 0.86,
    maxW: 180,
    color: '#ffd2b3',
  });
  // suspension bridge in front
  const deck = h * 0.78;
  const t1 = w * 0.18;
  const t2 = w * 0.82;
  const top = h * 0.5;
  let br = '';
  for (const tx of [t1, t2]) {
    br += `<rect x="${r1(tx - 14)}" y="${r1(top)}" width="28" height="${r1(h - top)}" fill="${C.navy}"/>`;
    br += `<rect x="${r1(tx - 24)}" y="${r1(top + 60)}" width="48" height="12" fill="${C.navy}"/>`;
  }
  const cable = (x0, x1, sag) =>
    `M${r1(x0)} ${r1(top + 8)}Q${r1((x0 + x1) / 2)} ${r1(deck - sag)} ${r1(x1)} ${r1(top + 8)}`;
  br += `<path d="${cable(t1, t2, 30)}${cable(-260, t1, -60).replace('M', 'M')}${cable(t2, w + 260, -60)}" fill="none" stroke="${C.navy}" stroke-width="6"/>`;
  for (let x = t1 + 40; x < t2; x += 40) {
    const t = (x - t1) / (t2 - t1);
    const cy = (1 - t) ** 2 * (top + 8) + 2 * (1 - t) * t * (deck - 30) + t ** 2 * (top + 8);
    br += `<line x1="${r1(x)}" y1="${r1(cy)}" x2="${r1(x)}" y2="${r1(deck)}" stroke="${C.navy}" stroke-width="2"/>`;
  }
  br += `<rect x="-10" y="${r1(deck)}" width="${w + 20}" height="22" fill="${C.navy}"/>`;
  for (let x = 20; x < w; x += 46) {
    br += `<circle cx="${r1(x)}" cy="${r1(deck - 6)}" r="4" fill="${C.gold}"/>`;
  }
  body += br;
  body += birds({ seed: 295, x: w * 0.3, y: h * 0.22, count: 4, color: '#463f7c', scale: 1.2 });
  return write('mood-city-breaks.svg', svg(w, h, body, defs));
}

const files = [
  ...heroLayers({ w: 2400, h: 1500, suffix: '', horizon: 1500 * 0.6, sunX: 2400 * 0.7 }),
  ...heroLayers({ w: 1200, h: 2000, suffix: '-portrait', horizon: 2000 * 0.62, sunX: 1200 * 0.62 }),
  beach(),
  mountains(),
  city(),
  road(),
  goa(),
  jaipur(),
  kerala(),
  mountains({ w: 2400, h: 1000, name: 'destination-manali.svg', seedBase: 150 }),
  cta({ w: 2400, h: 1200, suffix: '' }),
  cta({ w: 1200, h: 1600, suffix: '-portrait' }),
  bengaluru(),
  hyderabad(),
  mumbai(),
  delhi(),
  bali(),
  kyoto(),
  singapore(),
  dubai(),
  natureWellness(),
  cityBreaks(),
];

const total = files.reduce((s, f) => s + f.bytes, 0);
for (const f of files) console.log(`${(f.bytes / 1024).toFixed(1).padStart(6)} kB  ${f.name}`);
console.log(`${(total / 1024).toFixed(1).padStart(6)} kB  total (${files.length} files)`);
