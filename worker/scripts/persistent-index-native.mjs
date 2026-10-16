import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';

/** Native operator acceptance uses the exact built app, its real lease and real R2 sources.
 * Only fixture preparation writes SQL; every behavior assertion crosses the authenticated HTTP
 * or operator process interface. This process never loads Wrangler or operator credentials.
 */
process.env.DOCS_LOCAL_RUN ||= `persistent-index-operator-${Date.now()}`;
process.env.DOCS_PUBLIC_PORT ||= '19077'; process.env.DOCS_CATALOG_PORT ||= '19078';
process.env.DOCS_FIXTURE_MODE = 'operator';
const { runtime, seed, state, catalogOrigin: cat, password } = await import('./integration-server.mjs');
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
  // Explicit fixture state exercises the real storage-pause response without changing production
  // policy or automatically raising a budget. Tombstones/retries are never reset by this CLI.
  await db.prepare("INSERT INTO index_meta(key,value) VALUES('storage',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .bind(JSON.stringify({ bytes: 0, budgetBytes: 400000000, planningBytes: null, projectedBytes: 999999999, paused: true, reason: 'paused: index size budget' })).run();
  const paused = await operator([]); assert.equal(paused.code, 3, paused.stderr); assert(!paused.stdout.includes('Complete:'));
  const storage = JSON.parse((await db.prepare("SELECT value FROM index_meta WHERE key='storage'").first()).value);
  assert.equal(storage.paused, true); assert.equal(storage.budgetBytes, 400000000);
  check('real paused response stops CLI and preserves configured budget');
  complete = true;
} finally {
  await writeFile(resolve(state, 'native-results.json'), JSON.stringify({ complete, checks, state,
    sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    bundleSha256: createHash('sha256').update(await readFile(new URL('../.wrangler/build/index.js', import.meta.url))).digest('hex'),
    limitations: 'Local native workerd; held-lease fixture is not deployed cron timing. Large-body/storage admission acceptance belongs to the records/query owner proofs.' }, null, 2));
  await mf.dispose();
}
