import { describe, expect, it } from "vitest";
import { createLibraryFixture } from "../library-index.test-support";
import { observeQueryDB, querySummary, seedQueryRows } from "./query-test-support";
import { createLibraryIndex } from "../library-index";
import { readLibraryState } from "./query";
import { compileSearchMatcher } from "../search";
import type { SearchQuery } from "../search";
import type { LibraryHit, LibrarySearchRequest } from "../library-contracts";

const all = { kinds: [], uploadedBefore: null, uploadedAfter: null };
async function searchAll(f: Awaited<ReturnType<typeof createLibraryFixture>>, query: SearchQuery,
  filter: LibrarySearchRequest["filter"] = all) {
  const hits: LibraryHit[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 1000; i++) {
    const result = await f.library.search({ version: 1, query, filter, ...(cursor ? { cursor } : {}) });
    hits.push(...result.hits);
    expect(result.complete).toBe(result.nextCursor === null);
    if (result.complete) return hits;
    cursor = result.nextCursor!;
  }
  throw new Error("Search did not finish");
}

describe("persistent library queries", () => {
  it("reconstructs exact metadata and status while hiding both kinds of deleted row", async () => {
    const f = await createLibraryFixture({ now: () => 1_700_000_000_000 });
    try {
      const summary = querySummary(1, { title: "A title", warnings: ["multiple objects"],
        createdAt: "2020-01-01", objectCount: 2 });
      await seedQueryRows(f.db, [
        { summary, body: "body", coverage: "truncated" },
        { summary: querySummary(2), body: "", state: "pending", coverage: null },
        { summary: querySummary(3), body: "", state: "failed", coverage: "error" },
        { summary: querySummary(4), body: "hidden", state: "deleting" },
        { summary: querySummary(5), body: "also hidden" },
      ]);
      await f.db.prepare("INSERT INTO deleted_ids(id,state,token,at) VALUES (?, 'deleted', 'delete', 1)")
        .bind(querySummary(5).id).run();
      const page = await f.library.page();
      expect(page.items[0]).toEqual({ ...summary, index: {
        state: "indexed", coverage: "truncated", reason: null, indexedBytes: 4, extractorVersion: 1,
      } });
      expect(page.items.map((item) => item.id)).toEqual([1, 2, 3].map((n) => querySummary(n).id));
      expect(page).toMatchObject({ generation: 0, scanComplete: true, nextCursor: null,
        observedAt: "2023-11-14T22:13:20.000Z", status: { counts: {
          documents: 3, indexed: 1, pending: 1, failed: 1, truncated: 1, metadataOnly: 0,
        }, lastReconciledAt: null, anomalies: 0, storage: { paused: false, budgetBytes: 400000000 } } });
    } finally { await f.dispose(); }
  }, 20_000);

  it("counts after NUL metadata safely and refuses more than 10k matching rows", async () => {
    const f = await createLibraryFixture();
    try {
      await seedQueryRows(f.db, [{ summary: querySummary(1, { title: "before\0ABC abc Kelvin ſearch" }), body: "" }]);
      for (const text of ["abc", "kelvin", "search"]) {
        const query = { text, mode: "literal" as const, ignoreCase: true };
        const matcher = compileSearchMatcher(query);
        const expected = matcher.match({ filename: querySummary(1).filename, title: "before\0ABC abc Kelvin ſearch", body: "" });
        matcher.dispose();
        expect(await searchAll(f, query)).toEqual([{ id: querySummary(1).id, version: querySummary(1).version, matchCount: expected!.matchCount }]);
      }
      await f.db.prepare(`WITH RECURSIVE n(i) AS (SELECT 2 UNION ALL SELECT i+1 FROM n WHERE i<10001)
        INSERT INTO documents(id,version,title,filename,kind,mime,size_bytes,uploaded_at,uploaded_at_iso,
          state,object_count,changed_at) SELECT 'Q'||printf('%07d',i),'v','title','file','text','text/plain',
          1,1,'2026-10-16T00:00:00Z','pending',1,1 FROM n`).run();
      await expect(f.library.search({ version: 1, query: { text: "", mode: "literal", ignoreCase: false }, filter: all }))
        .rejects.toMatchObject({ code: "search_budget_exceeded" });
    } finally { await f.dispose(); }
  }, 20_000);

  it("reads shared state in three statements, never touches R2, and preserves housekeeping status", async () => {
    const f = await createLibraryFixture();
    try {
      await seedQueryRows(f.db, [{ summary: querySummary(1), body: "needle" }]);
      const storage = { bytes: 45056, budgetBytes: 400000000, planningBytes: 99999,
        projectedBytes: 123456, paused: true, reason: "paused: index size budget" };
      await f.db.batch([
        f.db.prepare("INSERT INTO index_meta(key,value) VALUES ('storage',?)").bind(JSON.stringify(storage)),
        f.db.prepare("INSERT INTO index_meta(key,value) VALUES ('last-reconciled-at',?)").bind(JSON.stringify("2026-10-15T00:00:00Z")),
        f.db.prepare("INSERT INTO index_meta(key,value) VALUES ('anomalies','2')"),
      ]);
      const trace = observeQueryDB(f.db);
      const forbidden = () => { throw new Error("R2/extraction is forbidden in query reads"); };
      const deps = { ...f.deps, db: trace.db,
        documents: { create: forbidden, page: forbidden, resolve: forbidden, remove: forbidden }, extract: forbidden, defer: forbidden };
      const state = await readLibraryState(deps);
      expect(trace.reads.length).toBe(3);
      expect(state).toMatchObject({ generation: 0, status: { anomalies: 2, storage, lastReconciledAt: "2026-10-15T00:00:00Z" } });
      expect(trace.bodyPages).toEqual([]);
      const library = createLibraryIndex(deps);
      expect((await library.page()).items.length).toBe(1);
      const query = { text: "needle", mode: "literal" as const, ignoreCase: true };
      expect((await library.search({ version: 1, query, filter: all })).hits[0].matchCount).toBe(1);
      expect((await library.snippets({ version: 1, generation: 0, query,
        refs: [{ id: querySummary(1).id, version: querySummary(1).version }] })).hits.length).toBe(1);
    } finally { await f.dispose(); }
  }, 20_000);

  it("binds pages to stable rowids/generation and rejects foreign cursors before any reads", async () => {
    const f = await createLibraryFixture();
    try {
      const rows = Array.from({ length: 505 }, (_, i) => ({ summary: querySummary(i + 1), body: "" }));
      await seedQueryRows(f.db, rows);
      const trace = observeQueryDB(f.db);
      const library = createLibraryIndex({ ...f.deps, db: trace.db });
      const first = await library.page();
      expect(first.items).toHaveLength(500);
      expect(first.scanComplete).toBe(false);
      const second = await library.page(first.nextCursor!);
      expect(second.items.map((item) => item.id)).toEqual(rows.slice(500).map((r) => r.summary.id));
      expect(second.scanComplete).toBe(true);
      expect(second.nextCursor).toBeNull();
      for (const cursor of ["", "!", "a".repeat(8193), btoa('{}'), btoa('{"v":1}')]) {
        const before = trace.reads.length;
        await expect(library.page(cursor)).rejects.toMatchObject({ code: "invalid_cursor" });
        expect(trace.reads.length).toBe(before);
      }
      const before = trace.reads.length;
      await expect(library.search({ version: 1, query: { text: "", mode: "literal", ignoreCase: false }, filter: all,
        cursor: first.nextCursor! })).rejects.toMatchObject({ code: "invalid_cursor" });
      expect(trace.reads.length).toBe(before);
      await f.db.prepare("UPDATE index_meta SET value='1' WHERE key='generation'").run();
      await expect(library.page(first.nextCursor!)).rejects.toMatchObject({ code: "stale_generation" });
    } finally { await f.dispose(); }
  }, 30_000);

  it("returns only slice deltas at invocation boundaries and binds exact query/filter identity", async () => {
    const f = await createLibraryFixture();
    try {
      const rows = Array.from({ length: 25 }, (_, i) => ({ summary: querySummary(i + 1), body: "target target" }));
      await seedQueryRows(f.db, rows);
      const query = { text: "target|absent", mode: "regex" as const, ignoreCase: false };
      const invocation = () => {
        const trace = observeQueryDB(f.db);
        // An observable ledger over real native reads, with eight available operations. HTTP's
        // production wrapper is independently owned; this proves query's boundary decisions.
        const budget = { get used() { return trace.reads.length; },
          get remaining() { return Math.max(0, 8 - trace.reads.length); },
          finalize: async <T,>(work: () => Promise<T>) => work() };
        return { trace, library: createLibraryIndex({ ...f.deps, db: trace.db, ...{ budget } }) };
      };
      const firstInvocation = invocation();
      const first = await firstInvocation.library.search({ version: 1, query, filter: all });
      expect(first.complete).toBe(false);
      expect(first.hits).toHaveLength(16);
      expect(firstInvocation.trace.reads.length).toBe(8);
      const collected = [...first.hits];
      const second = await invocation().library.search({ version: 1, query, filter: all, cursor: first.nextCursor! });
      collected.push(...second.hits);
      expect(second.complete).toBe(true);
      expect(collected).toEqual(rows.map(({ summary }) => ({ id: summary.id, version: summary.version, matchCount: 2 })));
      expect(new Set(collected.map((h) => h.id)).size).toBe(25);
      const trace = observeQueryDB(f.db);
      const library = createLibraryIndex({ ...f.deps, db: trace.db });
      for (const changed of [
        { query: { ...query, text: "target" }, filter: all },
        { query: { ...query, mode: "literal" as const }, filter: all },
        { query: { ...query, ignoreCase: true }, filter: all },
        { query, filter: { ...all, uploadedBefore: "2027-01-01" } },
      ]) {
        await expect(library.search({ version: 1, ...changed, cursor: first.nextCursor! })).rejects.toMatchObject({ code: "invalid_cursor" });
      }
      await expect(library.page(first.nextCursor!)).rejects.toMatchObject({ code: "invalid_cursor" });
      expect(trace.reads).toEqual([]);
      await f.db.prepare("UPDATE index_meta SET value='1' WHERE key='generation'").run();
      await expect(library.search({ version: 1, query, filter: all, cursor: first.nextCursor! })).rejects.toMatchObject({ code: "stale_generation" });
      await expect(library.snippets({ version: 1, generation: 0, query, refs: [rows[0].summary] }))
        .rejects.toMatchObject({ code: "stale_generation" });
    } finally { await f.dispose(); }
  }, 20_000);

  it("fails every mixed-generation response after a real concurrent D1 mutation", async () => {
    const f = await createLibraryFixture();
    try {
      await seedQueryRows(f.db, [{ summary: querySummary(1), body: "target" }]);
      const query = { text: "target", mode: "literal" as const, ignoreCase: false };
      for (const op of ["page", "search", "snippets"] as const) {
        await f.db.prepare("UPDATE index_meta SET value='0' WHERE key='generation'").run();
        let mutated = false;
        const trace = observeQueryDB(f.db, async (sql) => {
          if (!mutated && sql.some((s) => op === "page" ? s.includes("uploaded_at_iso")
            : op === "search" ? s.includes("WITH selected") : s.includes("WITH requested"))) {
            mutated = true;
            await f.db.prepare("UPDATE index_meta SET value='1' WHERE key='generation'").run();
          }
        });
        const library = createLibraryIndex({ ...f.deps, db: trace.db });
        const result = op === "page" ? library.page() : op === "search" ? library.search({ version: 1, query, filter: all })
          : library.snippets({ version: 1, generation: 0, query, refs: [querySummary(1)] });
        await expect(result).rejects.toMatchObject({ code: "stale_generation" });
        expect(mutated).toBe(true);
      }
    } finally { await f.dispose(); }
  }, 20_000);

  it("includes asynchronous D1 waits in soft deadlines without inventing empty completion", async () => {
    let epoch = 1000;
    const f = await createLibraryFixture({ now: () => epoch });
    try {
      await seedQueryRows(f.db, [{ summary: querySummary(1), body: "target" }]);
      const query = { text: "target", mode: "literal" as const, ignoreCase: false };
      const makeLibrary = () => createLibraryIndex({ ...f.deps,
        db: observeQueryDB(f.db, async (sql) => {
          if (sql.some((s) => s.includes("WITH selected") || s.includes("WITH requested"))) {
            await Promise.resolve();
            epoch += 1001;
          }
        }).db });
      const result = await makeLibrary().search({ version: 1, query, filter: all });
      expect(result).toMatchObject({ hits: [], complete: false });
      expect(result.nextCursor).toBeTypeOf("string");
      expect((await f.library.search({ version: 1, query, filter: all, cursor: result.nextCursor! })).hits)
        .toEqual([{ id: querySummary(1).id, version: querySummary(1).version, matchCount: 1 }]);
      expect(await makeLibrary().snippets({ version: 1, generation: 0, query, refs: [querySummary(1)] }))
        .toMatchObject({ hits: [], unavailable: [], remaining: [{ id: querySummary(1).id, version: querySummary(1).version }] });
    } finally { await f.dispose(); }
  }, 20_000);

  it("validates malformed requests before I/O and keeps pattern/work failures explicit", async () => {
    const f = await createLibraryFixture();
    try {
      const trace = observeQueryDB(f.db);
      const library = createLibraryIndex({ ...f.deps, db: trace.db });
      const request = { version: 1 as const, query: { text: "abc", mode: "literal" as const, ignoreCase: false }, filter: all };
      await expect(library.search({ ...request, query: { ...request.query, text: "😀".repeat(65) } }))
        .rejects.toMatchObject({ code: "search_budget_exceeded" });
      await expect(library.search({ ...request, query: { ...request.query, mode: "regex", text: "(?=x)" } }))
        .rejects.toMatchObject({ code: "invalid_pattern" });
      await expect(library.search({ ...request, filter: { ...all, uploadedAfter: "invalid" } }))
        .rejects.toMatchObject({ code: "invalid_search_request" });
      await expect(library.snippets({ version: 1, generation: 0, query: request.query,
        refs: [querySummary(1), querySummary(1)] })).rejects.toMatchObject({ code: "invalid_search_request" });
      await expect(library.snippets({ version: 1, generation: 0, query: request.query,
        refs: Array.from({ length: 49 }, (_, i) => querySummary(i + 1)) })).rejects.toMatchObject({ code: "invalid_search_request" });
      expect(trace.reads).toEqual([]);
      await seedQueryRows(f.db, [{ summary: querySummary(1), body: "a".repeat(512 * 1024) }]);
      // General RE2 suffix-lookahead consumes the shared aggregate work budget. A budget
      // failure is a safe error, never a successful empty/complete response or hidden retry.
      await expect(library.search({ ...request, query: { text: "a.*b|a", mode: "regex", ignoreCase: false } }))
        .rejects.toMatchObject({ code: "search_budget_exceeded" });
    } finally { await f.dispose(); }
  }, 20_000);

  it("filters before counting, reports complete scope, and treats an empty query as zero-count rows", async () => {
    const f = await createLibraryFixture();
    try {
      await seedQueryRows(f.db, [
        { summary: querySummary(1, { kind: "markdown", uploadedAt: "2026-10-01T00:00:00Z" }), body: "needle needle" },
        { summary: querySummary(2, { kind: "markdown", uploadedAt: "2026-10-02T00:00:00Z" }), body: "", state: "pending" },
        { summary: querySummary(3, { kind: "markdown", uploadedAt: "2026-10-03T00:00:00Z" }), body: "", state: "failed" },
        { summary: querySummary(4, { kind: "text", uploadedAt: "2026-10-01T00:00:00Z" }), body: "needle" },
      ]);
      const filter = { kinds: ["markdown" as const], uploadedAfter: "2026-10-01T00:00:00Z", uploadedBefore: "2026-10-03T00:00:00Z" };
      const query = { text: "needle", mode: "literal" as const, ignoreCase: false };
      const response = await f.library.search({ version: 1, query, filter });
      expect(response.hits).toEqual([{ id: querySummary(1).id, version: querySummary(1).version, matchCount: 2 }]);
      expect(response.scope).toEqual({ documents: 2, pending: 1, failed: 0 });
      expect(await searchAll(f, { ...query, text: "" }, filter)).toEqual([1, 2].map((n) => ({
        id: querySummary(n).id, version: querySummary(n).version, matchCount: 0,
      })));
    } finally { await f.dispose(); }
  }, 20_000);

  it("matches RE2 counts for literals, punctuation, grammar, Unicode and Aa over a varied corpus", async () => {
    const f = await createLibraryFixture();
    try {
      const paragraphs = [
        "Persistent query design keeps R2 identity authoritative. A metadata page reports coverage and exact versions. ",
        "aaa aaaa aaaaa banana bandana. C++ templates use quotes \" and 100% _under_score_. OR NOT NEAR : * ^ are literal text. ",
        "A phrase with spaces. ABC abc AbC KELVIN Kelvin ſearch SEARCH sss Kkſ. İ i ı I, café CAFÉ é É, Straße STRASSE. ",
        "Unicode orbit: ᲁ and д; emoji 😀 astral 𐐀 𐐨 rocket 🚀. Paths /a/b and literal [x] (a|b) a.*b are data. ",
        "Cancellation preserves a generation. A tombstone prevents late extraction resurrecting deleted documents. ",
      ];
      const rows = Array.from({ length: 128 }, (_, i) => ({
        summary: querySummary(i + 1, { title: `${paragraphs[i % 5]} title ${i}`,
          filename: `${i % 3 ? "Report-ABC" : "ſearch-Kelvin"}-${i}.txt`,
          kind: i % 2 ? "text" as const : "markdown" as const }),
        body: Array.from({ length: 12 }, (_, n) => paragraphs[(i + n * 3) % 5]).join(""),
      }));
      await seedQueryRows(f.db, rows);
      // Includes >19 terms, overlaps/non-overlaps, phrases, short/astral queries and every
      // operator that binding alone would leave active in the FTS query language.
      const terms = ["aaa", "aa", "a", "banana", "A phrase with spaces", "C++", "%", "_", '"',
        "OR", "NOT", "NEAR", ":", "*", "^", 'OR NOT NEAR : * ^', "ABC", "kelvin", "search",
        "sss", "i", "İ", "ı", "CAFÉ", "é", "Straße", "STRASSE", "ᲁ", "д", "😀", "𐐀", "🚀", "a.*b", "[x]", "absent"];
      for (const text of terms) for (const ignoreCase of [false, true]) {
        const query = { text, mode: "literal" as const, ignoreCase };
        const matcher = compileSearchMatcher(query);
        try {
          const expected = rows.flatMap(({ summary, body }) => {
            const match = matcher.match({ ...summary, body });
            return match ? [{ id: summary.id, version: summary.version, matchCount: match.matchCount }] : [];
          });
          expect(await searchAll(f, query), JSON.stringify(query)).toEqual(expected);
        } finally { matcher.dispose(); }
      }
    } finally { await f.dispose(); }
  }, 90_000);

  it("partitions snippet refs in order and preserves the authoritative UTF-16 windows", async () => {
    const f = await createLibraryFixture();
    try {
      const rows = [
        { summary: querySummary(1), body: "😀 before 🚀 needle café after" },
        { summary: querySummary(2), body: "no match" },
        { summary: querySummary(3), body: "needle", state: "deleting" as const },
        { summary: querySummary(4), body: "needle" },
      ];
      await seedQueryRows(f.db, rows);
      const refs = [rows[0].summary, rows[1].summary, querySummary(99), rows[2].summary,
        { ...rows[3].summary, version: "changed-version" }].map(({ id, version }) => ({ id, version }));
      const query = { text: "needle", mode: "literal" as const, ignoreCase: false };
      const matcher = compileSearchMatcher(query);
      const expected = matcher.match({ ...rows[0].summary, body: rows[0].body });
      matcher.dispose();
      expect(await f.library.snippets({ version: 1, generation: 0, query, refs })).toEqual({
        version: 1, generation: 0, hits: [{ ...refs[0], ...expected }], remaining: [], unavailable: refs.slice(1),
      });
      const empty = await f.library.snippets({ version: 1, generation: 0,
        query: { ...query, text: "" }, refs: [refs[0], refs[1]] });
      expect(empty.hits.map((h) => [h.id, h.matchCount])).toEqual([[refs[0].id, 0], [refs[1].id, 0]]);
      expect(empty.remaining).toEqual([]);
      expect(empty.unavailable).toEqual([]);
    } finally { await f.dispose(); }
  }, 20_000);
});
