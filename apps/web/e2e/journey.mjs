#!/usr/bin/env node
/**
 * End-to-end smoke journey (Phase 32, docs/testing.md#end-to-end).
 *
 * Drives a real browser against a running production build and API:
 *
 *   visitor search → offer → sign-up → traveller details → demo booking →
 *   demo payment (a double click makes one payment) → My trips → cancel →
 *   sign-out → protected pages need sign-in again → an administrator sees
 *   the booking in Analytics; a customer gets "no access"
 *
 * with an axe scan (WCAG 2.1 AA, serious and critical) on each key page.
 * Everything is demo: no supplier is contacted and no money moves.
 *
 * Needs: the API (demo search providers, demo payments) and `vite preview`
 * (or any static host of apps/web/dist) running, and the API's DATABASE_URL
 * so the admin role can be granted with the audited CLI.
 *
 *   E2E_BASE_URL=http://localhost:4173 E2E_API_URL=http://localhost:4000 \
 *     npm run test:e2e -w @wayora/web
 *
 * Exits non-zero on the first failed step, with a screenshot in
 * e2e-results/. Never point it at production: it creates accounts.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { chromium } from 'playwright';

const BASE = (process.env.E2E_BASE_URL ?? 'http://localhost:4173').replace(/\/$/, '');
const API = `${(process.env.E2E_API_URL ?? 'http://localhost:4000').replace(/\/$/, '')}/api/v1`;
if (/wayora\.(com|app|in)\b/.test(BASE) || process.env.NODE_ENV === 'production') {
  console.error('Refusing to run the E2E journey against production.');
  process.exit(2);
}
const require = createRequire(import.meta.url);
const AXE = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
const RESULTS = new URL('../e2e-results/', import.meta.url);
mkdirSync(RESULTS, { recursive: true });

const stamp = Date.now();
const PASSWORD = 'blue river morning e2e';
const customer = `e2e-customer-${stamp}@example.com`;
const adminEmail = `e2e-admin-${stamp}@example.com`;
const day = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
const HOTELS = `/hotels?to=city%3Agoa&checkin=${day(21)}&checkout=${day(24)}&rooms=1&adults=2`;

let step = 0;
let currentPage;
async function check(name, fn) {
  step += 1;
  const started = Date.now();
  try {
    await fn();
    console.log(`✓ ${String(step).padStart(2)} ${name} (${Date.now() - started} ms)`);
  } catch (error) {
    console.error(`✗ ${String(step).padStart(2)} ${name}\n  ${error.message.split('\n')[0]}`);
    if (currentPage)
      await currentPage
        .screenshot({ path: new URL(`step-${step}.png`, RESULTS).pathname, fullPage: true })
        .catch(() => undefined);
    await browser.close();
    process.exit(1);
  }
}
function assert(condition, message) {
  if (!condition) throw new Error(message);
}

/** Serious or critical WCAG 2.1 A/AA problems on the page, none allowed. */
async function axe(page, label) {
  await page.evaluate(AXE);
  const violations = await page.evaluate(async () =>
    (await window.axe.run(document, { runOnly: ['wcag2a', 'wcag2aa', 'wcag21aa'] })).violations
      .filter((v) => v.impact === 'serious' || v.impact === 'critical')
      .map((v) => `${v.id} (${v.nodes.length}): ${v.nodes[0]?.target}`),
  );
  assert(violations.length === 0, `${label}: ${violations.join('; ')}`);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  assert(overflow <= 0, `${label}: the page scrolls sideways by ${overflow}px`);
}

const launch = process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {};
const browser = await chromium.launch(launch);
const errors = [];
async function newPage(options = {}) {
  const ctx = await browser.newContext({ reducedMotion: 'reduce', ...options });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  currentPage = page;
  return page;
}
const h1 = (page, name) =>
  page.getByRole('heading', { level: 1, name }).waitFor({ timeout: 20_000 });

