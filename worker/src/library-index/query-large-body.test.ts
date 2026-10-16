import { describe, expect, it } from "vitest";
import { Miniflare } from "miniflare";
import { build } from "esbuild";
// @ts-expect-error Node-only proof driver, excluded from production bundles.
import { readFile, mkdir, writeFile } from "node:fs/promises";
// @ts-expect-error Node-only process-tree RSS sampler.
import { execFile } from "node:child_process";
// @ts-expect-error Node-only proof driver.
import process from "node:process";
import type { LibrarySearchResponse, LibrarySnippetsResponse } from "../library-contracts";

/** Runs the actual compiled query implementation inside workerd, with the shared migration.
 * The ordinary tests use createLibraryFixture; this separate driver also measures the native
 * query isolate (not just a Node-side D1 proxy), sampling only this driver's process subtree.
 */
describe("native persistent query large-body proof", () => {
  it("scans 100 x 512 KiB and partitions 48 x 512 KiB snippets without an isolate reset", async () => {
    const bundle = await build({
      stdin: { contents: `
        import { createLibraryQueries } from './src/library-index/query';
        import { DEFAULT_LIBRARY_CONFIG } from './src/library-index';
        let identity;
        const forbidden = () => { throw new Error('Unexpected R2/extraction access'); };
        export default { async fetch(request, env) {
          identity ??= crypto.randomUUID();
          const data = await request.json();
          const db = env.LIBRARY_DB;
          let output;
          if (data.op === 'migrate') output = await db.batch(data.sql.map(s => db.prepare(s)));
          else if (data.op === 'seed') {
            const i = data.index;
            const id = 'Q' + String(i).padStart(7,'0');
            const suffix = ' document-' + i + ' needle z';
            const prefix = 'Persistent search and generation checkpoints. ';
            const body = prefix + 'bounded text '.repeat(45000).slice(0,524288-prefix.length-suffix.length) + suffix;
            const row = await db.prepare(
              "INSERT INTO documents(id,version,title,filename,kind,mime,size_bytes,uploaded_at,uploaded_at_iso,state,coverage,indexed_bytes,extractor,object_count,changed_at) VALUES (?,?,?,?,'text','text/plain',524288,1,'2026-10-16T00:00:00Z','indexed','full',524288,1,1,1) RETURNING doc"
            ).bind(id,'v'+i,'Large document '+i,'report-'+i+'.txt').first();
            await db.batch([
              db.prepare('INSERT INTO document_text(doc,body) VALUES (?,?)').bind(row.doc,body),
              db.prepare('INSERT INTO document_fts(rowid,title,filename,body) VALUES (?,?,?,?)').bind(row.doc,'Large document '+i,'report-'+i+'.txt',body)
            ]);
            output = {bytes:new TextEncoder().encode(body).length};
          } else {
            let used=0;
            const prepared=new WeakMap();
            const wrap=(s,sql)=> {
              const p=new Proxy(s,{get(target,key){
                if(key==='bind') return (...args)=>wrap(target.bind(...args),sql);
                if(['all','first','run','raw'].includes(key)) return async (...args)=>{
                  used++;
                  const result=await target[key](...args);
                  const rows=result?.results;
                  if(rows?.some(r=>typeof r.body==='string')) {
                    bodyReads.push({rows:rows.length,bytes:rows.reduce((n,r)=>n+new TextEncoder().encode(r.body||'').length,0)});
                  }
                  return result;
                };
                const value=target[key]; return typeof value==='function'?value.bind(target):value;
              }});
              prepared.set(p,s);return p;
            };
            const bodyReads=[];
            const traced=new Proxy(db,{get(target,key){
              if(key==='prepare') return sql=>wrap(target.prepare(sql),sql);
              if(key==='batch') return stmts=>{used+=stmts.length;return target.batch(stmts.map(s=>prepared.get(s)||s));};
              const value=target[key];return typeof value==='function'?value.bind(target):value;
            }});
            const queries=createLibraryQueries({db:traced,now:Date.now,publicOrigin:'https://docs.example',
              config:DEFAULT_LIBRARY_CONFIG,documents:{page:forbidden,resolve:forbidden,create:forbidden,remove:forbidden},
              extract:forbidden,defer:forbidden,nonce:crypto.randomUUID});
            const start=performance.now();
            const result=await queries[data.op](data.request);
            output={result,used,bodyReads,elapsedMs:performance.now()-start};
          }
          return Response.json(output,{headers:{'x-query-isolate':identity}});
        }};
      `, resolveDir: new URL("../../", (import.meta as { url: string }).url).pathname },
      bundle: true, write: false, format: "esm", platform: "browser", target: "es2022",
    });
    const mf = new Miniflare({ modules: true, script: bundle.outputFiles[0].text,
      compatibilityDate: "2024-12-01", host: "127.0.0.1", port: 0, cf: false,
      d1Databases: { LIBRARY_DB: "query-native-proof" },
      outboundService: () => { throw new Error("No external fetch in query proof"); } });
    let peakDriverKiB = 0;
    let peakWorkerdKiB = 0;
    let peakTreeKiB = 0;
    let sampling = false;
    const sample = async () => {
      if (sampling) return;
      sampling = true;
      try {
        const listing: string = await new Promise((resolve, reject) => execFile("ps", ["-axo", "pid=,ppid=,rss=,comm="],
          (error: Error | null, stdout: string) => error ? reject(error) : resolve(stdout)));
        const rows = listing.trim().split("\n").map((line) => {
          const [pid, parent, rss, ...command] = line.trim().split(/\s+/);
          return { pid: Number(pid), parent: Number(parent), rss: Number(rss), command: command.join(" ") };
        });
        const ids = new Set<number>([process.pid]);
        for (let i = 0; i < rows.length; i++) {
          let changed = false;
          for (const row of rows) if (ids.has(row.parent) && !ids.has(row.pid)) { ids.add(row.pid); changed = true; }
          if (!changed) break;
        }
        const owned = rows.filter((row) => ids.has(row.pid));
        peakDriverKiB = Math.max(peakDriverKiB, rows.find((row) => row.pid === process.pid)?.rss ?? 0);
        peakWorkerdKiB = Math.max(peakWorkerdKiB, ...owned.filter((row) => row.command.includes("workerd")).map((row) => row.rss), 0);
        peakTreeKiB = Math.max(peakTreeKiB, owned.reduce((sum, row) => sum + row.rss, 0));
      } finally { sampling = false; }
    };
    const interval = setInterval(() => { void sample(); }, 50);
    let isolate: string | null = null;
    const bodyReads: { rows: number; bytes: number }[] = [];
    const timings: Record<string, number[]> = {};
    const invoke = async <T,>(op: string, data: Record<string, unknown>): Promise<T> => {
      const response = await mf.dispatchFetch("https://proof.invalid/", { method: "POST", body: JSON.stringify({ op, ...data }) });
      expect(response.status).toBe(200);
      const current = response.headers.get("x-query-isolate");
      if (isolate === null) isolate = current;
      expect(current).toBe(isolate);
      const value = await response.json() as { result: T; elapsedMs: number; used: number; bodyReads: typeof bodyReads };
      if (value.result) {
        bodyReads.push(...value.bodyReads);
        (timings[op] ??= []).push(value.elapsedMs);
        expect(value.used).toBeLessThanOrEqual(40);
        return value.result;
      }
      return value as T;
    };
    try {
      const migration: string = await readFile(new URL("../../migrations/0001_library_index.sql", (import.meta as { url: string }).url), "utf8");
      await invoke("migrate", { sql: migration.replace(/^\s*--.*$/gm, "").split(";").map((s: string) => s.trim()).filter(Boolean) });
      for (let index = 1; index <= 100; index++) {
        expect(await invoke("seed", { index })).toEqual({ bytes: 524288 });
      }
      await sample();
      const filter = { kinds: [], uploadedBefore: null, uploadedAfter: null };
      const query = { text: "z$", mode: "regex", ignoreCase: false };
      const hits: LibrarySearchResponse["hits"] = [];
      let cursor: string | undefined;
      for (let i = 0; i < 100; i++) {
        const result = await invoke<LibrarySearchResponse>("search", { request: { version: 1, query, filter, ...(cursor ? { cursor } : {}) } });
        hits.push(...result.hits);
        expect(result.complete).toBe(result.nextCursor === null);
        if (result.complete) break;
        cursor = result.nextCursor!;
      }
      expect(hits).toHaveLength(100);
      expect(new Set(hits.map((hit) => hit.id)).size).toBe(100);
      expect(hits.every((hit) => hit.matchCount === 1)).toBe(true);
      expect(timings.search.length).toBeGreaterThanOrEqual(4);
      const regexTimings = [...timings.search];
      for (const text of ["document-37", "needle", "does-not-exist"]) {
        const latencies: number[] = [];
        let next: string | undefined;
        let count = 0;
        for (let i = 0; i < 100; i++) {
          const result = await invoke<LibrarySearchResponse>("search", { request: { version: 1,
            query: { text, mode: "literal", ignoreCase: true }, filter, ...(next ? { cursor: next } : {}) } });
          count += result.hits.length;
          latencies.push(timings.search.at(-1)!);
          if (result.complete) break;
          next = result.nextCursor!;
        }
        expect(count).toBe(text === "needle" ? 100 : text === "document-37" ? 1 : 0);
        timings[`literal:${text}`] = latencies;
      }
      const refs = Array.from({ length: 48 }, (_, i) => ({ id: `Q${String(i + 1).padStart(7, "0")}`, version: `v${i + 1}` }));
      let remaining = refs;
      const snippets: LibrarySnippetsResponse["hits"] = [];
      while (remaining.length) {
        const result = await invoke<LibrarySnippetsResponse>("snippets", { request: { version: 1, generation: 0,
          query: { text: "needle", mode: "literal", ignoreCase: true }, refs: remaining } });
        expect(result.unavailable).toEqual([]);
        expect(result.hits.length + result.remaining.length).toBe(remaining.length);
        expect(result.hits.length).toBeGreaterThan(0);
        expect(result.hits.length).toBeLessThanOrEqual(32);
        snippets.push(...result.hits);
        remaining = result.remaining;
      }
      expect(snippets.map(({ id, version }) => ({ id, version }))).toEqual(refs);
      expect(snippets.every((hit) => hit.matchCount === 1 && hit.ranges.length === 1)).toBe(true);
      expect(bodyReads.length).toBeGreaterThan(10);
      expect(bodyReads.every((page) => page.rows <= 8 && page.bytes <= 4 * 1024 * 1024)).toBe(true);
      // A second corpus exercises selective and common SQL counts at the intended catalog
      // scale. Bodies are modest prose, unlike the deliberately maximal memory fixture above.
      const prose = "Database policy: preserve version identity, generation checkpoints, cancellation, exact counts, literal phrases and metadata coverage. ".repeat(12);
      const scaleSQL = [
        `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<5000)
         INSERT INTO documents(id,version,title,filename,kind,mime,size_bytes,uploaded_at,uploaded_at_iso,state,coverage,indexed_bytes,extractor,object_count,changed_at)
         SELECT 'S'||printf('%07d',i),'scale-'||i,'policy-handbook-'||i,'handbook-'||i||'.txt','text','text/plain',
           ${prose.length},1,'2026-10-16T00:00:00Z','indexed','full',${prose.length},1,1,1 FROM n`,
        `INSERT INTO document_text(doc,body) SELECT doc,'${prose}' FROM documents WHERE id LIKE 'S%'`,
        `INSERT INTO document_fts(rowid,title,filename,body) SELECT d.doc,d.title,d.filename,t.body
           FROM documents d JOIN document_text t ON t.doc=d.doc WHERE d.id LIKE 'S%'`,
      ];
      await invoke("migrate", { sql: scaleSQL });
      const scale: Record<string, { hits: number; slices: number; totalMs: number; sliceMs: number[] }> = {};
      for (const text of ["policy-handbook-2345", "Database policy", "definitely absent phrase"]) {
        let next: string | undefined;
        const sliceMs: number[] = [];
        let count = 0;
        for (let i = 0; i < 100; i++) {
          const result = await invoke<LibrarySearchResponse>("search", { request: { version: 1,
            query: { text, mode: "literal", ignoreCase: true }, filter, ...(next ? { cursor: next } : {}) } });
          count += result.hits.length;
          sliceMs.push(timings.search.at(-1)!);
          if (result.complete) break;
          next = result.nextCursor!;
        }
        expect(count).toBe(text === "Database policy" ? 5000 : text === "policy-handbook-2345" ? 1 : 0);
        scale[text] = { hits: count, slices: sliceMs.length, totalMs: sliceMs.reduce((a, b) => a + b, 0), sliceMs };
      }
      await sample();
      const report = { runtime: "Miniflare 3.20250718.3 / workerd 1.20250718.0", documents: 100,
        bodyBytes: 524288, snippetRefs: 48, isolate, isolateResets: 0,
        peakDriverKiB, peakWorkerdKiB, peakTreeKiB, sampleIntervalMs: 50,
        maxStatementBodyRows: Math.max(...bodyReads.map((p) => p.rows)),
        maxStatementBodyBytes: Math.max(...bodyReads.map((p) => p.bytes)),
        regexSliceMs: regexTimings, timings, scale: { documents: 5000, bodyBytes: prose.length, queries: scale },
        limits: "Local process RSS is not per-isolate heap; no deployed CPU/latency claim." };
      const out = new URL("../../../.scratch/docs-index-query/", (import.meta as { url: string }).url);
      await mkdir(out, { recursive: true });
      await writeFile(new URL("large-body.json", out), JSON.stringify(report, null, 2) + "\n");
      console.log(JSON.stringify(report));
    } finally {
      clearInterval(interval);
      await mf.dispose();
    }
  }, 120_000);
});
