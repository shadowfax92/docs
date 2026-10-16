import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { publicOrigin as pub, catalogOrigin as cat, password, bearer, state } from './integration-server.mjs';

/** 5k acceptance against the retained compiled backend. Data always comes from real D1/FTS;
 * network gates delay or fail transport only, retaining actual response bytes for latest-only
 * and partial-error checks. No fixture HTTP results or browser search implementation is used.
 */
const browser = await chromium.launch({ headless: true, channel: 'chromium',
  ...(process.env.DOCS_CHROMIUM ? { executablePath: process.env.DOCS_CHROMIUM } : {}) });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage(); page.setDefaultTimeout(30_000);
const requests = [], responses = [], checks = [], errors = [];
let complete = false;
const check = (name, details = {}) => { checks.push({ name, ...details }); console.log(`PASS ${name}`); };
page.on('pageerror', e => errors.push(String(e)));
page.on('request', r => requests.push({ url: r.url(), type: r.resourceType(), method: r.method() }));
const responseWork = [];
page.on('response', r => {
  if (r.url().startsWith(cat + '/all-docs/api/')) responseWork.push((async () => {
    try {
      const bytes = await r.body(); const body = JSON.parse(bytes.toString('utf8'));
      assert(!Object.hasOwn(body, 'text')); assert(!Object.hasOwn(body, 'body'));
      assert(!body.items?.some(item => Object.hasOwn(item, 'text') || Object.hasOwn(item, 'body')));
      responses.push({ path: new URL(r.url()).pathname, status: r.status(), bytes: bytes.length,
        complete: body.complete, hits: body.hits?.length, generation: body.generation,
        query: r.request().postDataJSON()?.query?.text });
    } catch (error) { if (r.status() === 200) errors.push(String(error)); }
  })());
});
await page.addInitScript(() => {
  window.fixtureWorkers = [];
  const NativeWorker = window.Worker;
  window.Worker = class extends NativeWorker { constructor(url, ...rest) { window.fixtureWorkers.push(String(url)); super(url, ...rest); } };
});
const ready = () => page.getByRole('button', { name: 'Select all 5,000 matching', exact: true }).waitFor();
const search = page.getByRole('searchbox', { name: 'Search names and content' });
async function query(text, expected) {
  await search.fill(text);
  await page.waitForFunction(({ text, expected }) => document.querySelector('#search').value === text
    && document.querySelectorAll('article[data-id]').length === Math.min(expected, 48)
    && !document.querySelector('#search-error').textContent
    && document.querySelector('.coverage').textContent.startsWith('Complete'), { text, expected }, { timeout: 120_000 });
}
try {
  await mkdir(resolve(state, 'screenshots'), { recursive: true });
  const started = performance.now();
  await page.goto(cat + '/all-docs'); await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Unlock', exact: true }).click(); await ready();
  await page.waitForFunction(() => !Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'Select all 5,000 matching')?.disabled);
  await Promise.all(responseWork.splice(0));
  const initial = requests.filter(r => r.url.startsWith(cat));
  assert(initial.length <= 18, `fresh catalog requests ${initial.length}`);
  assert.equal(initial.filter(r => r.url.includes('/api/documents')).length, 11); // 10 full pages + final empty keyset page.
  assert(!requests.some(r => /\/text(?:\?|$)|search-worker/.test(r.url)));
  assert.deepEqual(await page.evaluate(() => window.fixtureWorkers), []);
  check('fresh 5k real UI metadata-only open, no text/worker/corpus transfer', { nonThumbnailRequests: initial.length, elapsedMs: Math.round(performance.now() - started) });
  const offset = requests.length, reloadAt = performance.now(); await page.reload(); await ready();
  await page.waitForFunction(() => !Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'Select all 5,000 matching')?.disabled);
  check('warm reload uses persistent backend', { nonThumbnailRequests: requests.slice(offset).filter(r => r.url.startsWith(cat)).length,
    elapsedMs: Math.round(performance.now() - reloadAt) });
  await query('policy-handbook-2345', 1); assert.equal(await page.locator('article[data-id]').getAttribute('data-id'), 'C0002345');
  await query('literal.a+b', 5000); await query('caseneedle', 5000);
  await page.getByRole('button', { name: 'Match case', exact: true }).click(); await query('caseneedle', 0);
  await query('CaseNeedle', 5000); await page.getByRole('button', { name: 'Match case', exact: true }).click();
  check('real title/filename/body/literal/Aa exact search');
  await page.getByRole('button', { name: 'Regular expression (RE2)', exact: true }).click();
  await query('BodySentinel', 5000); await Promise.all(responseWork.splice(0));
  assert(responses.some(r => r.path.endsWith('/search') && r.query === 'BodySentinel' && r.complete === false));
  assert(responses.some(r => r.path.endsWith('/search') && r.query === 'BodySentinel' && r.complete === true));
  assert((await page.locator('article[data-id]').first().innerText()).includes('2 matches'));
  assert(await page.locator('article[data-id] mark').count() > 0);
  check('real bounded regex continuations, exact counts and snippet highlights');
  // Pause one real response to exercise the browser's async handoff with newer input.
  let release, arrived;
  const gate = new Promise(r => release = r), reached = new Promise(r => arrived = r);
  await page.route('**/all-docs/api/search', async route => {
    const payload = route.request().postDataJSON();
    if (payload.query.text === 'Database' && !payload.cursor) {
      const response = await route.fetch(); arrived(); await gate;
      try { await route.fulfill({ response }); } catch { /* A replaced request may already be aborted. */ }
    } else await route.continue();
  });
  await search.fill('Database'); await reached; await search.fill('policy-handbook-2345'); release();
  await query('policy-handbook-2345', 1); await page.unroute('**/all-docs/api/search');
  assert.equal(await page.locator('article[data-id]').getAttribute('data-id'), 'C0002345');
  check('latest-only typing discards delayed obsolete real response');
  let cut = false;
  await page.route('**/all-docs/api/search', async route => {
    const input = route.request().postDataJSON();
    if (input.query.text === 'BodySentinel' && input.cursor && !cut) { cut = true; await route.abort('failed'); }
    else await route.continue();
  });
  await search.fill('BodySentinel');
  await page.waitForFunction(() => document.querySelector('#search-error').textContent.length > 0, null, { timeout: 120_000 });
  assert(cut); assert(await page.getByRole('button', { name: 'Select all matching', exact: true }).isDisabled());
  check('transport error after real partial scan remains explicit and blocks all-matching');
  await page.unroute('**/all-docs/api/search');
  const invalid = page.waitForResponse(r => r.url().endsWith('/all-docs/api/search')
    && r.request().postDataJSON()?.query?.text === '[' && r.status() === 400);
  await search.fill('['); await invalid;
  await page.waitForFunction(() => document.querySelector('#search-error').textContent.length > 0);
  await page.getByRole('button', { name: 'Regular expression (RE2)', exact: true }).click();
  await query('Database policy', 5000);
  await page.getByRole('button', { name: 'Select all 5,000 matching', exact: true }).click();
  assert.equal(await page.locator('.selection-bar .count').innerText(), '5,000');
  await page.getByRole('button', { name: 'Clear', exact: true }).click();
  await page.screenshot({ path: resolve(state, 'screenshots/scale-real-backend.png') });
  const uploaded = await fetch(pub + '/upload', { method: 'PUT', headers: { Authorization: `Bearer ${bearer}`,
    'X-Filename': 'generation.txt', 'Content-Type': 'text/plain' }, body: 'Database policy new generation' });
  assert.equal(uploaded.status, 200);
  await query('policy-handbook-2345', 1);
  await page.getByText('The library changed since it loaded. Refresh to see the latest documents.', { exact: true }).waitFor();
  assert(await page.getByRole('button', { name: 'Select all matching', exact: true }).isDisabled());
  check('real upload generation change blocks stale snapshot selection');
  assert.deepEqual(errors, []); assert(!requests.some(r => /\/text(?:\?|$)|search-worker/.test(r.url)));
  complete = true;
} finally {
  await Promise.allSettled(responseWork);
  const manifest = JSON.parse(await readFile(resolve(state, 'server.json'), 'utf8'));
  await writeFile(resolve(state, 'scale-browser-results.json'), JSON.stringify({ complete, checks, errors, browser: browser.version(),
    manifest, requests, responses, limits: 'Headless local native workerd; cached D1 seeding is not 5k R2 backfill or deployed CPU/p95 acceptance.' }, null, 2));
  await browser.close();
}
