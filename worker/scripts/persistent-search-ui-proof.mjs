import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';

/**
 * Real-browser proof of the built catalog UI against the FROZEN HTTP protocol (docs-index-ui).
 *
 * This is a fixture proof, not the integrated backend: a loopback server implements the
 * library-contracts.ts routes (≤500-row metadata pages at one generation, search slices with
 * signed-looking cursors, ≤48-ref snippets, retry, frozen-ref delete) over a 5,000-document
 * metadata fixture, answering queries with the production RE2 matcher bundled from src/search.ts.
 * A second loopback origin serves inert HTML for sandboxed card thumbnails. The integrated
 * Worker + D1 acceptance belongs to the integration owner once the backend slices merge.
 *
 *   catalog fixture  http://127.0.0.1:<port>   built shell/app/styles, session cookie, library API
 *   public fixture   http://localhost:<port>   /<id>/raw for the HTML card previews only
 *
 * Usage (from worker/): node scripts/build.mjs && node scripts/persistent-search-ui-proof.mjs [output-dir]
 * Output: results.json and screenshots/*.png (default ../.scratch/docs-index-ui/proof).
 * No account credentials, Cloudflare resources or production data are touched.
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(process.argv[2] || resolve(root, '../.scratch/docs-index-ui/proof'));
await mkdir(resolve(output, 'screenshots'), { recursive: true });

// ---- Built assets and the production matcher ------------------------------------------------
const generated = await readFile(resolve(root, '.wrangler/generated/catalog-assets.ts'), 'utf8');
const assets = JSON.parse(generated.slice(generated.indexOf('= ') + 2).trim().slice(0, -1));
assert.deepEqual(Object.keys(assets).sort(), ['/all-docs', '/all-docs/assets/app.js', '/all-docs/assets/styles.css'],
  'the build ships no search-worker asset');
const matcherModule = resolve(output, 'search-matcher.mjs');
await build({ absWorkingDir: root, entryPoints: ['src/search.ts'], bundle: true, format: 'esm', platform: 'node', outfile: matcherModule, logLevel: 'silent' });
const { compileSearchMatcher, SearchError } = await import(pathToFileURL(matcherModule).href);

// ---- 5,000-document fixture -------------------------------------------------------------------
const NOW = Date.now();
const DAY = 86_400_000;
const KINDS = ['markdown', 'markdown', 'markdown', 'text', 'text', 'html', 'pdf', 'pdf', 'image', 'data', 'office', 'archive'];
const MIME = { markdown: 'text/markdown', text: 'text/plain', html: 'text/html', pdf: 'application/pdf', image: 'image/png',
  data: 'application/json', office: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', archive: 'application/zip' };
const EXT = { markdown: 'md', text: 'txt', html: 'html', pdf: 'pdf', image: 'png', data: 'json', office: 'docx', archive: 'zip' };
const WORDS = ['budget', 'roadmap', 'customer', 'pipeline', 'renewal', 'hiring', 'security', 'pricing', 'launch', 'support'];
let generation = 41;
let publicOrigin = '';
const docs = [];
const bodies = new Map();
function addDoc(id, n, { kind, title, body, index, uploadedAt }) {
  const filename = `${title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || id}.${EXT[kind]}`;
  docs.push({
    id, version: `v1-${id}`, title, filename, kind, mime: MIME[kind], sizeBytes: 900 + (n % 97) * 131,
    uploadedAt: new Date(uploadedAt ?? NOW - n * 3 * 3_600_000).toISOString(), timeSource: 'r2', createdAt: null,
    publicUrl: `${publicOrigin}/${id}`, rawUrl: `${publicOrigin}/${id}/raw`, downloadUrl: `${publicOrigin}/${id}/download`,
    objectCount: 1, warnings: [],
    index: { state: 'indexed', coverage: 'full', reason: null, indexedBytes: body.length, extractorVersion: 1, ...index },
  });
  if (body) bodies.set(id, body);
}
function seed() {
  // Newest first: the special cases land on the first screen.
  addDoc('Hostile1', 0, { kind: 'markdown', title: 'Hostile markup note', index: {},
    body: 'Note: <img src=x onerror="window.__alerted=1"> invoice paid <script>window.__alerted=2</script> end.' });
  addDoc('Pending1', 1, { kind: 'markdown', title: 'Pending invoice draft', body: '',
    index: { state: 'pending', coverage: null, reason: 'paused: index size budget', indexedBytes: 0, extractorVersion: 0 } });
  addDoc('Failed01', 2, { kind: 'markdown', title: 'Failed board notes', body: '',
    index: { state: 'failed', coverage: null, reason: 'DOCX could not be parsed within the bounded ZIP/XML limits.', indexedBytes: 0 } });
  addDoc('Unicode1', 3, { kind: 'text', title: 'Café Kſ notes', body: 'Ünïcödé café paid 😀 invoice ΣΑΣ' });
  for (let n = 4; n < 5000; n++) {
    const kind = KINDS[n % KINDS.length];
    const id = `D${String(n).padStart(7, '0')}`;
    const word = WORDS[n % WORDS.length];
    const textual = ['markdown', 'text', 'html', 'data', 'office'].includes(kind);
    const body = textual
      ? `${word} review ${n}. ${n % 7 === 0 ? 'Invoice paid in full. ' : ''}${'paid '.repeat(n % 4)}Owner ${WORDS[(n * 3) % 10]}.`
      : '';
    let index = textual ? {} : { coverage: 'metadata-only', reason: kind === 'pdf' ? 'PDF text extraction is not enabled. No OCR is performed.' : null, indexedBytes: 0 };
    if (kind === 'office' && n % 5 === 0) index = { coverage: 'truncated', reason: 'Only DOCX main-document text was extracted.', indexedBytes: body.length };
    if (kind === 'markdown' && n % 400 === 13) index = { state: 'pending', coverage: null, reason: null, indexedBytes: 0, extractorVersion: 0 };
    if (kind === 'markdown' && n % 900 === 21) index = { state: 'failed', coverage: null, reason: 'Extraction failed.', indexedBytes: 0 };
    addDoc(id, n, { kind, title: `${word[0].toUpperCase()}${word.slice(1)} ${kind} ${n}`, body: index.state ? '' : body, index });
  }
}

const counts = () => ({
  documents: docs.length,
  pending: docs.filter((doc) => doc.index.state === 'pending').length,
  indexed: docs.filter((doc) => doc.index.state === 'indexed').length,
  failed: docs.filter((doc) => doc.index.state === 'failed').length,
  metadataOnly: docs.filter((doc) => doc.index.coverage === 'metadata-only').length,
  truncated: docs.filter((doc) => doc.index.coverage === 'truncated').length,
});
const status = () => ({
  counts: counts(), lastReconciledAt: new Date(NOW - 3_600_000).toISOString(), anomalies: 0,
  storage: { bytes: 120_000_000, budgetBytes: 400_000_000, planningBytes: null, projectedBytes: 380_000_000, paused: true, reason: 'index size budget' },
});

// ---- Catalog fixture (frozen protocol) --------------------------------------------------------
const log = [];          // Every catalog request: method, path, at.
const searchPlane = { inFlight: 0, max: 0 };
const deletes = [];
const fixture = { searchDelayMs: 60, regexSlice: 1000, regexDelayMs: 250 };
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const fields = (doc) => ({ filename: doc.filename, title: doc.title, body: doc.index.state === 'indexed' ? bodies.get(doc.id) ?? '' : '' });

function readBody(request) {
  return new Promise((ok, fail) => {
    let data = '';
    request.on('data', (chunk) => { data += chunk; if (data.length > 1e6) fail(new Error('too large')); });
    request.on('end', () => ok(data));
    request.on('error', fail);
  });
}

const catalog = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://catalog.fixture');
  log.push({ method: request.method, path: url.pathname + url.search, at: Date.now() });
  const json = (data, code = 200, headers = {}) => {
    if (response.destroyed) return;
    response.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers });
    response.end(JSON.stringify(data));
  };
  const fail = (code, errorCode, message, retryable = false) => json({ version: 1, error: { code: errorCode, message, retryable } }, code);
  const asset = assets[url.pathname];
  if (asset && request.method === 'GET') {
    const headers = { 'Content-Type': asset.type, 'Cache-Control': 'no-store' };
    // The catalog's CSP minus worker-src: the UI must not need a Worker at all.
    if (url.pathname === '/all-docs') headers['Content-Security-Policy'] = `default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; font-src 'self'; frame-src ${publicOrigin}; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`;
    response.writeHead(200, headers);
    response.end(asset.body);
    return;
  }
  const signedIn = /(?:^|;\s*)fixture_session=ok(?:;|$)/.test(request.headers.cookie ?? '');
  if (url.pathname === '/all-docs/session') {
    if (request.method === 'GET') return signedIn ? json({ version: 1, csrfToken: 'fixture-csrf', expiresAt: new Date(NOW + 3_600_000).toISOString() }) : fail(401, 'unauthorized', 'Sign in.');
    if (request.method === 'POST') {
      const body = JSON.parse(await readBody(request));
      if (body.password !== 'fixture-password') return fail(401, 'unauthorized', 'Wrong password.');
      return json({ version: 1, csrfToken: 'fixture-csrf', expiresAt: new Date(NOW + 3_600_000).toISOString() }, 200,
        { 'Set-Cookie': 'fixture_session=ok; HttpOnly; Path=/; SameSite=Strict' });
    }
    if (request.method === 'DELETE') return json({ version: 1 }, 200, { 'Set-Cookie': 'fixture_session=; Max-Age=0; Path=/' });
  }
  if (!url.pathname.startsWith('/all-docs/api/')) { response.writeHead(404).end(); return; }
  if (!signedIn) return fail(401, 'unauthorized', 'Sign in.');
  if (request.headers['x-docs-catalog'] !== '1') return fail(403, 'forbidden', 'Missing X-Docs-Catalog.');
  if (request.method === 'GET' && url.pathname === '/all-docs/api/documents') {
    const cursor = url.searchParams.get('cursor');
    let page = 0;
    if (cursor !== null) {
      const parsed = /^g(\d+)p(\d+)$/.exec(cursor);
      if (!parsed) return fail(400, 'invalid_cursor', 'Bad cursor.');
      if (Number(parsed[1]) !== generation) return fail(409, 'stale_generation', 'The library changed.', true);
      page = Number(parsed[2]);
    }
    const items = docs.slice(page * 500, page * 500 + 500);
    const last = (page + 1) * 500 >= docs.length;
    return json({ version: 1, generation, items, nextCursor: last ? null : `g${generation}p${page + 1}`, scanComplete: last, observedAt: new Date().toISOString(), status: status() });
  }
  if (request.method !== 'POST') return fail(405, 'method', 'POST only.');
  if (request.headers['x-csrf-token'] !== 'fixture-csrf' || !String(request.headers['content-type']).startsWith('application/json')) {
    return fail(403, 'forbidden', 'Missing CSRF or JSON.');
  }
  const body = JSON.parse(await readBody(request));
  if (url.pathname === '/all-docs/api/search' || url.pathname === '/all-docs/api/snippets') {
    searchPlane.inFlight++;
    searchPlane.max = Math.max(searchPlane.max, searchPlane.inFlight);
    try {
      return url.pathname.endsWith('search') ? await search(body, json, fail) : await snippets(body, json, fail);
    } finally {
      searchPlane.inFlight--;
    }
  }
  if (url.pathname === '/all-docs/api/index/retry') {
    return json({ version: 1, outcome: 'complete', generation: generation + 1, processed: body.refs.length, indexed: 0, failed: body.refs.length, repaired: 0, reconciledPages: 0, textBytes: 0, status: status() });
  }
  if (url.pathname === '/all-docs/api/delete') {
    deletes.push(body);
    return json({ version: 1, outcomes: body.items.map((item) => ({ id: item.id, status: 'deleted' })) });
  }
  return fail(404, 'not_found', 'No such route.');
});

async function search(body, json, fail) {
  if (body.version !== 1 || !body.query || !body.filter) return fail(400, 'invalid_search_request', 'Bad search.');
  let start = 0;
  if (body.cursor !== undefined) {
    const parsed = /^g(\d+)s(\d+)$/.exec(body.cursor);
    if (!parsed) return fail(400, 'invalid_cursor', 'Bad cursor.');
    if (Number(parsed[1]) !== generation) return fail(409, 'stale_generation', 'The library changed.', true);
    start = Number(parsed[2]);
  }
  const progressive = body.query.mode === 'regex';
  await sleep(progressive ? fixture.regexDelayMs : fixture.searchDelayMs);
  const end = progressive ? Math.min(docs.length, start + fixture.regexSlice) : docs.length;
  let matcher;
  try {
    matcher = compileSearchMatcher(body.query);
  } catch (error) {
    if (error instanceof SearchError) return fail(400, error.code, error.message);
    throw error;
  }
  try {
    const hits = [];
    for (const doc of docs.slice(start, end)) {
      const match = matcher.match(fields(doc));
      if (match) hits.push({ id: doc.id, version: doc.version, matchCount: match.matchCount });
    }
    const complete = end >= docs.length;
    return json({ version: 1, generation, hits, complete, nextCursor: complete ? null : `g${generation}s${end}`,
      scope: { documents: docs.length, pending: counts().pending, failed: counts().failed }, status: status() });
  } finally {
    matcher.dispose();
  }
}

async function snippets(body, json, fail) {
  if (body.version !== 1 || !Array.isArray(body.refs) || body.refs.length === 0 || body.refs.length > 48) return fail(400, 'invalid_library_request', 'Bad refs.');
  if (body.generation !== generation) return fail(409, 'stale_generation', 'The library changed.', true);
  await sleep(fixture.searchDelayMs);
  const matcher = compileSearchMatcher(body.query);
  try {
    const hits = [];
    const unavailable = [];
    for (const ref of body.refs) {
      const doc = docs.find((candidate) => candidate.id === ref.id && candidate.version === ref.version);
      const match = doc ? matcher.match(fields(doc)) : null;
      if (match) hits.push({ id: ref.id, version: ref.version, ...match });
      else unavailable.push(ref);
    }
    return json({ version: 1, generation, hits, remaining: [], unavailable });
  } finally {
    matcher.dispose();
  }
}

// ---- Public fixture: inert HTML for sandboxed thumbnails ---------------------------------------
const thumbnails = [];
const publicServer = createServer((request, response) => {
  thumbnails.push(request.url);
  const match = /^\/([A-Za-z0-9]{8})\/raw$/.exec(request.url);
  if (!match) { response.writeHead(404).end(); return; }
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  response.end(`<!doctype html><title>${match[1]}</title><body style="margin:0;font:22px/1.4 Georgia,serif;background:#f4efe6;color:#1d1d1f"><header style="padding:28px 36px;background:#2f4858;color:#fff"><h1 style="margin:0;font-size:34px">Brief ${match[1]}</h1></header><main style="padding:24px 36px"><p>Fixture thumbnail body.</p></main><script>parent.postMessage('ran','*')</script></body>`);
});

await new Promise((ok) => catalog.listen(0, '127.0.0.1', ok));
await new Promise((ok) => publicServer.listen(0, ok)); // Dual-stack: "localhost" may resolve to ::1.
const cat = `http://127.0.0.1:${catalog.address().port}`;
publicOrigin = `http://localhost:${publicServer.address().port}`;
seed();
assert.equal(docs.length, 5000);

// ---- Browser proof ------------------------------------------------------------------------------
const checks = [];
const metrics = {};
const check = (name, details = {}) => { checks.push({ name, ...details }); console.log(`PASS ${name}`); };
const since = (mark) => log.slice(mark);
const isThumbnail = (url) => url.startsWith(publicOrigin);
const browser = await chromium.launch({ headless: true });
const pageErrors = [];
const watch = async (context) => {
  await context.addInitScript(() => {
    window.__workers = 0;
    window.__alerted = 0;
    const Original = window.Worker;
    window.Worker = function Worker(...args) { window.__workers++; return new Original(...args); };
    window.alert = () => { window.__alerted = 'alert'; };
  });
};
const shot = (page, name) => page.screenshot({ path: resolve(output, 'screenshots', `${name}.png`) });
const selectAll = (page) => page.locator('.select-group button', { hasText: /^Select all/ });

try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await watch(context);
  const page = await context.newPage();
  page.on('pageerror', (error) => pageErrors.push(String(error)));
  const browserRequests = [];
  page.on('request', (request) => browserRequests.push({ url: request.url(), method: request.method(), type: request.resourceType() }));

  // 1. Fresh browser: login, then the whole 5k metadata snapshot.
  let mark = log.length;
  let started = Date.now();
  await page.goto(`${cat}/all-docs`);
  await page.getByLabel('Password', { exact: true }).fill('fixture-password');
  await page.getByRole('button', { name: 'Unlock', exact: true }).click();
  await page.waitForFunction(() => /^5,000 files/.test(document.querySelector('.display-2')?.textContent ?? ''), null, { timeout: 30000 });
  metrics.freshOpenMs = Date.now() - started;
  await page.waitForTimeout(500);
  const fresh = since(mark);
  const freshBrowser = browserRequests.filter((request) => !isThumbnail(request.url));
  metrics.freshRequests = fresh.map((entry) => `${entry.method} ${entry.path}`);
  assert(freshBrowser.length <= 16, `fresh open made ${freshBrowser.length} non-thumbnail requests: ${freshBrowser.map((r) => r.url).join(', ')}`);
  assert.equal(fresh.filter((entry) => entry.path.startsWith('/all-docs/api/documents')).length, 10);
  assert.equal(fresh.filter((entry) => entry.path.includes('/text')).length, 0);
  assert.equal(fresh.filter((entry) => entry.path.includes('search-worker')).length, 0);
  assert.equal(fresh.filter((entry) => entry.method === 'POST' && entry.path.startsWith('/all-docs/api/')).length, 0);
  assert.equal(await page.evaluate(() => window.__workers), 0);
  await shot(page, 'desktop-light-fresh');
  check('fresh 5k open: ≤~15 non-thumbnail requests, 10 metadata pages, zero /text, no Worker or search-worker asset', {
    nonThumbnailRequests: freshBrowser.length, catalogRequests: fresh.length, ms: metrics.freshOpenMs,
  });

  // 2. Warm reload: the signed session survives; nothing is extracted or rebuilt.
  mark = log.length;
  browserRequests.length = 0;
  started = Date.now();
  await page.reload();
  await page.waitForFunction(() => /^5,000 files/.test(document.querySelector('.display-2')?.textContent ?? ''), null, { timeout: 30000 });
  metrics.warmReloadMs = Date.now() - started;
  await page.waitForTimeout(300);
  const warm = since(mark);
  const warmBrowser = browserRequests.filter((request) => !isThumbnail(request.url));
  metrics.warmRequests = warm.map((entry) => `${entry.method} ${entry.path}`);
  assert(warmBrowser.length <= 15, `warm reload made ${warmBrowser.length} non-thumbnail requests`);
  assert.equal(warm.filter((entry) => entry.path.includes('/text') || entry.path.includes('search-worker')).length, 0);
  assert.equal(await page.evaluate(() => window.__workers), 0);
  check('warm reload: session reused, 10 metadata pages, zero /text, no Worker', { nonThumbnailRequests: warmBrowser.length, ms: metrics.warmReloadMs });

  // 3. Typing: one debounced POST per pause, query only in the body, no re-listing.
  mark = log.length;
  const searchBodies = [];
  const onRequest = (request) => {
    if (request.url().endsWith('/all-docs/api/search')) searchBodies.push(JSON.parse(request.postData()));
  };
  page.on('request', onRequest);
  await page.locator('#search').click();
  await page.keyboard.type('invoice', { delay: 40 });
  await page.waitForFunction(() => /^Complete|^Search finished/.test(document.querySelector('.coverage span')?.textContent ?? ''), null, { timeout: 15000 });
  await page.waitForFunction(() => document.querySelector('article[data-id="Hostile1"] .snippet mark'), null, { timeout: 10000 });
  const typing = since(mark);
  assert.equal(searchBodies.length, 1, `typing sent ${searchBodies.length} searches`);
  assert.deepEqual(searchBodies[0], { version: 1, query: { text: 'invoice', mode: 'literal', ignoreCase: true }, filter: { kinds: [], uploadedBefore: null, uploadedAfter: null } });
  assert(typing.every((entry) => !entry.path.includes('invoice')), 'query text never appears in a URL');
  assert.equal(typing.filter((entry) => entry.method === 'GET' && entry.path.startsWith('/all-docs/api/documents')).length, 0);
  const snippetCalls = typing.filter((entry) => entry.path === '/all-docs/api/snippets').length;
  assert(snippetCalls >= 1 && snippetCalls <= 2, `snippet calls ${snippetCalls}`);
  check('typing "invoice": one debounced search POST, snippets for visible cards only, no metadata re-read', {
    searches: searchBodies.length, snippetCalls, requests: typing.map((entry) => `${entry.method} ${entry.path}`),
  });

  // 4. Inert snippets: hostile markup renders as text with only <mark> highlights.
  const hostile = await page.evaluate(() => {
    const snippet = document.querySelector('article[data-id="Hostile1"] .snippet');
    return { text: snippet?.textContent, elements: [...(snippet?.querySelectorAll('*') ?? [])].map((el) => el.tagName),
      marks: [...(snippet?.querySelectorAll('mark') ?? [])].map((el) => el.textContent), alerted: window.__alerted };
  });
  assert(hostile.text.includes('<img src=x onerror='), 'markup stays literal text');
  assert(hostile.elements.every((tag) => tag === 'MARK'), `snippet elements ${hostile.elements}`);
  assert.deepEqual(hostile.marks, ['invoice']);
  assert.equal(hostile.alerted, 0);
  const pendingCard = await page.locator('article[data-id="Pending1"]').innerText();
  assert.match(pendingCard, /content not indexed yet · name searched/);
  assert.match(pendingCard, /paused: index size budget/);
  const coverageLine = await page.locator('.coverage span').innerText();
  assert.match(coverageLine, /not indexed yet \(searched by name\)/);
  assert.match(coverageLine, /couldn't be indexed \(searched by name\)/);
  assert.match(coverageLine, /content indexing paused by the index size budget/);
  assert.match(await page.locator('#select-all-reason').innerText(), /isn't indexed yet|aren't indexed yet/);
  await shot(page, 'desktop-light-search');
  check('snippet ranges render as inert text with <mark>; pending/failed/paused coverage disclosed; select all gated', { hostile, coverageLine });

  // 5. Coalescing: while one search runs, newer keystrokes wait and only the latest is sent.
  fixture.searchDelayMs = 500;
  searchBodies.length = 0;
  searchPlane.max = 0;
  await page.locator('#search').fill('');
  await page.waitForTimeout(300);
  await page.locator('#search').click();
  await page.keyboard.type('pai', { delay: 30 });
  await page.waitForTimeout(260); // Debounce fires: "pai" is now in flight for 500 ms.
  await page.keyboard.type('d in', { delay: 30 });
  await page.waitForTimeout(260);
  await page.keyboard.type(' full', { delay: 30 });
  await page.waitForFunction(() => /^Complete|^Search finished/.test(document.querySelector('.coverage span')?.textContent ?? '')
    && document.querySelector('#search').value === 'paid in full', null, { timeout: 15000 });
  await page.waitForTimeout(800);
  const coalesced = searchBodies.map((body) => body.query.text);
  assert.equal(coalesced[0], 'pai');
  assert.equal(coalesced.at(-1), 'paid in full');
  assert(coalesced.length <= 3, `coalesced searches ${coalesced}`);
  assert.equal(searchPlane.max, 1, 'never two search-plane requests in flight');
  fixture.searchDelayMs = 60;
  check('coalescing: one search-plane request in flight; intermediate input skipped; latest wins', { sent: coalesced, maxInFlight: searchPlane.max });

  // 6. Progressive regex: understandable scanning state, gates wait for completion.
  searchBodies.length = 0;
  await page.locator('#search').fill('');
  await page.locator('button[aria-label="Regular expression (RE2)"]').click();
  await page.locator('#search').fill('pa[iy]d');
  await page.waitForFunction(() => /^Searching cached content…/.test(document.querySelector('.coverage span')?.textContent ?? ''), null, { timeout: 10000 });
  const scanning = await page.evaluate(() => ({
    coverage: document.querySelector('.coverage span')?.textContent, bar: !!document.querySelector('.coverage progress'),
    selectAll: [...document.querySelectorAll('.select-group button')].find((b) => b.textContent.startsWith('Select all'))?.disabled,
    reason: document.querySelector('#select-all-reason')?.textContent, label: document.querySelector('#results-label')?.textContent,
  }));
  assert.equal(scanning.selectAll, true);
  assert.equal(scanning.reason, 'Available when the search finishes');
  assert(scanning.bar);
  assert.match(scanning.label, /so far/);
  await shot(page, 'desktop-light-progressive');
  await page.waitForFunction(() => /^Search finished/.test(document.querySelector('.coverage span')?.textContent ?? ''), null, { timeout: 20000 });
  const slices = searchBodies.length;
  assert.equal(slices, 5, `5k docs / 1000-doc slices = 5 requests, saw ${slices}`);
  assert.deepEqual(searchBodies.map((body) => body.cursor ?? null), [null, `g${generation}s1000`, `g${generation}s2000`, `g${generation}s3000`, `g${generation}s4000`]);
  check('progressive regex: "Searching cached content…" with partial counts, select all waits, continuations carry the cursor', { scanning, slices });

  // 7. Select all requires a clean scope; the frozen review sends exact refs in ≤100 batches.
  await page.locator('.rail input[data-kind="text"]').check();
  await page.waitForFunction(() => [...document.querySelectorAll('.select-group button')].some((b) => /^Select all [\d,]+ matching$/.test(b.textContent) && !b.disabled), null, { timeout: 10000 });
  const selectLabel = await selectAll(page).innerText();
  const selectedCount = Number(selectLabel.match(/[\d,]+/)[0].replace(/,/g, ''));
  await selectAll(page).click();
  await page.getByRole('button', { name: 'Review deletion' }).click();
  await page.locator('#confirm-count').fill(String(selectedCount));
  await page.getByRole('button', { name: `Delete ${selectedCount.toLocaleString('en-US')} documents` }).click();
  await page.waitForFunction(() => /^Deleted/.test(document.querySelector('#review-title')?.textContent ?? ''), null, { timeout: 15000 });
  assert(deletes.length >= 1 && deletes.every((batch) => batch.items.length <= 100));
  assert(deletes.every((batch) => JSON.stringify(Object.keys(batch).sort()) === JSON.stringify(['confirmCount', 'confirmation', 'items', 'version'])));
  assert.equal(deletes.reduce((sum, batch) => sum + batch.items.length, 0), selectedCount);
  await page.getByRole('button', { name: 'Done' }).click();
  for (const batch of deletes) for (const item of batch.items) docs.splice(docs.findIndex((doc) => doc.id === item.id), 1);
  generation++; // The server's own deletions are a visible change.
  check('select all only with a clean filtered scope; review sends frozen ID/version batches ≤100, never a query', {
    selected: selectedCount, batches: deletes.map((batch) => batch.items.length),
  });

  // 8. A newer generation prompts Refresh; Refresh restores the gate.
  await page.locator('.rail input[data-kind="text"]').uncheck();
  await page.locator('button[aria-label="Regular expression (RE2)"]').click();
  await page.locator('#search').fill('review');
  await page.waitForFunction(() => /library changed since it loaded/.test(document.querySelector('.banner')?.textContent ?? ''), null, { timeout: 15000 });
  await page.locator('.rail input[data-kind="data"]').check();
  await page.waitForFunction(() => /Refresh to select all matching/.test(document.querySelector('#select-all-reason')?.textContent ?? ''), null, { timeout: 5000 });
  await page.locator('.banner button', { hasText: 'Refresh' }).click();
  await page.waitForFunction(() => document.querySelector('.banner')?.hidden
    && [...document.querySelectorAll('.select-group button')].some((b) => /^Select all [\d,]+ matching$/.test(b.textContent) && !b.disabled), null, { timeout: 20000 });
  await page.locator('.rail input[data-kind="data"]').uncheck();
  check('newer library generation shows the Refresh notice and blocks select all until Refresh');

  // 9. Keyboard: Esc clears then moves to the cards, arrows move focus, x selects, / returns.
  await page.locator('#search').click();
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.querySelector('#search').value === '' && !document.querySelector('.coverage:not([hidden])'));
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.activeElement?.closest('article'));
  const focusFirst = await page.evaluate(() => document.activeElement?.closest('article')?.dataset.id ?? null);
  await page.keyboard.press('ArrowRight');
  const focusSecond = await page.evaluate(() => document.activeElement?.closest('article')?.dataset.id ?? null);
  await page.keyboard.press('x');
  // Renders are batched per animation frame: wait for the painted state, not the keypress.
  await page.waitForFunction(() => document.querySelectorAll('article.card.selected').length === 1, null, { timeout: 5000 });
  const selected = await page.evaluate(() => document.querySelectorAll('article.card.selected').length);
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.querySelectorAll('article.card.selected').length === 0, null, { timeout: 5000 });
  await page.keyboard.press('/');
  const focusSearch = await page.evaluate(() => document.activeElement?.id);
  assert(focusFirst && focusSecond && focusFirst !== focusSecond);
  assert.equal(selected, 1);
  assert.equal(focusSearch, 'search');
  check('keyboard: Esc to cards, arrows move focus, x selects, / focuses search', { focusFirst, focusSecond });

  // 10. Inert thumbnails stay sandboxed and script-free.
  const frames = await page.evaluate(() => [...document.querySelectorAll('.preview iframe')].slice(0, 3).map((frame) => ({
    sandbox: frame.getAttribute('sandbox'), referrer: frame.getAttribute('referrerpolicy'), inert: frame.closest('.preview')?.inert,
  })));
  assert(frames.length > 0, 'HTML cards attach preview frames');
  assert(frames.every((frame) => frame.sandbox === '' && frame.inert === true));
  check('HTML thumbnails are inert, fully sandboxed frames of the public origin', { frames: frames.length });

  // 11. Dark theme and mobile width keep the card design without horizontal scroll.
  await page.locator('.head-actions .theme-toggle').click();
  await page.locator('#search').fill('invoice');
  await page.waitForFunction(() => document.querySelector('article .snippet mark'), null, { timeout: 10000 });
  await shot(page, 'desktop-dark-search');
  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await watch(mobile);
  const phone = await mobile.newPage();
  phone.on('pageerror', (error) => pageErrors.push(String(error)));
  await phone.goto(`${cat}/all-docs#q=invoice`);
  await phone.getByLabel('Password', { exact: true }).fill('fixture-password');
  await phone.getByRole('button', { name: 'Unlock', exact: true }).click();
  await phone.waitForFunction(() => document.querySelector('article .snippet mark'), null, { timeout: 30000 });
  const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert(overflow <= 0, `mobile horizontal overflow ${overflow}px`);
  await shot(phone, 'mobile-light-search');
  await phone.locator('.head-actions .theme-toggle').click();
  await shot(phone, 'mobile-dark-search');
  assert.equal(await phone.evaluate(() => window.__workers), 0);
  check('mobile 390px and dark theme render the existing card design without horizontal scroll', { overflow });

  // 12. Lock removes every private title and snippet from the page.
  await page.getByRole('button', { name: 'Lock', exact: true }).click();
  await page.waitForFunction(() => document.documentElement.dataset.view === 'login');
  const leftovers = await page.evaluate(() => ({ cards: document.querySelectorAll('article[data-id]').length, text: document.getElementById('library')?.textContent ?? '' }));
  assert.equal(leftovers.cards, 0);
  assert(!/invoice|Hostile/i.test(leftovers.text));
  check('lock clears cards, hits and snippets from the DOM');

  assert.deepEqual(pageErrors, []);
  assert.equal(log.filter((entry) => entry.path.includes('/text')).length, 0);
  metrics.totalCatalogRequests = log.length;
  metrics.thumbnailRequests = thumbnails.length;
  metrics.textRequests = 0;
  metrics.workers = 0;
  await writeFile(resolve(output, 'results.json'), JSON.stringify({
    kind: 'frozen-HTTP fixture proof (loopback server implementing library-contracts.ts; NOT the integrated Worker+D1 backend)',
    documents: 5000, checks, metrics, screenshots: resolve(output, 'screenshots'), at: new Date().toISOString(),
  }, null, 2));
  console.log(`\n${checks.length} checks passed; results in ${resolve(output, 'results.json')}`);
} catch (error) {
  await writeFile(resolve(output, 'results.json'), JSON.stringify({ failed: String(error?.stack ?? error), checks, metrics, pageErrors }, null, 2));
  throw error;
} finally {
  await browser.close();
  catalog.close();
  publicServer.close();
}
