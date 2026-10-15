import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Miniflare } from 'miniflare';
import { chromium } from 'playwright';

/**
 * Focused real-browser proof for catalog card previews (docs-card-polish).
 *
 * Runs the built Worker bundle unchanged in workerd as both roles on their own loopback ports,
 * with one disposable native R2 bucket, plus a stand-in third-party origin on [::1] that logs what
 * framed documents fetch from it. Headless Chromium with an isolated profile drives the real UI.
 * Nothing here touches production, owner documents, or the shared integration ports/state.
 *
 *   catalog  http://localhost:18898   (trusted shell, session cookie, CSP frame-src = public)
 *   public   http://127.0.0.1:18897   (/ID/raw framed by cards; uploads seeded directly into R2)
 *   external http://[::1]:18899       (subresources, nested frame, a request that never answers)
 *
 * Usage: node scripts/build.mjs && node scripts/card-polish-proof.mjs [--serve]
 * Output: .wrangler/card-polish-proof/{results.json,screenshots/*.png}
 * --serve keeps the seeded fixture origins running after a passing proof (nothing is deleted by
 * the proof) and writes server.json with the origins, disposable password and stop command.
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const state = resolve(root, '.wrangler/card-polish-proof');
const pub = 'http://127.0.0.1:18897';
const cat = 'http://localhost:18898';
const ext = 'http://[::1]:18899';
const password = 'disposable-card-proof-password';
const sessionKey = 'disposable-card-proof-session-key-32-bytes';
// Mirrors card-preview.ts; asserted against the live page, not assumed.
const MAX_PENDING = 6, MAX_LIVE = 36, REVEAL_MS = 4000, PREVIEW_MAX_BYTES = 2 * 1024 * 1024;
const serve = process.argv.includes('--serve');
const SENTINEL = 'HOSTILE-SENTINEL-7f3a';

await rm(state, { recursive: true, force: true });
await mkdir(resolve(state, 'screenshots'), { recursive: true });

// ---- Stand-in third-party origin ---------------------------------------------------------------
const external = [];
const stalled = [];
const extServer = http.createServer((req, res) => {
  external.push({ path: req.url, referer: req.headers.referer ?? null, cookie: req.headers.cookie ?? null, at: Date.now() });
  if (req.url.startsWith('/stall')) { stalled.push(res); return; } // Never answers: holds the frame's load event.
  if (req.url.startsWith('/pixel.svg')) {
    res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
    res.end('<svg xmlns="http://www.w3.org/2000/svg" width="320" height="80"><rect width="320" height="80" fill="#e4572e"/></svg>');
    return;
  }
  if (req.url.startsWith('/nested.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<!doctype html><body style="margin:0;background:#2e86ab;color:#fff;font:24px sans-serif"><p>nested external frame</p><script>fetch('${ext}/nested-script-ran');document.body.dataset.ran='1'</script></body>`);
    return;
  }
  res.writeHead(404).end();
});
await new Promise((ok) => extServer.listen(18899, '::1', ok));

// ---- Disposable fixtures -----------------------------------------------------------------------
const brief = (name, accent, ground, ink, extra = '') => `<!doctype html><html><head><meta charset="utf-8"><title>${name}</title><style>
body{margin:0;background:${ground};color:${ink};font:17px/1.55 -apple-system,Segoe UI,Helvetica,sans-serif}
header{padding:56px 72px 40px;background:${accent};color:#fff}header p{margin:0;opacity:.8;font-size:15px;letter-spacing:.08em;text-transform:uppercase}
h1{margin:8px 0 0;font-size:46px;line-height:1.1}main{padding:40px 72px;max-width:900px}h2{font-size:24px;margin:36px 0 8px}
table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #ccc;padding:10px;text-align:left}.tag{display:inline-block;padding:4px 10px;border-radius:99px;background:${accent};color:#fff;font-size:13px}
</style></head><body><header><p>Customer brief · Oct 14</p><h1>${name}</h1></header><main><span class="tag">BrowserOS user</span>
<h2>Context</h2><p>Runs a five person data team and evaluates agentic browsers for repetitive research.</p>
<h2>Talking points</h2><ul><li>Scheduled tasks and local models</li><li>Privacy story for regulated customers</li><li>Pricing for teams</li></ul>${extra}
<h2>Notes</h2><p>${'Follow up with the onboarding checklist and share the deck. '.repeat(12)}</p></main></body></html>`;

const hostile = `<!doctype html><html data-hostile-marker="${SENTINEL}"><head><title>Hostile preview fixture</title>
<meta http-equiv="refresh" content="0;url=${pub}/Hostile1/download">
<link rel="stylesheet" href="${cat}/all-docs/api/documents">
<style>body{margin:0;background:#fff3b0;font:22px sans-serif}a#cover{position:fixed;inset:0;display:block;background:rgba(255,0,0,.08)}</style></head>
<body><h1>Hostile preview fixture</h1>
<script>
document.documentElement.dataset.pwned = 'script-ran';
try { localStorage.setItem('pwned', '1'); } catch (e) {}
try { document.cookie = 'pwned=1'; } catch (e) {}
try { parent.postMessage({ pwned: true }, '*'); } catch (e) {}
try { window.open('${pub}/popup'); } catch (e) {}
fetch('${cat}/all-docs/api/documents', { credentials: 'include' }).catch(() => {});
try { top.location = '${pub}/top-navigation'; } catch (e) {}
</script>
<form action="${cat}/all-docs/api/delete" method="post"><input name="items" value="[]" autofocus><button>Delete everything</button></form>
<a id="cover" href="${cat}/all-docs#q=pwned" target="_top">covering top-level link</a>
<img src="${cat}/all-docs/api/documents" alt=""><img src="${ext}/pixel.svg?from=hostile" alt="">
<iframe src="${cat}/all-docs" width="300" height="120"></iframe>
<iframe src="${ext}/nested.html" width="300" height="120"></iframe>
</body></html>`;

const fixtures = new Map(); // id -> { filename, title, kind, preview }
async function seed(mf) {
  const bucket = await mf.getR2Bucket('DOCS_BUCKET', 'public');
  const put = async (id, filename, body, title, contentType, preview = false) => {
    await bucket.put(`${id}/${filename}`, body, { customMetadata: { filename, contentType, docName: title } });
    fixtures.set(id, { filename, title, preview });
  };
  // Oldest first: uploads are listed newest first, so the special cases land on the first screen.
  for (let i = 0; i < 60; i++) {
    const n = String(i).padStart(4, '0');
    await put(`Bulk${n}`, `bulk-${n}.html`, brief(`Bulk brief ${n}`, ['#3d5a80', '#6d597a', '#2a9d8f'][i % 3], '#ffffff', '#1d1d1f'), `Bulk brief ${n}`, 'text/html', true);
  }
  await put('BigHtml1', 'oversized.html', `<!doctype html><title>Oversized</title><p>${'x'.repeat(PREVIEW_MAX_BYTES + 4096)}</p>`, 'Oversized HTML export', 'text/html');
  await put('ZipArch1', 'archive.zip', new Uint8Array([80, 75, 5, 6, ...new Array(18).fill(0)]), 'Quarterly archive', 'application/zip');
  await put('PdfDoc01', 'statement.pdf', '%PDF-1.4\n%%EOF\n', 'Bank statement', 'application/pdf');
  await put('DataJs01', 'vendors.json', '{"vendors":[{"name":"Acme","status":"active"}]}', 'Vendor list', 'application/json');
  await put('TextLog1', 'build.log', 'build started\nbuild finished in 41s\n', 'Build log', 'text/plain');
  await put('LongMeta', `${'very-long-generated-filename-segment-'.repeat(6)}final.md`, '# Long metadata\n\nBody', `Brief: ${'Extremely long customer name and company description '.repeat(4)}· Thu Oct 15, 11:00am PT`, 'text/markdown');
  await put('MdNote01', 'dpdp-notes.md', '# DPDP notes\n\nCompactBodySentinel lives in markdown.\n\n- consent manager\n- breach reporting', 'DPDP vendor notes', 'text/markdown');
  await bucket.put('Group001/a.html', brief('Multi-object brief', '#264653', '#ffffff', '#111'), { customMetadata: { filename: 'a.html', contentType: 'text/html', docName: 'Multi-object brief' } });
  await bucket.put('Group001/b.html', '<p>secondary object</p>');
  fixtures.set('Group001', { filename: 'a.html', title: 'Multi-object brief', preview: true });
  await put('ScriptGn', 'app-shell.html', `<!doctype html><title>Script app</title><body><div id="app"></div><script>document.getElementById('app').innerHTML='<h1 style="font:48px sans-serif">Rendered by JavaScript</h1>'</script></body>`, 'Script-generated dashboard', 'text/html', true);
  await put('Stalled1', 'stalled.html', brief('Stalled subresource brief', '#9c6644', '#fffaf3', '#2b2118', `<img src="${ext}/stall.png" width="10" height="10" alt="">`), 'Stalled subresource brief', 'text/html', true);
  await put('Visual03', 'table-brief.html', brief('Roy (BrowserOS user call)', '#5f0f40', '#ffffff', '#1d1d1f', '<h2>Pipeline</h2><table><tr><th>Stage</th><th>Owner</th></tr><tr><td>Pilot</td><td>Roy</td></tr><tr><td>Security review</td><td>IT</td></tr></table>'), 'Brief: Roy (BrowserOS user call) · Thu Oct 15, 11:00am PT', 'text/html', true);
  await put('Visual02', 'dark-brief.html', brief('Bhanu Valapali (Yubi)', '#ff7a59', '#15151a', '#ececf1'), 'Brief: Bhanu Valapali (Yubi) · Thu Oct 15, 7:30pm PT', 'text/html', true);
  await put('Hostile1', 'attack.html', hostile, 'Hostile preview fixture', 'text/html', true);
  await put('Visual01', 'william.html', brief('William Stuart (BrowserOS user)', '#2458e6', '#ffffff', '#111111', `<p>PreviewBodySentinel appears only in this brief.</p><p><img src="${ext}/pixel.svg?from=visual" alt=""></p>`), 'Brief: William Stuart (BrowserOS user) · Wed Oct 14, 8:30pm PT', 'text/html', true);
}

function runtime() {
  const common = { modules: true, scriptPath: resolve(root, '.wrangler/build/index.js'), compatibilityDate: '2024-12-01',
    r2Buckets: { DOCS_BUCKET: 'local-docs' }, outboundService: () => { throw new Error('Proof Workers may not fetch externally'); } };
  return new Miniflare({ host: '127.0.0.1', port: 18897, cf: false, r2Persist: resolve(state, 'r2'), cachePersist: false, workers: [
    { ...common, name: 'public', bindings: { APP_ROLE: 'public', PUBLIC_DOCS_ORIGIN: pub, CATALOG_ORIGIN: cat, AUTH_TOKEN: 'disposable-card-proof-token' } },
    { ...common, name: 'catalog', unsafeDirectSockets: [{ host: '127.0.0.1', port: 18898 }],
      bindings: { APP_ROLE: 'catalog', PUBLIC_DOCS_ORIGIN: pub, CATALOG_ORIGIN: cat, ALL_DOCS_PASSWORD: password, CATALOG_SESSION_KEY: sessionKey } },
  ] });
}

// ---- Browser proof -----------------------------------------------------------------------------
const checks = [];
const metrics = {};
const check = (name, details = {}) => { checks.push({ name, ...details }); console.log(`PASS ${name}`); };
const mf = runtime();
await mf.ready;
await seed(mf);
const browser = await chromium.launch({ headless: true, channel: 'chromium' });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, permissions: ['clipboard-read', 'clipboard-write'], acceptDownloads: true });
context.setDefaultTimeout(20000);
const downloads = [], popups = [], pageErrors = [], consoleLines = [], requests = [];
let complete = false;
context.on('page', (p) => popups.push(p.url() || '(pending)'));
const shot = (p, name) => p.screenshot({ path: resolve(state, 'screenshots', `${name}.png`) });

const p = await context.newPage();
popups.length = 0;
await p.addInitScript(() => {
  window.__proof = { violations: [], messages: [] };
  document.addEventListener('securitypolicyviolation', (e) => window.__proof.violations.push({ directive: e.effectiveDirective, blocked: e.blockedURI }));
  window.addEventListener('message', (e) => window.__proof.messages.push(String(e.origin)));
});
p.on('download', (d) => downloads.push(d.url()));
p.on('pageerror', (e) => pageErrors.push(String(e)));
p.on('console', (m) => consoleLines.push(m.text()));
p.on('request', (r) => requests.push({ url: r.url(), type: r.resourceType(), frame: r.frame()?.url() ?? null, request: r, at: Date.now() }));
const catalogBodies = [];
p.on('response', async (r) => {
  if (!r.url().startsWith(cat)) return;
  try { catalogBodies.push({ url: r.url(), body: await r.text() }); } catch { /* redirects / aborted */ }
});

