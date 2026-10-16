import { constants } from 'node:fs';
import { open, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

/** Bounded operator driver for the catalog's shared maintenance lease. The server owns
 * reconciliation checkpoints, retries and storage policy; this process owns authentication,
 * a wall-clock/request cap and truthful completion. Credentials live only in this process.
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
class OperatorError extends Error {
  constructor(message, code = 1) { super(message); this.code = code; }
}
const fail = (message, code) => { throw new OperatorError(message, code); };
const defaults = { documents: 12, textBytes: 32 * 1024 * 1024, listPages: 1, deadlineMs: 20_000 };

function argumentsFor(args, configuredOrigin) {
  const result = { origin: configuredOrigin, envFile: resolve(root, '.env'), maxBatches: 100,
    deadlineSeconds: 120, stallBatches: 10, plan: false, fixture: false };
  const seen = new Set();
  const numeric = { '--max-batches': ['maxBatches', 10_000], '--deadline-seconds': ['deadlineSeconds', 3600],
    '--stall-batches': ['stallBatches', 100] };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const canonical = arg === '--dry-run' ? '--plan' : arg;
    if (seen.has(canonical)) fail('Duplicate option. Use --help for usage.');
    seen.add(canonical);
    if (canonical === '--plan') result.plan = true;
    else if (arg === '--fixture') result.fixture = true;
    else if (arg === '--origin' || arg === '--credentials-file') {
      if (!args[i + 1] || args[i + 1].startsWith('--')) fail('Missing option value.');
      result[arg === '--origin' ? 'origin' : 'envFile'] = args[++i];
    } else if (numeric[arg]) {
      const [key, max] = numeric[arg], value = args[++i];
      if (!/^[1-9][0-9]*$/.test(value ?? '') || Number(value) > max) fail('Invalid bounded numeric option.');
      result[key] = Number(value);
    } else fail('Unknown option. Use --help for usage.');
  }
  let url;
  try { url = new URL(result.origin); } catch { fail('Invalid catalog origin.'); }
  if (url.origin !== result.origin || url.username || url.password) fail('Use a literal catalog origin without path, credentials, query or fragment.');
  const loopback = url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (result.fixture ? !loopback : result.origin !== configuredOrigin || url.protocol !== 'https:') {
    fail('Use the configured HTTPS catalog origin, or --fixture with an explicit HTTP loopback origin.');
  }
  if (result.fixture && !seen.has('--origin')) fail('--fixture requires an explicit loopback --origin.');
  if (seen.has('--credentials-file') && !result.fixture) fail('--credentials-file is available only with --fixture. Production uses worker/.env.');
  return result;
}

async function passwordFrom(path) {
  // Open the inode once: no symlinks/FIFOs, permissive mode, foreign owner or hard links.
  // Validate before parsing so no rejected dotenv value can appear in a native diagnostic.
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.uid !== process.getuid() || info.nlink !== 1 || info.size > 1024 * 1024
      || (info.mode & 0o777) !== 0o600) fail('Operator .env must be an owned regular file with mode 0600, one link and size below 1 MiB.');
    const text = await file.readFile('utf8');
    const entry = /[ \t]*(?:#[^\r\n]*)?(?:\r?\n|$)|[ \t]*(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=[ \t]*(?:'[^']*'|"[^"]*"|`[^`]*`|[^#\r\n'"`]*?)[ \t]*(?:#[^\r\n]*)?(?:\r?\n|$)/y;
    let offset = 0, passwords = 0;
    while (offset < text.length) {
      entry.lastIndex = offset;
      const match = entry.exec(text);
      if (!match?.[0].length) fail('Invalid literal dotenv syntax.');
      if (match[1] === 'ALL_DOCS_PASSWORD') passwords++;
      offset = entry.lastIndex;
    }
    const password = parseEnv(text).ALL_DOCS_PASSWORD;
    if (passwords !== 1 || !password || password.includes('\0') || Buffer.byteLength(password) > 1024) {
      fail('Operator .env requires exactly one ALL_DOCS_PASSWORD of 1..1024 UTF-8 bytes.');
    }
    return password;
  } finally { await file.close(); }
}

async function main() {
  if (process.argv.slice(2).join(' ') === '--help') {
    console.log('node scripts/index-maintain.mjs [--plan|--dry-run] [--max-batches 100] [--deadline-seconds 120] [--stall-batches 10]\nDisposable tests only: --fixture --origin http://localhost:PORT --credentials-file /private/fixture.env');
    return;
  }
  const config = await readFile(resolve(root, 'wrangler.catalog.toml'), 'utf8');
  const configuredOrigin = config.match(/^CATALOG_ORIGIN\s*=\s*"([^"\r\n]+)"\s*$/m)?.[1];
  if (!configuredOrigin) fail('Missing literal CATALOG_ORIGIN in worker/wrangler.catalog.toml.');
  const options = argumentsFor(process.argv.slice(2), configuredOrigin);
  if (options.plan) {
    console.log(JSON.stringify({ plan: true, origin: options.origin, endpoint: '/all-docs/api/index/maintain',
      authentication: 'private 0600 .env password; signed session and CSRF in memory',
      first: { version: 1, options: { ...defaults, reconcile: true } },
      subsequent: { version: 1, options: { ...defaults, reconcile: false } },
      maxBatches: options.maxBatches, deadlineSeconds: options.deadlineSeconds, stallBatches: options.stallBatches,
      completion: 'new completed reconcile, complete outcome, zero pending/failed/anomalies, storage unpaused',
      mutations: 'none: plan does not open .env or make requests' }));
    return;
  }
  let password = await passwordFrom(options.envFile);
  // A monotonic deadline stays bounded even if the machine wall clock changes mid-run.
  const started = performance.now(), end = started + options.deadlineSeconds * 1000;
  let cookie = '', csrf = '';
  const cancellation = new AbortController();
  const cancel = () => cancellation.abort();
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  async function request(path, payload) {
    if (performance.now() >= end || cancellation.signal.aborted) fail('Stopped: deadline or cancellation; server checkpoints are retained.', 6);
    const response = await fetch(options.origin + path, { method: payload === undefined ? 'GET' : 'POST',
      redirect: 'error', signal: AbortSignal.any([cancellation.signal, AbortSignal.timeout(Math.max(1, Math.floor(end - performance.now())))]),
      headers: { Origin: options.origin, 'Sec-Fetch-Site': 'same-origin', 'X-Docs-Catalog': '1',
        ...(cookie && { Cookie: cookie }), ...(csrf && { 'X-CSRF-Token': csrf }),
        ...(payload !== undefined && { 'Content-Type': 'application/json' }) },
      ...(payload !== undefined && { body: JSON.stringify(payload) }) });
    if (!response.ok) { await response.body?.cancel(); fail(`Stopped: catalog HTTP ${response.status}; no automatic retry or retry reset.`, 4); }
    if (response.headers.get('cache-control') !== 'no-store' || !/noindex/.test(response.headers.get('x-robots-tag') ?? '')) {
      await response.body?.cancel(); fail('Stopped: catalog privacy headers missing.', 4);
    }
    // Metadata's first page may contain bounded long names. No content or backend errors are
    // logged; keep the response bound even if the configured host is accidentally misrouted.
    const reader = response.body.getReader(); let size = 0; const chunks = [];
    try {
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        size += value.length; if (size > 12 * 1024 * 1024) fail('Stopped: oversized catalog response.', 4);
        chunks.push(value);
      }
    } finally { await reader.cancel(); }
    return { response, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) };
  }
  try {
    const session = await request('/all-docs/session', { password }); password = undefined;
    const setCookie = session.response.headers.get('set-cookie') ?? '';
    cookie = setCookie.split(';')[0]; csrf = session.body.csrfToken;
    if (!/^__Host-docs_catalog=[A-Za-z0-9_.-]+$/.test(cookie) || typeof csrf !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(csrf)) {
      fail('Stopped: invalid catalog authentication response.', 4);
    }
    const initial = (await request('/all-docs/api/documents')).body;
    const priorReconcile = initial.status?.lastReconciledAt;
    if (initial.version !== 1 || !(priorReconcile === null || typeof priorReconcile === 'string')) fail('Stopped: invalid library status.', 4);
    let previous = '', stalled = 0;
    for (let batch = 1; batch <= options.maxBatches; batch++) {
      const remaining = end - performance.now();
      if (remaining < 1000) fail('Stopped: deadline cap; server checkpoints are retained.', 6);
      const { body: report } = await request('/all-docs/api/index/maintain', { version: 1,
        options: { ...defaults, deadlineMs: Math.floor(Math.min(defaults.deadlineMs, remaining - 500)), reconcile: batch === 1 } });
      const counts = report.status?.counts;
      if (report.version !== 1 || !['complete', 'partial', 'busy', 'paused'].includes(report.outcome) || !counts
        || !['documents', 'pending', 'failed', 'indexed'].every(k => Number.isSafeInteger(counts[k]) && counts[k] >= 0)
        || !['processed', 'indexed', 'failed', 'repaired', 'reconciledPages', 'generation'].every(k => Number.isSafeInteger(report[k]) && report[k] >= 0)
        || counts.indexed + counts.pending + counts.failed !== counts.documents
        || typeof report.status.storage?.paused !== 'boolean' || !Number.isSafeInteger(report.status.anomalies) || report.status.anomalies < 0
        || !(report.status.lastReconciledAt === null || Number.isFinite(Date.parse(report.status.lastReconciledAt)))) {
        fail('Stopped: invalid maintenance response.', 4);
      }
      const reconciled = report.status.lastReconciledAt !== priorReconcile && report.status.lastReconciledAt !== null;
      console.log(JSON.stringify({ batch, outcome: report.outcome, processed: report.processed, indexed: report.indexed,
        pending: counts.pending, failed: counts.failed, documents: counts.documents, reconciled, elapsedMs: Math.round(performance.now() - started) }));
      if (report.outcome === 'busy') fail('Stopped: busy lease; resume in a later invocation.', 2);
      if (report.outcome === 'paused' || report.status.storage.paused) fail('Stopped: storage paused; owner review required. Budget was not changed.', 3);
      if (counts.failed > 0) fail('Stopped: failed documents remain; inspect exact versions before explicit manual retry.', 4);
      if (report.status.anomalies > 0) fail('Stopped: tombstoned R2 anomalies require owner review.', 4);
      if (report.outcome === 'complete' && reconciled && counts.pending === 0) {
        console.log('Complete: this invocation observed a newly completed reconcile; pending=0 failed=0 anomalies=0.');
        return;
      }
      const fingerprint = JSON.stringify([report.generation, counts, report.status.lastReconciledAt]);
      const active = report.processed > 0 || report.repaired > 0 || report.reconciledPages > 0 || fingerprint !== previous;
      stalled = active ? 0 : stalled + 1; previous = fingerprint;
      if (stalled >= options.stallBatches) fail('Stopped: no visible progress; server may retain within-page checkpoints. Inspect and resume; completion is unproven.', 5);
    }
    fail('Stopped: max-batches cap; server checkpoints are retained. Rerun to resume.', 6);
  } finally {
    password = undefined; cookie = ''; csrf = '';
    process.off('SIGINT', cancel); process.off('SIGTERM', cancel);
  }
}

main().catch(error => {
  console.error(error instanceof OperatorError ? error.message : 'Stopped: local setup, network, timeout or response failure. No secret or backend details are displayed.');
  process.exitCode = error instanceof OperatorError ? error.code : 1;
});