// ─── Customer ─────────────────────────────────────────────────────────────
const page = await newPage();
let reference = '';

await check('home page renders the app and passes axe', async () => {
  await page.goto(BASE + '/', { waitUntil: 'load' });
  await page.locator('#hero-title').waitFor();
  assert((await page.locator('h1').count()) === 1, 'one h1 on the home page');
  await axe(page, 'home');
});

await check('hotel search shows demo results; sorting changes the URL', async () => {
  await page.goto(BASE + HOTELS, { waitUntil: 'load' });
  const list = page.getByRole('list', { name: 'Search results' });
  await list.waitFor();
  assert((await list.getByRole('listitem').count()) > 0, 'results are listed');
  assert(await page.getByText('Demo data only').first().isVisible(), 'the demo notice is shown');
  const resorted = page.waitForResponse(
    (r) => r.request().method() === 'POST' && r.url().includes('/search/hotels'),
  );
  await page.getByLabel('Sort by').selectOption('price-desc');
  await page.waitForURL((u) => u.searchParams.get('sort') === 'price-desc');
  await resorted;
  // Previous results stay on screen, dimmed and aria-busy, until the new order arrives.
  await page.locator('[aria-busy="true"]').waitFor({ state: 'detached' });
  await list.waitFor();
  await axe(page, 'search results');
});

await check('booking an offer while signed out asks to sign in first', async () => {
  const list = page.getByRole('list', { name: 'Search results' });
  await list
    .getByRole('link', { name: /View details/ })
    .first()
    .click();
  await page
    .getByRole('complementary', { name: 'Price' })
    .getByRole('link', { name: 'Book this demo offer' })
    .click();
  await page.waitForURL((u) => u.pathname === '/login');
  assert(
    new URL(page.url()).searchParams.get('redirect')?.startsWith('/book/'),
    'returns to checkout',
  );
});

await check('registering returns to checkout', async () => {
  await page.getByRole('link', { name: /create an account/i }).click();
  await page.getByLabel('Your name').fill('Asha Rao');
  await page.getByLabel('Email address').fill(customer);
  await page.locator('input[type=password]').nth(0).fill(PASSWORD);
  await page.locator('input[type=password]').nth(1).fill(PASSWORD);
  await page.getByRole('button', { name: /create account/i }).click();
  await page.waitForURL((u) => u.pathname.startsWith('/book/'), { timeout: 20_000 });
});

await check('traveller details and review create one demo booking', async () => {
  await page.getByRole('button', { name: 'Continue to traveller details' }).click();
  await page.getByRole('textbox', { name: /first name/i }).fill('Asha');
  await page.getByRole('textbox', { name: /last name/i }).fill('Rao');
  await page.getByRole('button', { name: 'Continue to review' }).click();
  await axe(page, 'checkout review');
  await page.getByRole('checkbox', { name: 'I understand this is a demo booking' }).check();
  await page.getByRole('button', { name: 'Confirm demo booking' }).click();
  await h1(page, 'Pay for your demo booking');
  reference = page.url().match(/\/trips\/([^/]+)\/pay/)?.[1] ?? '';
  assert(/^WYD-/.test(reference), `a WYD- reference (${page.url()})`);
});

await check('a double click on Pay makes exactly one demo payment', async () => {
  const posts = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && /\/bookings\/[^/]+\/payments$/.test(r.url())) posts.push(r);
  });
  await axe(page, 'payment review');
  await page.getByRole('button', { name: /^Pay ₹[\d,]+ \(demo\)$/ }).dblclick();
  await h1(page, /Demo payment (successful|processing)|Processing your demo payment/);
  await h1(page, 'Demo payment successful');
  assert(posts.length === 1, `${posts.length} payment requests`);
  assert(
    (await page.locator('main').innerText()).includes('no real money'),
    'the success page says no real money moved',
  );
});

