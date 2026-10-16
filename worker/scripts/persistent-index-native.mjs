import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';

/** Native operator acceptance uses the exact built app, its real lease and real R2 sources.
 * Only fixture preparation writes SQL; every behavior assertion crosses the authenticated HTTP
 * or operator process interface. This process never loads Wrangler or operator credentials.
 */
process.env.DOCS_LOCAL_RUN ||= `persistent-index-operator-${Date.now()}`;
process.env.DOCS_PUBLIC_PORT ||= '19077'; process.env.DOCS_CATALOG_PORT ||= '19078';
process.env.DOCS_FIXTURE_MODE = 'operator';
const { runtime, seed, state, catalogOrigin: cat, publicOrigin: pub, password, bearer } = await import('./integration-server.mjs');
await mkdir(state, { recursive: true });
const envFile = resolve(state, 'operator.env');
await writeFile(envFile, `ALL_DOCS_PASSWORD=${password}\n`, { mode: 0o600 });
const mf = runtime(); const checks = []; let complete = false;
const check = (name, details = {}) => { checks.push({ name, ...details }); console.log(`PASS ${name}`); };
const operator = args => new Promise((resolveChild, reject) => {
  const child = spawn(process.execPath, [new URL('./index-maintain.mjs', import.meta.url).pathname,
    '--fixture', '--origin', cat, '--credentials-file', envFile, '--max-batches', '1000', '--deadline-seconds', '300', ...args],
  { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', b => stdout += b); child.stderr.on('data', b => stderr += b);
  child.once('error', reject); child.once('close', code => resolveChild({ code, stdout, stderr }));
});
try {
  await mf.ready;
  const db = await mf.getD1Database('LIBRARY_DB', 'catalog');
  const sql = await readFile(new URL('../migrations/0001_library_index.sql', import.meta.url), 'utf8');
  await db.batch(sql.replace(/^\s*--.*$/gm, '').split(';').map(s => s.trim()).filter(Boolean).map(s => db.prepare(s)));
  await seed(mf);
  const plan = await operator(['--plan']); assert.equal(plan.code, 0); assert.match(plan.stdout, /"plan":true/);
  const before = await db.prepare('SELECT count(*) AS n FROM documents').first(); assert.equal(before.n, 0);
  check('actual CLI plan makes no derived rows');
  await db.prepare("INSERT INTO index_meta(key,value,token,expires_at) VALUES('maintenance-lease','','fixture-other-run',?)").bind(Date.now() + 60_000).run();
  const busy = await operator([]); assert.equal(busy.code, 2, busy.stderr); assert.match(busy.stdout, /"outcome":"busy"/);
  assert.equal((await db.prepare('SELECT count(*) AS n FROM documents').first()).n, 0);
  await db.prepare("DELETE FROM index_meta WHERE key='maintenance-lease' AND token='fixture-other-run'").run();
  check('real shared lease refuses overlapping operator without indexing');
  const result = await operator([]); assert.equal(result.code, 0, result.stderr); assert.match(result.stdout, /Complete:/);
  await writeFile(resolve(state, 'operator-progress.jsonl'), result.stdout);
  const progress = result.stdout.split('\n').filter(s => s.startsWith('{')).map(s => JSON.parse(s));
  assert(progress.length > 1); assert.equal(progress.at(-1).documents, 32); assert.equal(progress.at(-1).pending, 0);
  assert(progress.some(p => p.outcome === 'partial'));
  const rows = await db.prepare('SELECT state,count(*) AS n FROM documents GROUP BY state').all();
  assert.deepEqual(rows.results, [{ state: 'indexed', n: 32 }]);
  check('real CLI bounded R2 backfill and completed reconcile', { batches: progress.length, documents: 32 });
  const headers = { Origin: cat, 'Sec-Fetch-Site': 'same-origin', 'X-Docs-Catalog': '1', 'Content-Type': 'application/json' };
  let response = await fetch(cat + '/all-docs/session', { method: 'POST', headers, body: JSON.stringify({ password }) });
  assert.equal(response.status, 200); headers.Cookie = response.headers.get('set-cookie').split(';')[0];
  headers['X-CSRF-Token'] = (await response.json()).csrfToken;
  const query = { version: 1, query: { text: 'BodySentinel', mode: 'literal', ignoreCase: true }, filter: { kinds: [], uploadedAfter: null, uploadedBefore: null } };
  const textHash = async () => createHash('sha256').update(JSON.stringify((await db.prepare('SELECT doc,body FROM document_text ORDER BY doc').all()).results)).digest('hex');
  const cached = await textHash();
  response = await fetch(cat + '/all-docs/api/search', { method: 'POST', headers, body: JSON.stringify(query) });
  assert.equal(response.status, 200); assert.equal((await response.json()).hits.length, 32);
  assert.equal(await textHash(), cached);
  check('compiled backend query uses persistent stored index without text writes');
  const badBytes = Buffer.from('not a ZIP package');
  response = await fetch(pub + '/upload', { method: 'PUT', headers: { Authorization: `Bearer ${bearer}`,
    'X-Filename': 'broken.docx', 'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'Content-Length': String(badBytes.length) }, body: badBytes });
  assert.equal(response.status, 200); const bad = await response.json();
  let failed;
  for (let attempt = 0; attempt < 100; attempt++) {
    failed = await db.prepare('SELECT state,attempts,version FROM documents WHERE id=?').bind(bad.id).first();
    if (failed?.state === 'failed') break;
    assert(attempt < 99, 'real deferred malformed DOCX did not fail');
    await new Promise(r => setTimeout(r, 25));
  }
  const failure = await operator([]); assert.equal(failure.code, 4, failure.stderr);
  assert(!failure.stdout.includes('Complete:'));
  assert.equal((await db.prepare('SELECT attempts FROM documents WHERE id=?').bind(bad.id).first()).attempts, failed.attempts);
  response = await fetch(cat + '/all-docs/api/index/retry', { method: 'POST', headers,
    body: JSON.stringify({ version: 1, refs: [{ id: bad.id, version: '0'.repeat(64) }] }) });
  assert.equal(response.status, 200);
  assert.equal((await db.prepare('SELECT attempts FROM documents WHERE id=?').bind(bad.id).first()).attempts, failed.attempts);
  check('real failed extraction stops CLI; no automatic or mismatched-version retry reset');
  // Explicit fixture state exercises the real storage-pause response without changing production
  // policy or automatically raising a budget. Tombstones/retries are never reset by this CLI.
  await db.prepare("INSERT INTO index_meta(key,value) VALUES('storage',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .bind(JSON.stringify({ bytes: 0, budgetBytes: 400000000, planningBytes: null, projectedBytes: 999999999, paused: true, reason: 'paused: index size budget' })).run();
  const paused = await operator([]); assert.equal(paused.code, 3, paused.stderr); assert(!paused.stdout.includes('Complete:'));
  const storage = JSON.parse((await db.prepare("SELECT value FROM index_meta WHERE key='storage'").first()).value);
  assert.equal(storage.paused, true); assert.equal(storage.budgetBytes, 400000000);
  check('real paused response stops CLI and preserves configured budget');
  const pendingBytes = Buffer.from('UnindexedPendingBodySentinel');
  response = await fetch(pub + '/upload', { method: 'PUT', headers: { Authorization: `Bearer ${bearer}`,
    'X-Filename': 'pending.txt', 'Content-Type': 'text/plain', 'Content-Length': String(pendingBytes.length) }, body: pendingBytes });
  assert.equal(response.status, 200); const pending = await response.json();
  assert.equal((await db.prepare('SELECT state FROM documents WHERE id=?').bind(pending.id).first()).state, 'pending');
  const browser = await chromium.launch({ headless: true, channel: 'chromium',
    ...(process.env.DOCS_CHROMIUM ? { executablePath: process.env.DOCS_CHROMIUM } : {}) });
  try {
    const page = await browser.newPage();
    await page.goto(cat + '/all-docs'); await page.getByLabel('Password', { exact: true }).fill(password);
    await page.getByRole('button', { name: 'Unlock', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.scan-line')?.textContent.includes('Refresh'));
    assert(await page.getByRole('button', { name: 'Select all matching', exact: true }).isDisabled());
    await page.getByRole('searchbox', { name: 'Search names and content' }).fill('pending.txt');
    const label = page.locator(`article[data-id="${pending.id}"] [data-coverage="label"]`);
    await label.waitFor(); assert.equal(await label.innerText(), 'content not indexed yet · name searched');
    assert(await page.getByRole('button', { name: 'Select all matching', exact: true }).isDisabled());
    await page.screenshot({ path: resolve(state, 'native-pending-ui.png') });
    check('real paused upload stays pending in compiled UI; empty and nonempty all-matching refused', { browser: browser.version() });
  } finally { await browser.close(); }
  complete = true;
} finally {
  await writeFile(resolve(state, 'native-results.json'), JSON.stringify({ complete, checks, state,
    sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    bundleSha256: createHash('sha256').update(await readFile(new URL('../.wrangler/build/index.js', import.meta.url))).digest('hex'),
    limitations: 'Local native workerd; held-lease fixture is not deployed cron timing. Large-body/storage admission acceptance belongs to the records/query owner proofs.' }, null, 2));
  await mf.dispose();
}
