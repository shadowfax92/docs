import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

/** Fixture-only proof of the built app -> real Web Worker -> RE2 index chain. The loopback
 * server owns all metadata/text, holds bodies explicitly, and never loads account credentials.
 * Run `npm run bundle && node scripts/title-search-proof.mjs [output-directory]` from worker/.
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(process.argv[2] || resolve(root, '../.scratch/docs-title-search/browser'));
await mkdir(output, { recursive: true });
const generated = await readFile(resolve(root, '.wrangler/generated/catalog-assets.ts'), 'utf8');
const assets = JSON.parse(generated.slice(generated.indexOf('= ') + 2).trim().slice(0, -1));
const now = Date.now();
const fixtures = [
  ['Title001', 'UniqueTitleSentinel Kſ Élan 😀 𐐀', 'ordinary.txt', 'text'],
  ['File0001', 'Ordinary title', 'FilenameSentinel.txt', 'text'],
  ['Fail0001', 'FailedTitleSentinel', 'failed.txt', 'text'],
  ['Stal0001', 'StaleTitleSentinel', 'changed.txt', 'text'],
  ['Mism0001', 'MismatchTitleSentinel', 'mismatch.txt', 'text'],
  ['Meta0001', 'ImageTitleSentinel', 'image.png', 'image'],
  ['Body0001', 'Neutral title', 'neutral.txt', 'text'],
].map(([id, title, filename, kind]) => ({
  id, title, filename, kind, version: 'v1', mime: 'text/plain', sizeBytes: 100,
  uploadedAt: new Date(now).toISOString(), timeSource: 'r2', createdAt: null,
  publicUrl: `https://public-fixture.invalid/${id}`, rawUrl: `https://public-fixture.invalid/${id}/raw`,
  downloadUrl: `https://public-fixture.invalid/${id}/download`, objectCount: 1, warnings: [],
}));
let hold = true, failures = true;
const held = [];
const requests = [];
const server = createServer((request, response) => {
  const url = new URL(request.url, 'http://fixture.test');
  const json = (data, status = 200) => {
    if (response.destroyed) return;
    response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify(data));
  };
  if (assets[url.pathname]) {
    const asset = assets[url.pathname];
    response.writeHead(200, { 'Content-Type': asset.type, 'Cache-Control': 'no-store' });
    response.end(asset.body); return;
  }
  if (url.pathname === '/all-docs/session') {
    json({ version: 1, csrfToken: 'fixture-csrf', expiresAt: new Date(now + 3600000).toISOString() }); return;
  }
  if (url.pathname === '/all-docs/api/documents') {
    const last = url.searchParams.has('cursor');
    json({ version: 1, items: last ? fixtures.slice(3) : fixtures.slice(0, 3), nextCursor: last ? null : 'page2', scanComplete: last, observedAt: new Date(now).toISOString() }); return;
  }
  const match = /^\/all-docs\/api\/documents\/(\w{8})\/text$/.exec(url.pathname);
  if (match) {
    const id = match[1]; requests.push(id);
    const reply = () => {
      if (failures && (id === 'Fail0001' || id === 'Stal0001')) {
        json({ version: 1, error: { code: 'fixture_error', message: 'Fixture body unavailable', retryable: true } }, id === 'Fail0001' ? 500 : 409); return;
      }
      const text = id === 'Meta0001' ? '' : id === 'Title001'
        ? 'UniqueTitleSentinel UniqueTitleSentinel BodySentinel' : 'BodySentinel';
      json({ version: 1, id, documentVersion: failures && id === 'Mism0001' ? 'stale' : url.searchParams.get('version'),
        coverage: id === 'Meta0001' ? 'metadata-only' : 'full', reason: id === 'Meta0001' ? 'No OCR' : null,
        text, indexedBytes: text.length, sourceBytes: 100, extractorVersion: 1 });
    };
    if (hold) held.push(reply); else reply();
    return;
  }
  response.writeHead(404); response.end();
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
const checks = [], errors = [];
const check = (name) => { checks.push(name); console.log(`PASS ${name}`); };
try {
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  // The proof's synthetic public links must never trigger outbound requests for previews.
  await context.route('https://public-fixture.invalid/**', (route) => route.abort());
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.goto(`${origin}/all-docs#q=UniqueTitleSentinel`);
  const search = page.getByRole('searchbox', { name: 'Search names and content' });
  const query = async (text, expected) => {
    await search.fill(text);
    await page.waitForFunction(({ text, expected }) => {
      const ids = [...document.querySelectorAll('article[data-id]')].map((el) => el.dataset.id).sort();
      return document.querySelector('#search')?.value === text && JSON.stringify(ids) === JSON.stringify([...expected].sort());
    }, { text, expected });
  };
  const coverage = page.locator('.coverage');
  const allDisabled = () => page.getByRole('button', { name: 'Select all matching', exact: true }).isDisabled();
  await query('UniqueTitleSentinel', ['Title001']);
  await page.waitForFunction(() => document.querySelector('.coverage')?.textContent.includes('Titles and filenames searched in 7 documents'));
  assert.equal(requests.length, 3); // All slots held: no successful text response exists yet.
  assert.match(await coverage.innerText(), /Content searched in 0 of 7 documents/);
  assert.equal(await allDisabled(), true);
  check('unique title before any body response, names 7 / body 0, global selection disabled');
  await query('FilenameSentinel', ['File0001']);
  check('filename-only hit while all body requests are held');
  await query('élan', ['Title001']);
  assert.equal(await page.locator('article .snippet mark').innerText(), 'Élan');
  await page.getByRole('button', { name: 'Match case', exact: true }).click();
  await query('élan', []);
  await page.getByRole('button', { name: 'Match case', exact: true }).click();
  await page.getByRole('button', { name: 'Regular expression (RE2)', exact: true }).click();
  await query('Unique.*Sentinel', ['Title001']);
  await page.getByRole('button', { name: 'Regular expression (RE2)', exact: true }).click();
  check('real RE2 Unicode highlight, case toggle and regex title controls before body arrival');
  await query('UniqueTitleSentinel', ['Title001']);
  await page.screenshot({ path: resolve(output, 'held.png') });
  hold = false; for (const reply of held.splice(0)) reply();
  await page.waitForFunction(() => document.querySelector('article[data-id="Title001"] .matches')?.textContent === '3 matches');
  assert.equal(await page.locator('article[data-id="Title001"]').count(), 1);
  await page.waitForFunction(() => document.querySelector('.coverage')?.textContent.includes('3 content unavailable'));
  assert.match(await coverage.innerText(), /content searched in 3 documents/);
  assert.equal(await allDisabled(), true);
  check('incremental body upgrade changes 1 to 3 matches on one card; failed bodies remain truthful');
  for (const [text, id] of [['FailedTitleSentinel', 'Fail0001'], ['StaleTitleSentinel', 'Stal0001'], ['MismatchTitleSentinel', 'Mism0001']]) await query(text, [id]);
  await page.screenshot({ path: resolve(output, 'failed.png') });
  check('HTTP 500, 409 and version mismatch retain title hits with select-all disabled');
  await query('BodySentinel', ['Title001', 'File0001', 'Body0001']);
  await query('ImageTitleSentinel', ['Meta0001']);
  assert.equal(await page.locator('[data-coverage="label"]').innerText(), 'name match only');
  check('body-only arrival and metadata-only image coverage');
  failures = false;
  await coverage.getByRole('button', { name: 'Retry', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.coverage')?.textContent.startsWith('Complete'));
  assert.match(await coverage.innerText(), /content searched in 6 documents/);
  assert.equal(await page.getByRole('button', { name: 'Select all 1 matching', exact: true }).isEnabled(), true);
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.coverage')?.textContent.startsWith('Complete') && document.querySelector('.coverage')?.textContent.includes('Titles and filenames searched in 7 documents'));
  await query('UniqueTitleSentinel', ['Title001']);
  assert.equal(await page.locator('article .matches').innerText(), '3 matches');
  assert.deepEqual(errors, []);
  check('retry restores body completeness and selection gate; refresh rebuilds without duplicate counts');
} finally {
  hold = false; for (const reply of held.splice(0)) reply();
  await browser?.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await writeFile(resolve(output, 'results.json'), JSON.stringify({ checks, errors, complete: checks.length === 7, limits: 'Loopback fixture data and isolated headless Chromium only; no production/deployed acceptance.' }, null, 2));
}
