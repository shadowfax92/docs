import { describe, expect, it } from "vitest";
import { build } from "esbuild";
// @ts-expect-error Node-only test adapter; the production Worker/browser targets omit Node types.
import { Worker } from "node:worker_threads";
import type { DocumentFilter, DocumentSummary, TextRecord } from "./contracts";
import { createSearchIndex, type SearchQuery, type SearchWorkerRequest, type SearchWorkerResponse } from "./search";

const all: DocumentFilter = { kinds: [], uploadedBefore: null, uploadedAfter: null };
const literal = (text: string, ignoreCase = true): SearchQuery => ({ text, mode: "literal", ignoreCase });
function document(id: string, body: string, changes: Partial<DocumentSummary> = {}) {
  const summary: DocumentSummary = {
    id, version: "fixture-version", filename: "note.txt", title: "A note", kind: "text", mime: "text/plain",
    sizeBytes: body.length, uploadedAt: "2026-10-14T12:00:00.000Z", timeSource: "r2", createdAt: null,
    publicUrl: `https://docs.example/${id}`, rawUrl: "", downloadUrl: "", objectCount: 1, warnings: [], ...changes,
  };
  const text: TextRecord = {
    version: 1, id, documentVersion: summary.version, coverage: "full", reason: null, text: body,
    sourceBytes: body.length, indexedBytes: new TextEncoder().encode(body).length, extractorVersion: 1,
  };
  return { summary, text };
}