// Concurrency is sampled at the network layer: one entry per in-flight /raw navigation.
const rawInflight = new Set();
let maxRawInflight = 0;
p.on('request', (r) => { if (/\/[A-Za-z0-9]{8}\/raw$/.test(r.url()) && r.resourceType() === 'document') { rawInflight.add(r); maxRawInflight = Math.max(maxRawInflight, rawInflight.size); } });
for (const done of ['requestfinished', 'requestfailed']) p.on(done, (r) => rawInflight.delete(r));
const rawRequests = () => requests.filter((r) => /\/[A-Za-z0-9]{8}\/raw$/.test(r.url) && r.type === 'document');

const previewState = () => p.evaluate(() => {
  const all = [...document.querySelectorAll('.preview')];
  return {
    previews: all.length,
    live: document.querySelectorAll('.preview iframe').length,
    pending: document.querySelectorAll('.preview:is([data-state="loading"], [data-state="revealed"])').length,
    ready: document.querySelectorAll('.preview[data-state="ready"]').length,
    cards: document.querySelectorAll('article[data-id]').length,
  };
});

try {
  // ---- Login and the first screen
  const shell = await p.goto(`${cat}/all-docs`);
  const csp = shell.headers()['content-security-policy'];
  assert.equal(csp, `default-src 'none'; script-src 'self'; style-src 'self'; worker-src 'self'; connect-src 'self'; img-src 'self'; font-src 'self'; frame-src ${pub}; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`);
  assert.equal(shell.headers()['x-frame-options'], 'DENY');
  await p.getByLabel('Password', { exact: true }).fill(password);
  await p.getByRole('button', { name: 'Unlock', exact: true }).click();
  await p.locator('#library-title').waitFor({ state: 'visible' });
  // The sampler watches the live DOM for the whole run: peak loading and live frame counts.
  await p.evaluate(() => {
    window.__proof.maxPending = 0; window.__proof.maxLive = 0;
    const sample = () => {
      window.__proof.maxPending = Math.max(window.__proof.maxPending, document.querySelectorAll('.preview:is([data-state="loading"], [data-state="revealed"])').length);
      window.__proof.maxLive = Math.max(window.__proof.maxLive, document.querySelectorAll('.preview iframe').length);
    };
    new MutationObserver(sample).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-state'] });
  });
  await p.waitForFunction(() => [...document.querySelectorAll('button')].some((e) => /^Select all \d[\d,]* matching$/.test(e.textContent) && !e.disabled), null, { timeout: 60000 });
  await p.waitForFunction(() => document.querySelectorAll('.preview[data-state="ready"]').length >= 4);
  await p.waitForTimeout(REVEAL_MS + 500);
  const first = await previewState();
  const firstRaw = rawRequests().length;
  const eligibleRendered = await p.locator('article[data-preview="live"]').count();
  assert.equal(first.cards, 48);
  assert(first.live > 0 && first.live < eligibleRendered, `lazy: ${first.live} live of ${eligibleRendered} rendered previews`);
  assert.equal(firstRaw, first.live, 'only attached frames fetched /raw');
  await shot(p, 'desktop-light');
  check('CSP adds only frame-src <public origin>; first screen attaches previews lazily', { csp, ...first, eligibleRendered, rawRequests: firstRaw });

  // ---- Card anatomy: frames are exact, sandboxed and inert; everything else is compact
  const anatomy = await p.evaluate(() => [...document.querySelectorAll('article[data-id]')].map((a) => ({
    id: a.dataset.id,
    preview: !!a.querySelector('.preview'),
    attr: a.dataset.preview ?? null,
    kinds: a.querySelectorAll('.kind').length,
    kindText: a.querySelector('.kind')?.textContent,
    legacyWell: a.querySelectorAll('.well, .glyph').length,
    text: a.innerText,
    wrapper: a.querySelector('.preview') && { inert: a.querySelector('.preview').inert, hidden: a.querySelector('.preview').getAttribute('aria-hidden'), text: a.querySelector('.preview').textContent },
    frame: a.querySelector('.preview iframe') && Object.fromEntries([...a.querySelector('.preview iframe').attributes].map((x) => [x.name, x.value])),
  })));
  for (const card of anatomy) {
    const fixture = fixtures.get(card.id);
    assert(fixture, card.id);
    assert.equal(card.preview, fixture.preview, `${card.id} preview eligibility`);
    assert.equal(card.legacyWell, 0);
    assert.equal(card.kinds, 1, `${card.id} names its type once`);
    assert(card.text.includes(card.id) && card.text.includes(fixture.filename.slice(0, 20)), `${card.id} keeps id and filename`);
    assert.match(card.text, /\d+(\.\d+)? (B|KB|MB)/);
    assert.match(card.text, /ago|just now|yesterday/);
    assert.match(card.text, /[A-Z][a-z]{2} \d{1,2}, \d{4}/);
    if (card.preview) {
      assert.deepEqual(card.wrapper, { inert: true, hidden: 'true', text: '' });
      if (card.frame) {
        assert.deepEqual(Object.keys(card.frame).sort(), ['aria-hidden', 'referrerpolicy', 'sandbox', 'src', 'tabindex', 'title']);
        assert.equal(card.frame.sandbox, '');
        assert.equal(card.frame.referrerpolicy, 'no-referrer');
        assert.equal(card.frame.src, `${pub}/${card.id}/raw`);
      }
    }
  }
  const big = anatomy.find((c) => c.id === 'BigHtml1');
  assert.equal(big.preview, false);
  assert.equal(rawRequests().filter((r) => r.url.includes('/BigHtml1/')).length, 0);
  check('every frame is exactly sandbox="" + no-referrer + /ID/raw inside an inert aria-hidden wrapper; non-HTML and >2 MiB HTML are compact; type named once; metadata kept',
    { cards: anatomy.length, previews: anatomy.filter((c) => c.preview).length, compact: anatomy.filter((c) => !c.preview).map((c) => c.id) });

  // ---- Hostile document inside its preview
  await p.waitForFunction(() => document.querySelector('article[data-id="Hostile1"] .preview')?.dataset.state === 'ready');
  await p.waitForTimeout(1500); // Give a meta refresh, popups or scripted navigation time to (not) happen.
  const hostileFrame = p.frames().find((f) => f.url() === `${pub}/Hostile1/raw`);
  assert(hostileFrame, 'hostile frame still at its raw URL (meta refresh refused)');
  assert.equal(p.url().startsWith(`${cat}/all-docs`), true);
  const inside = await hostileFrame.evaluate(() => ({
    pwned: document.documentElement.dataset.pwned ?? null,
    origin: String(self.origin),
    storage: (() => { try { localStorage.length; return 'allowed'; } catch (e) { return e.name; } })(),
    cookie: (() => { try { document.cookie; return 'allowed'; } catch (e) { return e.name; } })(),
    active: document.activeElement?.tagName ?? null,
    focused: document.hasFocus(),
    marker: document.documentElement.getAttribute('data-hostile-marker'),
  }));
  assert.deepEqual(inside, { pwned: null, origin: 'null', storage: 'SecurityError', cookie: 'SecurityError', active: 'BODY', focused: false, marker: SENTINEL });
  const proof = await p.evaluate(() => window.__proof);
  assert.deepEqual(proof.messages, [], 'no postMessage reached the catalog');
  assert.deepEqual(downloads, [], 'meta-refresh download refused');
  assert.deepEqual(popups.filter((u) => u !== `${cat}/all-docs`), [], 'no popup');
  const hostileCatalogRequests = await Promise.all(requests.filter((r) => r.url.startsWith(cat) && r.frame && !r.frame.startsWith(cat))
    .map(async (r) => ({ url: r.url, type: r.type, cookie: (await r.request.allHeaders()).cookie ?? null, status: (await r.request.response())?.status() ?? 'blocked' })));
  assert(hostileCatalogRequests.length >= 2, 'hostile markup did try the catalog');
  for (const r of hostileCatalogRequests) {
    assert.equal(r.cookie, null, `${r.url} carried no catalog cookie`);
    if (r.url.includes('/api/')) assert.notEqual(r.status, 200, `${r.url} must not succeed`);
  }
  const nestedCatalog = p.frames().find((f) => f.parentFrame() === hostileFrame && f.url().startsWith(cat));
  if (nestedCatalog) assert.equal(await nestedCatalog.evaluate(() => document.querySelector('#library-title')).catch(() => null), null);
  assert.equal(catalogBodies.filter((b) => b.body.includes(SENTINEL)).length, 0, 'no catalog response carries uploaded markup');
  assert.equal(await p.evaluate((s) => document.documentElement.outerHTML.includes(s), SENTINEL), false);
  // Pointer: the card link sits over the frame; the frame itself is not hit-testable.
  const hostileBox = await p.locator('article[data-id="Hostile1"] .preview').boundingBox();
  const hit = await p.evaluate(({ x, y }) => { const e = document.elementFromPoint(x, y); return { tag: e.tagName, link: e.closest('h3 a')?.getAttribute('href') ?? null }; }, { x: hostileBox.x + hostileBox.width / 2, y: hostileBox.y + hostileBox.height / 2 });
  assert.deepEqual(hit, { tag: 'A', link: `${pub}/Hostile1` });
  check('hostile HTML preview: script/storage/cookie denied (opaque origin), meta-refresh download, popup, top navigation and postMessage refused, no catalog cookie or API data, no markup on the catalog origin, frame not hit-testable',
    { inside, hostileCatalogRequests, consoleEvidence: consoleLines.filter((l) => /sandboxed|refresh/i.test(l)).slice(0, 6) });

  // ---- External resources and nested frames: allowed to load, but sandboxed and without the catalog URL
  await p.waitForTimeout(500);
  const nestedExt = p.frames().find((f) => f.url() === `${ext}/nested.html`);
  assert(nestedExt, 'nested third-party frame loads inside the preview');
  assert.equal(await nestedExt.evaluate(() => document.body.dataset.ran ?? null), null, 'sandbox flags propagate to nested frames');
  assert.equal(external.some((e) => e.path === '/nested-script-ran'), false);
  assert(external.some((e) => e.path === '/pixel.svg?from=hostile'), 'third-party subresources do load');
  for (const e of external) {
    assert.equal(e.cookie, null);
    assert(!e.referer || (!e.referer.includes('18898') && !e.referer.includes('all-docs')), `referer ${e.referer} never names the catalog`);
  }
  const rawNoReferer = await Promise.all(rawRequests().map(async (r) => (await r.request.allHeaders()).referer ?? null));
  assert(rawNoReferer.every((v) => v === null), 'frame navigations send no Referer');
  check('tradeoff measured: framed pages fetch their own third-party subresources and nested frames (sandboxed, scripts blocked); no Referer on /raw navigations and no catalog URL in any third-party Referer',
    { externalRequests: external.map(({ path, referer }) => ({ path, referer })) });

  // ---- Script-generated page: honest blank preview
  await p.waitForFunction(() => document.querySelector('article[data-id="ScriptGn"] .preview')?.dataset.state === 'ready');
  const scriptFrame = p.frames().find((f) => f.url() === `${pub}/ScriptGn/raw`);
  assert.equal((await scriptFrame.evaluate(() => document.body.innerText)).trim(), '');
  await p.locator('article[data-id="ScriptGn"]').screenshot({ path: resolve(state, 'screenshots', 'script-generated-blank.png') });
  check('script-generated HTML previews blank (no JavaScript runs in previews); documented, not claimed as rendered');

  // ---- Stalled third-party request: shown after REVEAL_MS, still counted as pending
  assert(stalled.length >= 1, 'stalled request is pending');
  const stalledState = await p.locator('article[data-id="Stalled1"] .preview').getAttribute('data-state');
  assert.equal(stalledState, 'revealed');
  assert.equal(await p.locator('article[data-id="Stalled1"] .preview iframe').evaluate((f) => getComputedStyle(f).opacity), '1');
  check('a never-answering subresource cannot keep a painted preview hidden (shown after 4 s) and keeps its pending slot until load or drop', { pendingStalled: stalled.length });

  // ---- Re-render stability: selection patches cards without reloading frames
  await p.evaluate(() => document.querySelectorAll('.preview iframe').forEach((f) => { f.dataset.proofMark = '1'; }));
  const marked = (await previewState()).live;
  const beforeToggle = rawRequests().length;
  await p.locator('article[data-id="Visual02"] input[type=checkbox]').check();
  await p.waitForFunction(() => document.querySelector('.selection-bar .count')?.textContent === '1');
  await p.waitForTimeout(300);
  assert.equal(await p.evaluate(() => document.querySelectorAll('.preview iframe[data-proof-mark="1"]').length), marked);
  assert.equal(rawRequests().length, beforeToggle, 'no frame reloaded on selection');
  assert.equal(await p.locator('article[data-id="Visual02"]').getAttribute('class'), 'card selected');
  await shot(p, 'desktop-selected');
  check('selecting a card patches the grid in place: every live frame survives, zero new /raw requests', { liveFrames: marked });

  // ---- Selection, review and copy without deleting anything
  await p.locator('article[data-id="Visual01"] input[type=checkbox]').click({ modifiers: ['Shift'] });
  await p.waitForFunction(() => Number(document.querySelector('.selection-bar .count')?.textContent) >= 2);
  await p.getByRole('button', { name: 'Clear', exact: true }).click();
  await p.getByRole('button', { name: 'Select page (48)', exact: true }).click();
  assert.equal(await p.locator('.selection-bar .count').innerText(), '48');
  await p.getByRole('button', { name: 'Review deletion', exact: true }).click();
  assert.equal(await p.locator('dialog[open] .review-list li').count(), 48);
  await shot(p, 'desktop-review');
  await p.getByRole('button', { name: 'Cancel', exact: true }).click();
  await p.getByRole('button', { name: 'Clear', exact: true }).click();
  await p.locator('article[data-id="Visual03"]').hover();
  await p.locator('article[data-id="Visual03"] [data-action="delete"]').click();
  assert((await p.locator('dialog[open]').innerText()).includes('Visual03'));
  await p.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal((await fetch(`${pub}/Visual03/raw`)).status, 200, 'nothing deleted');
  await p.locator('article[data-id="Visual01"]').hover();
  await p.locator('article[data-id="Visual01"] [data-action="copy"]').click();
  assert.equal(await p.evaluate(() => navigator.clipboard.readText()), `${pub}/Visual01`);
  assert.equal(await p.locator('article[data-id="Visual01"] .actions a').getAttribute('href'), `${pub}/Visual01/raw`);
  const popupPromise = context.waitForEvent('page');
  const visualBox = await p.locator('article[data-id="Visual01"] .preview').boundingBox();
  await p.mouse.click(visualBox.x + visualBox.width / 2, visualBox.y + visualBox.height / 2);
  const opened = await popupPromise;
  await opened.waitForLoadState('domcontentloaded');
  assert.equal(opened.url(), `${pub}/Visual01`);
  await opened.close();
  check('shift-range and page selection, exact 48-item review, single-card review (cancelled, nothing deleted), copy link, raw link and full-card open from the preview area');

  // ---- Keyboard: Tab never enters a frame; arrows and x still work
  await p.locator('#search').focus();
  const tabbed = [];
  for (let i = 0; i < 40; i++) {
    await p.keyboard.press('Tab');
    tabbed.push(await p.evaluate(() => document.activeElement?.tagName));
  }
  assert(!tabbed.includes('IFRAME'), 'Tab never lands on a frame');
  assert.equal(await hostileFrame.evaluate(() => document.hasFocus()), false);
  await p.locator('article[data-id="Visual01"] h3 a').focus();
  await p.keyboard.press('ArrowRight');
  const nextFocused = await p.evaluate(() => document.activeElement.closest('article')?.dataset.id);
  assert.notEqual(nextFocused, 'Visual01');
  await p.keyboard.press('x');
  await p.waitForFunction(() => document.querySelector('.selection-bar .count')?.textContent === '1');
  await p.keyboard.press('Escape');
  await p.waitForFunction(() => document.querySelector('.selection-bar')?.hidden);
  check('keyboard: 40 Tab stops never focus a frame or its autofocus input; arrow navigation, x select and Escape clear still work', { tabbed: [...new Set(tabbed)] });

  // ---- Search coverage keeps previews for HTML and compact cards for the rest
  const search = p.getByRole('searchbox', { name: 'Search names and content' });
  await search.fill('PreviewBodySentinel');
  await p.waitForFunction(() => document.querySelectorAll('article[data-id]').length === 1 && document.querySelector('.card .matches'));
  assert.equal(await p.locator('article[data-id="Visual01"] .preview').count(), 1);
  assert.match(await p.locator('article[data-id="Visual01"] .snippet').innerText(), /PreviewBodySentinel/);
  await shot(p, 'desktop-search-preview');
  await search.fill('CompactBodySentinel');
  await p.waitForFunction(() => document.querySelectorAll('article[data-id]').length === 1 && document.querySelector('article[data-id="MdNote01"] .snippet'));
  assert.equal(await p.locator('article[data-id="MdNote01"] .preview').count(), 0);
  await search.fill('');
  await p.waitForFunction(() => document.querySelectorAll('article[data-id]').length === 48);
  check('content search: HTML hit keeps its live preview with matches/snippet; Markdown hit stays compact with snippet');

  // ---- Bounded: scroll the whole library (with Show more) and back
  await p.getByRole('button', { name: /^Show \d+ more/ }).click();
  await p.waitForFunction(() => document.querySelectorAll('article[data-id]').length > 48);
  const total = await p.locator('article[data-preview="live"]').count();
  for (let y = 0; y <= (await p.evaluate(() => document.body.scrollHeight)); y += 700) {
    await p.evaluate((top) => scrollTo(0, top), y);
    await p.waitForTimeout(350);
    assert((await previewState()).live <= MAX_LIVE);
  }
  await p.waitForTimeout(REVEAL_MS);
  const bottom = await previewState();
  await p.evaluate(() => scrollTo(0, 0));
  await p.waitForFunction(() => document.querySelector('article[data-id="Visual01"] .preview')?.dataset.state === 'ready', null, { timeout: REVEAL_MS + 6000 });
  const peaks = await p.evaluate(() => ({ maxPending: window.__proof.maxPending, maxLive: window.__proof.maxLive }));
  assert(total > MAX_LIVE, `fixture exceeds the live cap (${total} previews)`);
  assert(peaks.maxLive <= MAX_LIVE && peaks.maxPending <= MAX_PENDING, JSON.stringify(peaks));
  assert(maxRawInflight <= MAX_PENDING, `max concurrent /raw ${maxRawInflight}`);
  Object.assign(metrics, { totalPreviews: total, ...peaks, maxRawInflight, rawRequestsTotal: rawRequests().length, liveAtBottom: bottom.live });
  check('bounded: across all previews the page never exceeded 36 live frames or 6 pending loads, evicted offscreen frames and re-attached them on return', metrics);

  // ---- Themes and responsive layout
  await p.evaluate(() => scrollTo(0, 0));
  await p.getByRole('button', { name: 'Switch to dark theme' }).click();
  await p.waitForTimeout(400);
  await shot(p, 'desktop-dark');
  await p.setViewportSize({ width: 900, height: 1000 });
  await p.waitForTimeout(REVEAL_MS);
  await shot(p, 'tablet-dark');
  const mobile = [];
  for (const width of [375, 320]) {
    for (const theme of ['dark', 'light']) {
      await p.setViewportSize({ width, height: 812 });
      if ((await p.locator('html').getAttribute('data-theme')) !== theme) await p.getByRole('button', { name: `Switch to ${theme} theme` }).click();
      await p.evaluate(() => scrollTo(0, 0));
      await p.waitForTimeout(REVEAL_MS + 300);
      const layout = await p.evaluate(() => {
        const rows = [...document.querySelectorAll('article[data-id]')].slice(0, 12).map((a) => ({
          id: a.dataset.id, preview: !!a.querySelector('.preview'), body: a.querySelector('.body').getBoundingClientRect().left,
          thumb: a.querySelector('.preview')?.getBoundingClientRect().width ?? 0, right: a.getBoundingClientRect().right,
          titleLines: Math.round(a.querySelector('h3').getBoundingClientRect().height / 22),
        }));
        return { overflow: document.documentElement.scrollWidth > innerWidth, rows };
      });
      assert.equal(layout.overflow, false, `${width} ${theme} no horizontal scroll`);
      assert.equal(new Set(layout.rows.map((r) => Math.round(r.body))).size, 1, 'text column aligned on every row');
      for (const row of layout.rows) {
        assert(row.preview ? row.thumb > 0 && row.thumb <= 80 : row.thumb === 0, `${row.id} thumb ${row.thumb}`);
        assert(row.titleLines <= 2);
      }
      await shot(p, `mobile-${width}-${theme}`);
      mobile.push({ width, theme, rows: layout.rows.length });
    }
  }
  await p.setViewportSize({ width: 1440, height: 1000 });
  await p.getByRole('button', { name: 'Switch to dark theme' }).click().catch(() => {});
  await search.fill('Long metadata');
  await p.waitForFunction(() => document.querySelector('article[data-id="LongMeta"]') && document.querySelectorAll('article[data-id]').length === 1);
  const longCard = await p.evaluate(() => { const a = document.querySelector('article[data-id="LongMeta"]'); return { lines: Math.round(a.querySelector('h3').getBoundingClientRect().height / 22), overflow: a.scrollWidth > a.clientWidth }; });
  assert(longCard.lines <= 2 && !longCard.overflow);
  await shot(p, 'desktop-dark-long-metadata');
  await search.fill('');
  await p.getByRole('button', { name: 'Switch to light theme' }).click().catch(() => {});
  check('light/dark at 1440, 900, 375 and 320: no horizontal scroll, aligned text column, ≤80px mobile thumbnails only on HTML rows, compact rows elsewhere, long metadata clamped', { mobile, longCard });

  // ---- Loading state (delayed /raw) and lock teardown
  const slow = await context.newPage();
  await slow.route(`${pub}/Visual01/raw`, async (route) => { await new Promise((ok) => setTimeout(ok, 2500)); await route.continue(); });
  await slow.goto(`${cat}/all-docs`);
  await slow.locator('#library-title').waitFor({ state: 'visible' });
  await slow.waitForFunction(() => document.querySelector('article[data-id="Visual01"] .preview')?.dataset.state === 'loading');
  await slow.locator('article[data-id="Visual01"]').screenshot({ path: resolve(state, 'screenshots', 'loading-state.png') });
  await slow.waitForFunction(() => document.querySelector('article[data-id="Visual01"] .preview')?.dataset.state === 'ready', null, { timeout: 10000 });
  await slow.getByRole('button', { name: 'Lock', exact: true }).click();
  await slow.locator('#password').waitFor({ state: 'visible' });
  assert.equal(await slow.locator('iframe').count(), 0, 'lock tears every frame down');
  await slow.close();
  check('loading state shows the quiet well until the frame loads; Lock removes every preview frame');

  // ---- Held-open /raw responses: the pending budget is not released by the reveal timer
  const held = await context.newPage();
  const heldRoutes = [];
  await held.route(/\/[A-Za-z0-9]{8}\/raw$/, (route) => { heldRoutes.push(route); });
  await held.goto(`${cat}/all-docs`);
  await held.locator('#library-title').waitFor({ state: 'visible' });
  await held.waitForFunction((n) => document.querySelectorAll('.preview iframe').length === n, MAX_PENDING);
  await held.waitForTimeout(REVEAL_MS + 2000);
  const heldState = await held.evaluate(() => ({
    frames: document.querySelectorAll('.preview iframe').length,
    visiblePreviews: [...document.querySelectorAll('.preview')].filter((e) => { const r = e.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight; }).length,
  }));
  assert.equal(heldState.frames, MAX_PENDING, 'no frame beyond the pending budget while /raw is held open');
  assert.equal(heldRoutes.length, MAX_PENDING);
  assert(heldState.visiblePreviews > MAX_PENDING, 'more previews were waiting');
  for (const route of heldRoutes.splice(0)) await route.continue();
  await held.unroute(/\/[A-Za-z0-9]{8}\/raw$/);
  await held.waitForFunction((n) => document.querySelectorAll('.preview iframe').length > n, MAX_PENDING);
  await held.close();
  check('held-open /raw responses: exactly 6 frames attach and stay pending past the reveal delay; the rest attach only after those load', heldState);

  // ---- Unobservable frame failure: an aborted /raw still fires load; the card stays usable
  const failing = await context.newPage();
  const failingErrors = [];
  failing.on('pageerror', (e) => failingErrors.push(String(e)));
  await failing.route(`${pub}/Visual02/raw`, (route) => route.abort('connectionrefused'));
  await failing.goto(`${cat}/all-docs`);
  await failing.locator('#library-title').waitFor({ state: 'visible' });
  await failing.waitForFunction(() => ['Visual01', 'Visual02'].every((id) => document.querySelector(`article[data-id="${id}"] .preview`)?.dataset.state === 'ready'));
  const timing = await failing.evaluate((urls) => urls.map((url) => {
    const entry = performance.getEntriesByName(url)[0];
    return entry && { url, initiator: entry.initiatorType, status: entry.responseStatus, transfer: entry.transferSize, decoded: entry.decodedBodySize };
  }), [`${pub}/Visual01/raw`, `${pub}/Visual02/raw`]);
  assert.deepEqual({ ...timing[0], url: null }, { ...timing[1], url: null }, 'success and failure look identical to the embedder');
  const failedCard = failing.locator('article[data-id="Visual02"]');
  assert.equal(await failedCard.locator('h3 a').getAttribute('href'), `${pub}/Visual02`);
  assert.equal(await failedCard.locator('[data-action="copy"], [data-action="delete"]').count(), 2);
  await failedCard.screenshot({ path: resolve(state, 'screenshots', 'raw-failure-card.png') });
  assert.deepEqual(failingErrors, []);
  await failing.close();
  const rawHeaders = (await fetch(`${pub}/Visual01/raw`)).headers;
  assert.equal(rawHeaders.get('x-frame-options'), null);
  assert(!/frame-ancestors/i.test(rawHeaders.get('content-security-policy') ?? ''));
  check('an aborted /raw is indistinguishable from success to the catalog (same load event, same zeroed Resource Timing); the card keeps its link and actions and the pending slot is released; public raw responses do not forbid framing', { timing });

  // ---- CSP refusal fallback: a deployment without frame-src degrades to compact cards
  const strict = await context.newPage();
  const strictViolations = [];
  await strict.addInitScript(() => { window.__v = []; document.addEventListener('securitypolicyviolation', (e) => window.__v.push(e.effectiveDirective)); });
  await strict.route(`${cat}/all-docs`, async (route) => {
    const response = await route.fetch();
    const headers = { ...response.headers(), 'content-security-policy': response.headers()['content-security-policy'].replace(/frame-src [^;]+; /, '') };
    await route.fulfill({ response, headers });
  });
  await strict.goto(`${cat}/all-docs`);
  await strict.getByLabel('Password', { exact: true }).fill(password);
  await strict.getByRole('button', { name: 'Unlock', exact: true }).click();
  await strict.locator('#library-title').waitFor({ state: 'visible' });
  await strict.waitForFunction(() => window.__v.includes('frame-src') && document.querySelectorAll('.preview').length === 0, null, { timeout: 15000 });
  strictViolations.push(...await strict.evaluate(() => window.__v));
  assert.equal(await strict.locator('iframe').count(), 0);
  assert.equal(await strict.locator('article[data-id]').count(), 48);
  await strict.waitForTimeout(300);
  await shot(strict, 'csp-refused-compact');
  await strict.close();
  check('if the browser refuses preview frames (no frame-src), the tab switches to compact cards for all 48 documents', { strictViolations: [...new Set(strictViolations)] });

  const finalProof = await p.evaluate(() => window.__proof);
  assert.deepEqual(finalProof.violations, [], 'no CSP violations on the real policy');
  assert.deepEqual(pageErrors, []);
  assert.deepEqual(downloads, []);
  complete = true;
} finally {
  await writeFile(resolve(state, 'results.json'), JSON.stringify({
    complete, checks, metrics, browser: browser.version(), origins: { catalog: cat, public: pub, external: ext },
    limits: { MAX_PENDING, MAX_LIVE, REVEAL_MS, PREVIEW_MAX_BYTES },
    pageErrors, downloads,
    limitations: 'Headless local Chromium only (Firefox/WebKit sandbox and scaling behaviour not exercised). Loopback origins: production docs/docs-library hosts are same-site, these are cross-site. Previews run no JavaScript, so script-built pages are blank and pages may differ from their scripted rendering.',
  }, null, 2));
  await browser.close();
  if (!(serve && complete)) {
    for (const res of stalled) res.destroy();
    await mf.dispose();
    extServer.close();
  }
}

if (serve && complete) {
  const manifest = {
    pid: process.pid, catalog: `${cat}/all-docs`, public: pub, external: ext, password,
    note: 'Disposable local fixtures only; the proof deleted nothing. Stop with the command below.',
    sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    bundleSha256: createHash('sha256').update(await readFile(resolve(root, '.wrangler/build/index.js'))).digest('hex'),
    startedAt: new Date().toISOString(), stop: `kill -TERM ${process.pid}`,
  };
  await writeFile(resolve(state, 'server.json'), JSON.stringify(manifest, null, 2));
  console.log(`SERVING ${JSON.stringify(manifest)}`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => {
    for (const res of stalled) res.destroy();
    await mf.dispose();
    extServer.close();
    process.exit(0);
  });
}
