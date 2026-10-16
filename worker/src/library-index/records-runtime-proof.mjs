// Native Worker proof for fixed-length Request.body, waitUntil ownership and unchanged raw bytes.
// Only disposable Miniflare D1/R2 are used; no deployment config, credentials or external requests.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { build } from "esbuild";
import { Miniflare } from "miniflare";

const root = new URL("../..", import.meta.url).pathname;
const bundled = await build({
  stdin: { resolveDir: root, contents: `
    import { createDocuments } from './src/documents';
    import { createLibraryRecords } from './src/library-index/records';
    import { DEFAULT_LIBRARY_CONFIG } from './src/library-index';
    import { extractText } from './src/extract';
    import { createInvocationResources } from './src/invocation-budget';
    let extracts = 0; let uploadBudget;
    export default { async fetch(request, env, ctx) {
      const url = new URL(request.url); const id = url.searchParams.get('id');
      const resources = createInvocationResources(() => env.DB, env.BUCKET);
      const documents = createDocuments(resources.bucket, 'https://docs.example');
      const records = createLibraryRecords({...resources, documents, publicOrigin:'https://docs.example',
        now:Date.now, nonce:() => crypto.randomUUID(), config:DEFAULT_LIBRARY_CONFIG,
        defer(work) { ctx.waitUntil(work); },
        async extract(doc) { extracts++; await env.GATE.fetch("https://gate.invalid"); return extractText(doc); },
      });
      if (url.pathname === '/upload') {
        if (url.searchParams.has('paused')) await env.DB.prepare("INSERT INTO index_meta(key,value) VALUES ('storage',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
          .bind(JSON.stringify({bytes:100,budgetBytes:400000000,planningBytes:null,projectedBytes:null,paused:true,reason:'paused: index size budget'})).run();
        uploadBudget = resources.budget;
        return Response.json(await records.documents.create({body:request.body, filename:'proof.html',mime:'text/html',title:'Title searchable'}));
      }
      if (url.pathname === '/raw') {
        const doc = await documents.resolve(id); const body = await doc.openBody();
        return new Response(body.body, {headers:{'Content-Type':'application/octet-stream'}});
      }
      if (url.pathname === '/status') {
        const row = await env.DB.prepare('SELECT state,attempts,claim_token FROM documents WHERE id=?').bind(id).first();
        const names = await env.DB.prepare('SELECT rowid FROM document_fts WHERE document_fts MATCH ?').bind('"searchable"').all();
        const bodies = await env.DB.prepare('SELECT rowid FROM document_fts WHERE document_fts MATCH ?').bind('"needle"').all();
        return Response.json({row,names:names.results.length,bodies:bodies.results.length,extracts,budgetUsed:uploadBudget.used});
      }
      return new Response('missing',{status:404});
    }};
  ` }, bundle: true, write: false, format: "esm", platform: "browser", target: "es2022",
});
// Hold extraction through a Node-owned service binding. Workerd promises stay within their
// upload request context while the proof observes metadata and raw bytes before releasing I/O.
let allowExtraction;
const extractionGate = new Promise((done) => { allowExtraction = done; });
const runtime = new Miniflare({ modules: true, script: bundled.outputFiles[0].text, compatibilityDate: "2024-12-01",
  host: "127.0.0.1", port: 0, cf: false, d1Databases: { DB: "records-proof" }, r2Buckets: ["BUCKET"],
  serviceBindings: { GATE: async () => { await extractionGate; return new Response("released"); } },
  outboundService: () => { throw new Error("No outbound requests in records proof"); },
});
try {
  const db = await runtime.getD1Database("DB");
  const migration = await readFile(new URL("../../migrations/0001_library_index.sql", import.meta.url), "utf8");
  await db.batch(migration.replace(/^\s*--.*$/gm, "").split(";").map((part) => part.trim()).filter(Boolean).map((part) => db.prepare(part)));
  const bytes = new TextEncoder().encode('<p>body needle 😀 &amp; exact</p>\r\n<script>private script</script>');
  const response = await runtime.dispatchFetch("https://proof.invalid/upload", {
    method: "POST", headers: { "Content-Length": String(bytes.length) }, body: bytes,
  });
  assert.equal(response.status, 200);
  const summary = await response.json();
  const pending = await (await runtime.dispatchFetch(`https://proof.invalid/status?id=${summary.id}`)).json();
  assert.equal(pending.row.state, "pending"); assert.equal(pending.names, 1); assert.equal(pending.bodies, 0);
  assert.deepEqual(new Uint8Array(await (await runtime.dispatchFetch(`https://proof.invalid/raw?id=${summary.id}`)).arrayBuffer()), bytes);
  allowExtraction();
  let indexed;
  const indexingDeadline = Date.now() + 10_000;
  do {
    indexed = await (await runtime.dispatchFetch(`https://proof.invalid/status?id=${summary.id}`)).json();
    assert.ok(Date.now() < indexingDeadline, "deferred body completed within proof deadline");
  } while (indexed.row.state === "pending");
  assert.equal(indexed.row.state, "indexed"); assert.equal(indexed.bodies, 1); assert.equal(indexed.extracts, 1);
  assert.equal(indexed.budgetUsed, 25); // Includes the native extractor's conditional R2 GET.
  assert.deepEqual(new Uint8Array(await (await runtime.dispatchFetch(`https://proof.invalid/raw?id=${summary.id}`)).arrayBuffer()), bytes);
  const paused = await (await runtime.dispatchFetch("https://proof.invalid/upload?paused", {
    method: "POST", headers: { "Content-Length": String(bytes.length) }, body: bytes,
  })).json();
  let pausedState;
  const pausedDeadline = Date.now() + 10_000;
  do {
    pausedState = await (await runtime.dispatchFetch(`https://proof.invalid/status?id=${paused.id}`)).json();
    assert.ok(Date.now() < pausedDeadline, "paused claim released within proof deadline");
  } while (pausedState.row.claim_token !== null);
  assert.equal(pausedState.row.state, "pending"); assert.equal(pausedState.row.attempts, 0);
  assert.equal(pausedState.row.claim_token, null); assert.equal(pausedState.extracts, 1);
  assert.ok(pausedState.budgetUsed <= 40);
  console.log(JSON.stringify({ proof: "native-records-request-body-waitUntil", bytes: bytes.length, pending, indexed, paused: pausedState, passed: true }, null, 2));
} finally {
  allowExtraction();
  await runtime.dispose();
}