describe("createSearchIndex", () => {
  it("counts nonoverlapping matches across independent fields and ranks count, newest date, then ID", () => {
    const index = createSearchIndex();
    for (const fixture of [
      document("Rank0003", "needle", { uploadedAt: "2026-10-13T12:00:00Z" }),
      document("Rank0002", "needle"), document("Rank0001", "needle"),
      document("Rank0004", "needle NEEDLE", { title: "needle", filename: "needle.txt" }),
    ]) index.add(fixture.summary, fixture.text);
    expect(index.query(literal("needle"), all).map(({ id, matchCount }) => [id, matchCount]))
      .toEqual([["Rank0004", 4], ["Rank0001", 1], ["Rank0002", 1], ["Rank0003", 1]]);
  });

  it("defaults to literal mode, preserves explicit case and counts nonoverlapping occurrences", () => {
    const index = createSearchIndex();
    const fixture = document("Literal1", "a.b A.B axb ababa");
    index.add(fixture.summary, fixture.text);
    expect(index.query(literal("a.b"), all)[0].matchCount).toBe(2);
    expect(index.query(literal("a.b", false), all)[0].matchCount).toBe(1);
    expect(index.query({ ...literal("a.b"), mode: "regex" }, all)[0].matchCount).toBe(3);
    expect(index.query(literal("aba"), all)[0].matchCount).toBe(1);
  });

  it("returns plain snippets and UTF-16 highlight ranges, including astral and folded Unicode", () => {
    const index = createSearchIndex();
    const fixture = document("Unicode1", "<script>😀 Élan 😀</script>");
    index.add(fixture.summary, fixture.text);
    const hit = index.query(literal("😀"), all)[0];
    expect(hit.snippet).toBe("<script>😀 Élan 😀</script>");
    expect(hit.ranges).toEqual([[8, 10], [16, 18]]);
    expect(index.query(literal("élan"), all)[0].ranges).toEqual([[11, 15]]);
    const cropped = document("Unicode2", "😀".repeat(100) + " target " + "😀".repeat(100));
    index.add(cropped.summary, cropped.text);
    const window = index.query(literal("target"), all)[0];
    expect(window.ranges.map(([start, end]) => window.snippet.slice(start, end))).toEqual(["target"]);
    expect(window.snippet).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u);
  });

  it("keeps exact large counts while limiting snippet ranges", () => {
    const index = createSearchIndex();
    const fixture = document("Counts01", "x ".repeat(10000), { filename: "notes.md" });
    index.add(fixture.summary, fixture.text);
    const hit = index.query(literal("x"), all)[0];
    expect(hit.matchCount).toBe(10000);
    expect(hit.ranges).toHaveLength(20);
    expect(hit.snippet.length).toBeLessThanOrEqual(243);
  });

  it("preserves RE2 simple-fold classes, literal punctuation and original UTF-16 offsets", () => {
    const index = createSearchIndex();
    const fixture = document("Folding1", "K k K ſ s S Σ σ ς ß ẞ ss İ ı I i 𐐀 𐐨 😀 é e\u0301 [a-z]+.*?$^|(){}\\E");
    index.add(fixture.summary, fixture.text);
    const cases: [string, string[]][] = [
      ["k", ["K", "k", "K"]], ["σ", ["Σ", "σ", "ς"]],
      ["ß", ["ß", "ẞ"]], ["ss", ["ss"]],
      ["İ", ["İ"]], ["ı", ["ı"]], ["i", ["I", "i"]],
      ["𐐀", ["𐐀", "𐐨"]], ["é", ["é"]],
      ["[a-z]+.*?$^|(){}\\E", ["[a-z]+.*?$^|(){}\\E"]],
    ];
    for (const [query, expected] of cases) {
      const hit = index.query(literal(query), all)[0];
      expect(hit.matchCount).toBe(expected.length);
      expect(hit.ranges.map(([start, end]) => hit.snippet.slice(start, end))).toEqual(expected);
    }
    expect(index.query(literal("ſ"), all)[0].matchCount).toBe(5);
    const astral = index.query(literal("𐐀", false), all)[0];
    expect(astral.matchCount).toBe(1);
    expect(astral.ranges).toEqual([[33, 35]]);
  });

  it("searches long body and filename literals over a fully admitted 485-document, 10 MiB corpus", () => {
    const index = createSearchIndex();
    const needle = "OwnedBodyNeedleec059c3e";
    const filename = "owned-ec059c3e-pdf-acceptance";
    const filler = "Ordinary document prose with numbers 0123456789 and punctuation. ";
    const bodyLength = Math.ceil(10 * 1024 * 1024 / 467);
    const padding = filler.repeat(Math.ceil(bodyLength / filler.length));
    for (let number = 0; number < 485; number++) {
      const prefix = number === 0 ? `${needle} ${needle} ${needle.toLowerCase()} ` : number === 1 ? `${needle} ` : "";
      const fixture = document(String(number).padStart(8, "0"), number < 467 ? (prefix + padding).slice(0, bodyLength) : "", {
        filename: number === 484 ? `${filename}.pdf` : `document-${number}.txt`,
      });
      if (number >= 467) fixture.text.coverage = "metadata-only";
      else if (number < 20) fixture.text.coverage = "truncated";
      index.add(fixture.summary, fixture.text);
    }
    expect(index.query(literal(""), all)).toHaveLength(485);
    for (const ignoreCase of [false, true]) {
      expect(index.query(literal(needle, ignoreCase), all).map(({ id, matchCount }) => [id, matchCount]))
        .toEqual([["00000000", ignoreCase ? 3 : 2], ["00000001", 1]]);
      expect(index.query(literal(filename, ignoreCase), all).map(({ id, matchCount }) => [id, matchCount]))
        .toEqual([["00000484", 1]]);
      expect(index.query(literal("ec059c3e", ignoreCase), all).map(({ id, matchCount }) => [id, matchCount]))
        .toEqual([["00000000", 3], ["00000001", 1], ["00000484", 1]]);
    }
  });

  it("treats empty queries as filtered listing and never counts zero-width matches", () => {
    const index = createSearchIndex();
    const fixture = document("Empty001", "😀aaa");
    index.add(fixture.summary, fixture.text);
    expect(index.query(literal(""), all)[0].matchCount).toBe(0);
    expect(index.query({ text: "^|$|\\b", mode: "regex", ignoreCase: false }, all)).toEqual([]);
    expect(index.query({ text: "a*", mode: "regex", ignoreCase: false }, all)[0].matchCount).toBe(1);
  });

  it("rejects unsupported/invalid regex and expensive expansion without a native fallback", () => {
    const index = createSearchIndex();
    for (const text of ["(?=x)", "(?<=x)y", "(a)\\1", "[", "a{1001}"]) {
      expect(() => index.query({ text, mode: "regex", ignoreCase: false }, all)).toThrow(expect.objectContaining({ code: "invalid_pattern" }));
    }
    for (const text of ["x".repeat(257), "😀".repeat(65), "(a{1000}){1000}"]) {
      expect(() => index.query({ text, mode: "regex", ignoreCase: false }, all)).toThrow(expect.objectContaining({ code: "search_budget_exceeded" }));
    }
  });

  it("evaluates catastrophic-backtracking patterns with bounded RE2 matching", () => {
    const index = createSearchIndex();
    const fixture = document("Linear01", "a".repeat(100000) + "!");
    index.add(fixture.summary, fixture.text);
    expect(index.query({ text: "(a+)+$", mode: "regex", ignoreCase: false }, all)).toEqual([]);
  });

  it("stops repeated greedy suffix rescans with an explicit budget error", () => {
    const index = createSearchIndex();
    for (const body of ["a".repeat(100000), "a".repeat(255) + "c".repeat(524033)]) {
      const fixture = document("Rescans1", body);
      index.add(fixture.summary, fixture.text);
      expect(() => index.query({ text: "a.*b|a", mode: "regex", ignoreCase: false }, all))
        .toThrow(expect.objectContaining({ code: "search_budget_exceeded" }));
    }
  });

  it("applies kinds and strict upper/inclusive lower cutoffs before expensive matching", () => {
    const index = createSearchIndex();
    const fixture = document("Filter01", "x".repeat(500000), { kind: "html" });
    index.add(fixture.summary, fixture.text);
    const expensive: SearchQuery = { text: "x{1000}", mode: "regex", ignoreCase: false };
    expect(() => index.query(expensive, all)).toThrow(expect.objectContaining({ code: "search_budget_exceeded" }));
    expect(index.query(expensive, { ...all, kinds: ["text"] })).toEqual([]);
    expect(index.query(expensive, { ...all, uploadedBefore: fixture.summary.uploadedAt })).toEqual([]);
    expect(index.query(literal(""), { ...all, uploadedAfter: fixture.summary.uploadedAt })).toHaveLength(1);
    expect(index.query(literal(""), { ...all, uploadedAfter: "2026-10-14T12:00:00.001Z" })).toEqual([]);
    expect(() => index.query(literal("x"), { ...all, uploadedBefore: "not a date" })).toThrow(expect.objectContaining({ code: "invalid_search_request" }));
  });

  it("retains metadata-only/error documents by name and replaces immutable snapshots by ID", () => {
    const index = createSearchIndex();
    const fixture = document("Replace1", "secret", { title: "metadata" });
    fixture.text.coverage = "error";
    index.add(fixture.summary, fixture.text);
    fixture.summary.title = "mutated";
    expect(index.query(literal("secret"), all)).toEqual([]);
    expect(index.query(literal("metadata"), all)).toHaveLength(1);
    const updated = document("Replace1", "new text", { version: "new-version" });
    index.add(updated.summary, updated.text);
    expect(index.query(literal("metadata"), all)).toEqual([]);
    expect(index.query(literal("new text"), all)[0].version).toBe("new-version");
    expect(() => index.add(updated.summary, { ...updated.text, documentVersion: "stale" })).toThrow(expect.objectContaining({ code: "invalid_search_request" }));
    index.clear();
    expect(index.query(literal(""), all)).toEqual([]);
  });

  it("makes failed memory admission explicit until clear and releases replacement/clear budgets", () => {
    const index = createSearchIndex();
    let rejected = false;
    for (let number = 0; number < 40; number++) {
      const fixture = document(String(number).padStart(8, "0"), "x".repeat(512 * 1024));
      try { index.add(fixture.summary, fixture.text); }
      catch (error) { expect(error).toMatchObject({ code: "search_budget_exceeded" }); rejected = true; break; }
    }
    expect(rejected).toBe(true);
    expect(() => index.query(literal(""), all)).toThrow(expect.objectContaining({ code: "search_budget_exceeded" }));
    index.clear();
    const fixture = document("Replace1", "x".repeat(512 * 1024));
    for (let number = 0; number < 40; number++) index.add(fixture.summary, fixture.text);
    expect(index.query(literal(""), all)).toHaveLength(1);
    index.clear();
    expect(index.query(literal("x"), all)).toEqual([]);
  });
});

