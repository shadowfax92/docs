/** Disposable compiled-Worker acceptance. Production maintenance/records/query, native
 * HTMLRewriter, D1 and R2 execute inside workerd with one actual ledger per invocation.
 * Legacy fixture seeds bypass upload decoration solely to exercise backfill discovery.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { build } from "esbuild";
import { Miniflare } from "miniflare";

const bundled = await build({
  stdin: { contents: `
    import { createDocuments } from './src/documents';
    import { extractText } from './src/extract';
    import { createLibraryIndex, DEFAULT_LIBRARY_CONFIG } from './src/library-index';
    import { createInvocationResources } from './src/invocation-budget';
    export default { async fetch(request, env) {
      const input = await request.json();
      const resources = createInvocationResources(() => env.DB, env.BUCKET);
      const deps = { db: resources.db, budget: resources.budget,
        documents: createDocuments(resources.bucket, 'https://docs.example'), extract: extractText,
        defer: () => { throw new Error('Backfill must not spawn deferred work'); },
        now: Date.now, nonce: () => crypto.randomUUID(), publicOrigin: 'https://docs.example', config: DEFAULT_LIBRARY_CONFIG };
      const library = createLibraryIndex(deps);
      if (input.op === 'seed') {
        await resources.bucket.put(input.id + '/note.html', '<h1>Native body needle</h1><script>private-script</script>');
        return Response.json({ seeded: input.id, used: resources.budget.used });
      }
      if (input.op === 'maintain') {
        const report = await library.maintain({documents:12,textBytes:33554432,listPages:1,deadlineMs:20000});
        return Response.json({ report, used: resources.budget.used });
      }
      const result = await library.search({version:1,query:{text:'native body',mode:'literal',ignoreCase:true},
        filter:{kinds:[],uploadedBefore:null,uploadedAfter:null}});
      const text = await resources.db.prepare('SELECT body FROM document_text ORDER BY doc').all();
      return Response.json({result,text:text.results,used:resources.budget.used});
    } };
  `, resolveDir: new URL("../../", import.meta.url).pathname },
  bundle: true, write: false, format: "esm", platform: "browser", target: "es2022",
});
const runtime = new Miniflare({
  modules: true, script: bundled.outputFiles[0].text,
  compatibilityDate: "2024-12-01", host: "127.0.0.1", port: 0, cf: false,
  d1Databases: { DB: "maintenance-runtime" }, r2Buckets: ["BUCKET"],
  outboundService: () => { throw new Error("Native maintenance proof cannot fetch externally"); },
});
try {
  const db = await runtime.getD1Database("DB");
  const migration = await readFile(new URL("../../migrations/0001_library_index.sql", import.meta.url), "utf8");
  await db.batch(migration.replace(/^\s*--.*$/gm, "").split(";").map((sql) => sql.trim()).filter(Boolean).map((sql) => db.prepare(sql)));
  const call = async (input) => {
    const response = await runtime.dispatchFetch("https://fixture.invalid/maintenance", { method: "POST", body: JSON.stringify(input) });
    const body = await response.text();
    assert.equal(response.status, 200, body);
    return JSON.parse(body);
  };
  for (let i = 0; i < 5; i++) await call({ op: "seed", id: `Work${String(i).padStart(4, "0")}` });
  const runs = [];
  for (let i = 0; i < 12; i++) {
    const run = await call({ op: "maintain" });
    assert(run.used <= 50, JSON.stringify(run));
    runs.push({ used: run.used, processed: run.report.processed, indexed: run.report.indexed,
      outcome: run.report.outcome, pending: run.report.status.counts.pending, generation: run.report.generation });
    if (run.report.status.counts.indexed === 5) break;
  }
  assert.equal(runs.at(-1).pending, 0, JSON.stringify(runs));
  const verified = await call({ op: "verify" });
  assert.equal(verified.result.hits.length, 5);
  assert.equal(verified.result.complete, true);
  assert.equal(verified.text.length, 5);
  for (const { body } of verified.text) assert.equal(body, "Native body needle");
  const idle = await call({ op: "maintain" });
  assert.equal(idle.report.generation, runs.at(-1).generation);
  assert.equal(idle.report.processed, 0);
  assert.equal(idle.report.outcome, "complete");
  console.log(JSON.stringify({ pass: true, runtime: "compiled workerd", documents: 5,
    runs, peakCombinedOperations: Math.max(...runs.map((run) => run.used)), idleOperations: idle.used,
    generation: idle.report.generation, nativeHTML: "script excluded", queryHits: 5 }, null, 2));
} finally { await runtime.dispose(); }
