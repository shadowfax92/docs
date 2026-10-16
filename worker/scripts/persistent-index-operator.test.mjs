import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm, chmod, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { test } from 'vitest';

/** Operator's process/HTTP seam: a disposable host records requests, never implements D1.
 * Native product acceptance separately drives this same executable against compiled workerd.
 */
const script = new URL('./index-maintain.mjs', import.meta.url).pathname;
const secret = 'private-disposable-operator-password';
const csrf = 'A'.repeat(43), cookie = '__Host-docs_catalog=disposable.signature';
const status = (pending = 0, failed = 0, lastReconciledAt = null) => ({ counts: {
  documents: 3, indexed: 3 - pending - failed, pending, failed, metadataOnly: 0, truncated: 0 },
  lastReconciledAt, anomalies: 0, storage: { paused: false } });
const report = (overrides = {}) => ({ version: 1, outcome: 'partial', generation: 2,
  processed: 0, indexed: 0, failed: 0, repaired: 0, reconciledPages: 0, textBytes: 0,
  status: status(), ...overrides });
async function fixture(reports, callback) {
  const dir = await mkdtemp(resolve(tmpdir(), 'persistent-index-operator-'));
  const env = resolve(dir, '.env'); await writeFile(env, `ALL_DOCS_PASSWORD='${secret}'\n`, { mode: 0o600 });
  const requests = []; let origin;
  const server = createServer(async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk;
    const payload = text ? JSON.parse(text) : undefined;
    requests.push({ path: req.url, payload, headers: req.headers });
    assert.equal(req.headers.origin, origin); assert.equal(req.headers['sec-fetch-site'], 'same-origin');
    assert.equal(req.headers['x-docs-catalog'], '1');
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Robots-Tag', 'noindex');
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/all-docs/session') {
      assert.deepEqual(payload, { password: secret }); res.setHeader('Set-Cookie', cookie + '; Secure; HttpOnly; SameSite=Strict; Path=/');
      res.end(JSON.stringify({ version: 1, csrfToken: csrf }));
    } else {
      assert.equal(req.headers.cookie, cookie); assert.equal(req.headers['x-csrf-token'], csrf);
      res.end(JSON.stringify(req.url === '/all-docs/api/documents' ? { version: 1, status: status() }
        : reports[Math.min(requests.length - 3, reports.length - 1)]));
    }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${server.address().port}`;
  const run = (args = [], path = env) => new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [script, '--fixture', '--origin', origin, '--credentials-file', path, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', b => stdout += b); child.stderr.on('data', b => stderr += b);
    child.once('error', reject); child.once('close', code => {
      assert(!stdout.includes(secret)); assert(!stderr.includes(secret)); assert(!stdout.includes(cookie));
      resolveRun({ code, stdout, stderr });
    });
  });
  try { await callback({ run, requests, env, dir }); }
  finally { await new Promise(r => server.close(r)); await rm(dir, { recursive: true }); }
}

test('empty partial discovery never claims completion; only first batch forces reconcile', async () => {
  await fixture([report(), report({ outcome: 'complete', status: status(0, 0, new Date().toISOString()) })], async ({ run, requests }) => {
    const result = await run(); assert.equal(result.code, 0); assert.match(result.stdout, /Complete:/);
    assert.deepEqual(requests.filter(r => r.path.endsWith('/maintain')).map(r => r.payload.options.reconcile), [true, false]);
    assert(requests.every(r => !r.path.includes(secret)));
  });
});
test('complete with old reconcile or pending remains bounded and resumable', async () => {
  for (const value of [report({ outcome: 'complete' }), report({ outcome: 'complete', status: status(1, 0, new Date().toISOString()) })]) {
    await fixture([value], async ({ run }) => {
      const result = await run(['--max-batches', '2']); assert.equal(result.code, 6);
      assert(!result.stdout.includes('Complete:')); assert.match(result.stderr, /checkpoints are retained/);
    });
  }
});
test('busy, paused and failed stop without automatic retry resets', async () => {
  for (const [value, code] of [[report({ outcome: 'busy' }), 2], [report({ outcome: 'paused' }), 3], [report({ status: status(0, 1) }), 4]]) {
    await fixture([value], async ({ run, requests }) => {
      const result = await run(); assert.equal(result.code, code); assert.equal(requests.length, 3);
      assert(!('retry' in requests[2].payload.options)); assert(!result.stdout.includes('Complete:'));
    });
  }
});
test('stalled partial exits truthfully and plan opens no credentials or network', async () => {
  await fixture([report()], async ({ run, requests, dir }) => {
    const planned = await run(['--plan'], resolve(dir, 'missing.env')); assert.equal(planned.code, 0); assert.equal(requests.length, 0);
    assert.match(planned.stdout, /"mutations":"none/);
    const result = await run(['--stall-batches', '2']); assert.equal(result.code, 5); assert(!result.stdout.includes('Complete:'));
  });
});
test('unsafe credential files are refused before login', async () => {
  await fixture([report()], async ({ run, requests, env, dir }) => {
    await chmod(env, 0o644); assert.equal((await run()).code, 1);
    await chmod(env, 0o600); const link = resolve(dir, 'link'); await symlink(env, link);
    assert.equal((await run([], link)).code, 1); assert.equal(requests.length, 0);
  });
});