await check('My trips lists the booking; the booking page shows it confirmed', async () => {
  await page.goto(BASE + '/trips', { waitUntil: 'load' });
  await page.getByText(reference).first().waitFor();
  await axe(page, 'my trips');
  await page.goto(`${BASE}/trips/${reference}`, { waitUntil: 'load' });
  await page.getByText('Demo confirmed').first().waitFor();
  const details = await page.locator('main').innerText();
  assert(details.includes('Paid with a demo payment'), 'the payment is shown as paid');
  assert(!details.includes('Nothing was paid'), 'a paid booking never says nothing was paid');
  await axe(page, 'booking details');
});

await check(
  'cancelling the paid demo booking records a refund owed, not money returned',
  async () => {
    await page.getByRole('button', { name: 'Cancel demo booking' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.waitFor();
    await dialog.getByRole('button', { name: 'Cancel booking' }).click();
    await dialog.waitFor({ state: 'detached', timeout: 20_000 });
    await page
      .getByText(/refund would be owed/i)
      .first()
      .waitFor();
    const res = await page.evaluate(
      async ([api, ref]) =>
        (await fetch(`${api}/bookings/${ref}`, { credentials: 'include' })).json(),
      [API, reference],
    );
    assert(res.data.status === 'cancelled', `status ${res.data.status}`);
    assert(
      res.data.refund.state === 'required' && res.data.refund.demo === true,
      `refund ${JSON.stringify(res.data.refund)}`,
    );
  },
);

await check('customers get "no access" in the admin area', async () => {
  await page.goto(BASE + '/admin', { waitUntil: 'load' });
  await page.getByRole('heading', { name: /you don’t have access/i }).waitFor();
});

await check('signing out ends the session; private pages ask to sign in', async () => {
  await page.goto(BASE + '/trips', { waitUntil: 'load' });
  await page.getByRole('button', { name: /Account menu for/ }).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await page.waitForTimeout(500);
  await page.goto(BASE + '/trips', { waitUntil: 'load' });
  await page.waitForURL((u) => u.pathname === '/login');
  const status = await page.evaluate(
    async (api) => (await fetch(`${api}/auth/me`, { credentials: 'include' })).status,
    API,
  );
  assert(status === 401, `/auth/me after sign-out answers ${status}`);
});

// ─── Administrator ────────────────────────────────────────────────────────
const admin = await newPage();
await check(
  'an administrator (granted with the audited CLI) sees the booking in Analytics',
  async () => {
    await admin.goto(BASE + '/register', { waitUntil: 'load' });
    await admin.getByLabel('Your name').fill('Ada Admin');
    await admin.getByLabel('Email address').fill(adminEmail);
    await admin.locator('input[type=password]').nth(0).fill(PASSWORD);
    await admin.locator('input[type=password]').nth(1).fill(PASSWORD);
    await admin.getByRole('button', { name: /create account/i }).click();
    await admin.waitForURL((u) => !u.pathname.startsWith('/register'));
    execFileSync(
      'npm',
      [
        'run',
        '-s',
        'admin:role',
        '--',
        '--email',
        adminEmail,
        '--role',
        'admin',
        '--reason',
        'E2E journey',
      ],
      { cwd: new URL('../../..', import.meta.url).pathname, stdio: 'pipe' },
    );
    await admin.goto(BASE + '/admin/analytics?preset=today', { waitUntil: 'load' });
    await h1(admin, 'Analytics: Overview');
    await admin.getByRole('heading', { name: 'Money (demo)' }).waitFor({ timeout: 20_000 });
    const demo = await admin.getByText('Demo · simulated, not money').count();
    assert(demo > 0, 'demo money is labelled as simulated');
    await axe(admin, 'admin analytics');
  },
);

await check('no uncaught errors in any page', async () => {
  assert(errors.length === 0, errors.join(' | '));
});

await browser.close();
console.log(`\nE2E journey passed (${step} steps).`);