it("uses the bundled worker protocol for generations, errors, FIFO additions and lifecycle clear", async () => {
  const bundled = await build({ entryPoints: ["src/ui/search-worker.ts"], bundle: true, write: false, format: "iife", platform: "browser", target: "es2022" });
  const worker = new Worker(`
    const {parentPort} = require('node:worker_threads');
    global.self = {postMessage: (message) => parentPort.postMessage(message)};
    ${bundled.outputFiles[0].text}
    parentPort.on('message', data => self.onmessage({data}));
  `, { eval: true });
  const send = (request: SearchWorkerRequest | object) => new Promise<SearchWorkerResponse>((resolve, reject) => {
    worker.once("message", (message: SearchWorkerResponse) => { worker.off("error", reject); resolve(message); });
    worker.once("error", reject);
    worker.postMessage(request);
  });
  try {
    const fixture = document("Worker01", "old private text");
    expect(await send({ version: 1, generation: 7, operation: "add", ...fixture })).toMatchObject({ generation: 7, status: "ready" });
    const response = await send({ version: 1, generation: 8, operation: "query", query: literal("private"), filter: all });
    expect(response).toMatchObject({ generation: 8, status: "results", hits: [{ id: "Worker01", matchCount: 1 }] });
    expect(await send({ version: 1, generation: 9, operation: "query", query: { text: "(?=a)", mode: "regex", ignoreCase: false }, filter: all }))
      .toMatchObject({ generation: 9, status: "error", code: "invalid_pattern" });
    expect(await send({ version: 1, generation: 10, operation: "clear" })).toMatchObject({ generation: 10, status: "ready" });
    expect(await send({ version: 1, generation: 11, operation: "query", query: literal(""), filter: all })).toMatchObject({ generation: 11, status: "results", hits: [] });
    expect(await send({ version: 1, generation: 12, operation: "unknown" })).toMatchObject({ generation: 12, status: "error", code: "invalid_search_request" });
  } finally { await worker.terminate(); }
});
