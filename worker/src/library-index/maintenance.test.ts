import { describe, expect, it, vi } from "vitest";
import { createLibraryFixture } from "../library-index.test-support";
import { createLibraryRecords } from "./records";
import { createLibraryMaintenance } from "./maintenance";
import type { MaintainOptions } from "../library-contracts";
import { acquireMaintenanceLease, renewMaintenanceLease, releaseMaintenanceLease, saveMaintenanceMeta } from "./maintenance-lease";
import type { LibraryRecords } from "./contracts";
import { createInvocationResources } from "../invocation-budget";
import { createDocuments } from "../documents";
import { prepareMaintenanceStorage } from "./maintenance-storage";
import { extractText } from "../extract";

const limits: MaintainOptions = { documents: 12, textBytes: 32 * 1024 * 1024, listPages: 1, deadlineMs: 20_000 };

describe("library maintenance", () => {
  it("rejects malformed bounds and manual refs before any lease or record mutation", async () => {
    const f = await createLibraryFixture();
    try {
      const maintenance = createLibraryMaintenance(f.deps, createLibraryRecords(f.deps));
      for (const options of [
        { ...limits, documents: NaN }, { ...limits, deadlineMs: Infinity },
        { ...limits, listPages: -1 }, { ...limits, textBytes: 0.5 },
        { ...limits, reconcile: "yes" }, { ...limits, retry: [{ id: "unsafe/id", version: "a".repeat(64) }] },
        { ...limits, retry: Array.from({ length: 49 }, () => ({ id: "Retry001", version: "a".repeat(64) })) },
      ]) {
        await expect(maintenance.maintain(options as MaintainOptions)).rejects.toMatchObject({ code: "invalid_library_request", retryable: false });
      }
      expect((await f.db.prepare("SELECT key FROM index_meta ORDER BY key").all()).results).toEqual([{ key: "generation" }]);
    } finally { await f.dispose(); }
  }, 20_000);
});

// These private lease operations are the orchestration seam until integrated records/query
// land. D1 is native throughout; the interleaving proves ownership, not a fake SQL matcher.

it("same-clock contenders cannot write/release another nonce's lease, including after expiry", async () => {
  let now = 1000;
  let nonce = 0;
  const f = await createLibraryFixture({ now: () => now, nonce: () => `owner-${++nonce}` });
  try {
    const a = (await acquireMaintenanceLease(f.deps, 100))!;
    expect(a).toEqual({ token: "owner-1", expiresAt: 1200 });
    expect(await acquireMaintenanceLease(f.deps, 100)).toBeNull();
    await saveMaintenanceMeta(f.deps, a, [["anomalies", "1"], ["reconcile", "checkpoint-a"]]);
    now = 1200;
    const b = (await acquireMaintenanceLease(f.deps, 100))!;
    expect(b.token).toBe("owner-3");
    expect(await renewMaintenanceLease(f.deps, a, 100)).toBe(false);
    await releaseMaintenanceLease(f.deps, a);
    await saveMaintenanceMeta(f.deps, a, [["anomalies", "99"], ["reconcile", "stale-a"]]);
    expect(await f.db.prepare("SELECT token FROM index_meta WHERE key = 'maintenance-lease'").first("token")).toBe(b.token);
    expect(await f.db.prepare("SELECT value FROM index_meta WHERE key = 'reconcile'").first("value")).toBe("checkpoint-a");
    expect(await renewMaintenanceLease(f.deps, b, 100)).toBe(true);
    await saveMaintenanceMeta(f.deps, b, [["anomalies", "2"], ["reconcile", "checkpoint-b"]]);
    await releaseMaintenanceLease(f.deps, b);
    expect(await f.db.prepare("SELECT token FROM index_meta WHERE key = 'maintenance-lease'").first()).toBeNull();
    expect(await f.db.prepare("SELECT value FROM index_meta WHERE key = 'generation'").first("value")).toBe("0");
  } finally { await f.dispose(); }
}, 20_000);


function orchestrationRecords(f: Awaited<ReturnType<typeof createLibraryFixture>>): LibraryRecords {
  // Before lifecycle lands this is the one approved in-process seam. All bookkeeping,
  // leases, ranges and pages still use real D1/R2. Native lifecycle proof is separate below.
  return {
    documents: f.documents,
    ingest: vi.fn(async () => "written" as const),
    claim: vi.fn(async () => null),
    index: vi.fn(async () => ({ outcome: "indexed" as const, textBytes: 0 })),
    repairDeletion: vi.fn(async () => "deleted" as const),
    confirmMissing: vi.fn(async () => "written" as const),
    retry: vi.fn(async (refs) => refs.length),
  };
}

it("reconciles native R2 pages across runs, counts reservation pages, and skips a completed UTC day", async () => {
  const f = await createLibraryFixture();
  try {
    // Native page size is 200 raw keys, including internal reservations. ASCII order is
    // 0-9,A-Z,_,a-z; the private reservation page must not skip the later lowercase ID.
    await Promise.all(Array.from({ length: 205 }, (_, i) => f.bucket.put(`__docs_internal/reservations/${String(i).padStart(8, "0")}`, "")));
    for (const id of ["00000001", "A0000001", "Z0000001", "a0000001", "z0000001"]) await f.bucket.put(`${id}/note.txt`, "body");
    const records = orchestrationRecords(f);
    const maintenance = createLibraryMaintenance(f.deps, records);
    const first = await maintenance.maintain({ ...limits, documents: 0 });
    expect(first).toMatchObject({ outcome: "partial", reconciledPages: 1, generation: 0 });
    expect(first.status.lastReconciledAt).toBeNull();
    let next = first;
    let pages = 1;
    while (next.outcome !== "complete" && pages < 10) {
      next = await maintenance.maintain({ ...limits, documents: 0 });
      expect(next.reconciledPages).toBe(1);
      pages++;
    }
    expect(next).toMatchObject({ outcome: "complete", generation: 0 });
    expect(next.status.lastReconciledAt).not.toBeNull();
    expect(pages).toBeGreaterThanOrEqual(2);
    expect(vi.mocked(records.ingest).mock.calls.map(([summary]) => summary.id)).toEqual(["00000001", "A0000001", "Z0000001", "a0000001", "z0000001"]);
    const idle = await maintenance.maintain({ ...limits, documents: 0 });
    expect(idle.reconciledPages).toBe(0);
    expect(vi.mocked(records.ingest)).toHaveBeenCalledTimes(5);
  } finally { await f.dispose(); }
}, 20_000);

it("checkpoints within a page at the deadline and resumes after the last successful difference", async () => {
  let now = Date.now();
  const f = await createLibraryFixture({ now: () => now });
  try {
    for (const id of ["Resume01", "Resume02", "Resume03"]) await f.bucket.put(`${id}/note.txt`, "body");
    const records = orchestrationRecords(f);
    vi.mocked(records.ingest).mockImplementation(async () => { now += 100; return "written"; });
    const maintenance = createLibraryMaintenance(f.deps, records);
    const first = await maintenance.maintain({ ...limits, documents: 0, deadlineMs: 150 });
    expect(first).toMatchObject({ outcome: "partial", reconciledPages: 0 });
    expect(JSON.parse((await f.db.prepare("SELECT value FROM index_meta WHERE key='reconcile'").first<string>("value"))!)).toMatchObject({ afterId: "Resume02", cursor: null });
    const next = await maintenance.maintain({ ...limits, documents: 0, deadlineMs: 150 });
    expect(next).toMatchObject({ outcome: "complete", reconciledPages: 1 });
    expect(vi.mocked(records.ingest).mock.calls.map(([summary]) => summary.id)).toEqual(["Resume01", "Resume02", "Resume03"]);
  } finally { await f.dispose(); }
}, 20_000);


function invocation(f: Awaited<ReturnType<typeof createLibraryFixture>>, extract: typeof extractText = extractText) {
  const resources = createInvocationResources(() => f.db, f.bucket);
  const deps = { ...f.deps, db: resources.db, budget: resources.budget,
    documents: createDocuments(resources.bucket, f.deps.publicOrigin), extract };
  return { resources, deps, records: createLibraryRecords(deps),
    maintain: (options: MaintainOptions) => createLibraryMaintenance(deps, createLibraryRecords(deps)).maintain(options) };
}

it("backfills real records across bounded invocations and charges combined native D1/R2 costs below50", async () => {
  let now = Date.now();
  const f = await createLibraryFixture({ now: () => now });
  try {
    for (let i = 0; i < 13; i++) await f.bucket.put(`Back${String(i).padStart(4, "0")}/note.txt`, "a searchable needle");
    let indexed = 0;
    for (let i = 0; i < 20; i++) {
      now += 41_000; // Also permits recovery of a claim whose indivisible write could not fit.
      const run = invocation(f);
      const report = await run.maintain(limits);
      expect(run.resources.budget.used).toBeLessThanOrEqual(50);
      expect(report.processed).toBeLessThanOrEqual(12);
      expect(report.textBytes).toBeLessThanOrEqual(limits.textBytes);
      indexed = report.status.counts.indexed;
      if (indexed === 13) break;
      expect(report.outcome).toBe("partial");
    }
    expect(indexed).toBe(13);
    expect((await f.db.prepare("SELECT body FROM document_text").all()).results).toHaveLength(13);
    const generation = await f.db.prepare("SELECT value FROM index_meta WHERE key='generation'").first("value");
    const unchanged = await invocation(f).maintain({ ...limits, reconcile: true });
    expect(unchanged).toMatchObject({ outcome: "complete", indexed: 0, processed: 0, reconciledPages: 1 });
    expect(await f.db.prepare("SELECT value FROM index_meta WHERE key='generation'").first("value")).toBe(generation);
  } finally { await f.dispose(); }
}, 30_000);

it("pauses a tiny storage budget before its first sample and keeps names/pending state visible", async () => {
  const f = await createLibraryFixture({ config: { sizeBudgetBytes: 100_000 } });
  try {
    await f.bucket.put("Tiny0001/note.txt", "needle");
    await invocation(f).maintain(limits);
    const before = await f.db.prepare("SELECT value FROM index_meta WHERE key='generation'").first("value");
    const report = await invocation(f).maintain(limits);
    expect(report).toMatchObject({ outcome: "paused", processed: 0, status: {
      counts: { pending: 1, documents: 1 }, storage: { paused: true, reason: "paused: index size budget", projectedBytes: null },
    } });
    expect(report.status.storage.bytes).toBeLessThan(100_000);
    expect(await f.db.prepare("SELECT claim_token FROM documents WHERE id='Tiny0001'").first("claim_token")).toBeNull();
    expect(await f.db.prepare("SELECT value FROM index_meta WHERE key='generation'").first("value")).toBe(before);
  } finally { await f.dispose(); }
}, 20_000);

it("stops after five failures, respects backoff, and retries only exact manually supplied refs", async () => {
  let now = Date.now();
  const f = await createLibraryFixture({ now: () => now });
  try {
    await f.bucket.put("Fail0001/bad.txt", new Uint8Array([0xff]));
    await invocation(f).maintain(limits);
    let report = await invocation(f).maintain(limits);
    expect(report.failed).toBe(1);
    expect(await f.db.prepare("SELECT attempts FROM documents WHERE id='Fail0001'").first("attempts")).toBe(1);
    const backedOff = await invocation(f).maintain(limits);
    expect(backedOff.processed).toBe(0);
    for (let i = 1; i < 5; i++) { now += 3_600_001; report = await invocation(f).maintain(limits); expect(report.failed).toBe(1); }
    now += 3_600_001;
    expect((await invocation(f).maintain(limits)).processed).toBe(0);
    expect(await f.db.prepare("SELECT attempts FROM documents WHERE id='Fail0001'").first("attempts")).toBe(5);
    const generation = await f.db.prepare("SELECT value FROM index_meta WHERE key='generation'").first("value");
    await invocation(f).maintain({ ...limits, documents: 0, retry: [{ id: "Fail0001", version: "0".repeat(64) }] });
    expect(await f.db.prepare("SELECT attempts FROM documents WHERE id='Fail0001'").first("attempts")).toBe(5);
    const version = (await f.documents.resolve("Fail0001"))!.summary.version;
    await invocation(f).maintain({ ...limits, documents: 0, retry: [{ id: "Fail0001", version }] });
    expect(await f.db.prepare("SELECT attempts FROM documents WHERE id='Fail0001'").first("attempts")).toBe(0);
    expect(await f.db.prepare("SELECT value FROM index_meta WHERE key='generation'").first("value")).toBe(generation);
    expect((await invocation(f).maintain(limits)).failed).toBe(1);
  } finally { await f.dispose(); }
}, 30_000);

it("uses measured allocation after50 indexed samples and pauses before projected corpus growth", async () => {
  const budgetBytes = 3_500_000;
  const f = await createLibraryFixture({ config: { sizeBudgetBytes: budgetBytes } });
  try {
    const records = createLibraryRecords({ ...f.deps, extract: extractText });
    for (let i = 0; i < 50; i++) {
      const id = `Samp${String(i).padStart(4, "0")}`;
      await f.bucket.put(`${id}/note.txt`, `real indexed sample ${i}`);
      const summary = (await f.documents.resolve(id))!.summary;
      await records.ingest(summary, f.deps.now());
      expect((await records.index((await records.claim(summary))!)).outcome).toBe("indexed");
      if (i === 48) {
        const lease = (await acquireMaintenanceLease(f.deps, 20_000))!;
        expect(await prepareMaintenanceStorage(f.deps, lease)).toBe(true);
        const storage = JSON.parse((await f.db.prepare("SELECT value FROM index_meta WHERE key='storage'").first<string>("value"))!);
        expect(storage.projectedBytes).toBeNull();
        await releaseMaintenanceLease(f.deps, lease);
      }
    }
    // Native fixture setup creates a large remaining metadata corpus in one SQL statement;
    // no fake D1 implementation or production bookkeeping shortcuts are involved.
    await f.db.prepare(`WITH RECURSIVE sequence(n) AS (SELECT 0 UNION ALL SELECT n+1 FROM sequence WHERE n<1999)
      INSERT INTO documents(id,version,title,filename,kind,mime,size_bytes,uploaded_at,uploaded_at_iso,time_source,
        created_at,object_count,warnings_json,state,changed_at)
      SELECT 'Pend'||printf('%04d',n),version,title,filename,kind,mime,size_bytes,uploaded_at,uploaded_at_iso,time_source,
        created_at,object_count,warnings_json,'pending',changed_at FROM sequence CROSS JOIN documents WHERE id='Samp0000'`).run();
    const generation = await f.db.prepare("SELECT value FROM index_meta WHERE key='generation'").first("value");
    const report = await invocation(f).maintain({ ...limits, listPages: 0 });
    expect(report).toMatchObject({ outcome: "paused", processed: 0, status: { counts: { indexed: 50, pending: 2000 }, storage: { paused: true } } });
    expect(report.status.storage.projectedBytes).toBeGreaterThan(budgetBytes);
    expect(report.status.storage.bytes + Math.ceil(3.2 * 524288) + 16384).toBeLessThan(budgetBytes);
    expect(await f.db.prepare("SELECT value FROM index_meta WHERE key='generation'").first("value")).toBe(generation);
  } finally { await f.dispose(); }
}, 30_000);

it("reports permanent deleted-ID rewrites once per pass without indexing or deleting the R2 object", async () => {
  const f = await createLibraryFixture();
  try {
    await f.bucket.put("Gone0001/note.txt", "original");
    const records = createLibraryRecords({ ...f.deps, extract: extractText });
    const summary = (await f.documents.resolve("Gone0001"))!.summary;
    await records.ingest(summary, f.deps.now());
    await records.index((await records.claim(summary))!);
    await records.documents.remove(summary.id);
    await f.bucket.put("Gone0001/note.txt", "unsupported external resurrection");
    for (let i = 0; i < 2; i++) {
      const report = await invocation(f).maintain({ ...limits, reconcile: true });
      expect(report.status).toMatchObject({ anomalies: 1, counts: { documents: 0 } });
      expect(await f.bucket.get("Gone0001/note.txt")).not.toBeNull();
      expect(await f.db.prepare("SELECT id FROM documents WHERE id='Gone0001'").first()).toBeNull();
    }
  } finally { await f.dispose(); }
}, 20_000);

it("repairs stale deleting markers through records, restoring present objects and finalizing absent ones", async () => {
  let now = Date.now();
  const f = await createLibraryFixture({ now: () => now });
  try {
    const records = createLibraryRecords({ ...f.deps, extract: extractText,
      documents: { ...f.documents, async remove() { throw new Error("fixture R2 failure"); } } });
    for (const id of ["Keep0001", "Drop0001"]) {
      await f.bucket.put(`${id}/note.txt`, "retained body");
      const summary = (await f.documents.resolve(id))!.summary;
      await records.ingest(summary, now);
      await records.index((await records.claim(summary))!);
      await expect(records.documents.remove(id)).rejects.toThrow("fixture R2 failure");
    }
    await f.bucket.delete("Drop0001/note.txt");
    expect((await invocation(f).maintain({ ...limits, listPages: 0 })).repaired).toBe(0);
    now += 600_001;
    const report = await invocation(f).maintain(limits);
    expect(report.repaired).toBe(2);
    expect(await f.db.prepare("SELECT state FROM documents WHERE id='Keep0001'").first("state")).toBe("indexed");
    expect(await f.db.prepare("SELECT state FROM deleted_ids WHERE id='Drop0001'").first("state")).toBe("deleted");
    expect(await f.db.prepare("SELECT body FROM document_text").first("body")).toBe("retained body");
  } finally { await f.dispose(); }
}, 20_000);

it("a busy contender performs no housekeeping or record mutations", async () => {
  const f = await createLibraryFixture({ now: () => 1000 });
  try {
    const owner = await acquireMaintenanceLease(f.deps, 20_000);
    const before = (await f.db.prepare("SELECT * FROM index_meta ORDER BY key").all()).results;
    const records = orchestrationRecords(f);
    const report = await createLibraryMaintenance(f.deps, records).maintain(limits);
    expect(report).toMatchObject({ outcome: "busy", processed: 0, reconciledPages: 0, generation: 0 });
    expect((await f.db.prepare("SELECT * FROM index_meta ORDER BY key").all()).results).toEqual(before);
    expect(records.ingest).not.toHaveBeenCalled();
    expect(records.claim).not.toHaveBeenCalled();
    expect(owner).not.toBeNull();
  } finally { await f.dispose(); }
}, 20_000);

it("an expired extraction cannot replace its successor's text or clear the successor's lease", async () => {
  let now = Date.now();
  const f = await createLibraryFixture({ now: () => now });
  let finish!: () => void;
  let entered!: () => void;
  const waiting = new Promise<void>((resolve) => { entered = resolve; });
  const release = new Promise<void>((resolve) => { finish = resolve; });
  try {
    await f.bucket.put("Race0001/note.txt", "current text");
    const summary = (await f.documents.resolve("Race0001"))!.summary;
    await createLibraryRecords(f.deps).ingest(summary, now);
    const a = invocation(f, async (doc) => {
      const text = await extractText(doc);
      entered();
      await release;
      return { ...text, text: "stale text", indexedBytes: 10 };
    });
    const old = a.maintain(limits);
    await waiting;
    now += 40_001;
    const fresh = await invocation(f).maintain(limits);
    expect(fresh.indexed).toBe(1);
    const generation = fresh.generation;
    finish();
    const late = await old;
    expect(late.generation).toBe(generation);
    expect(await f.db.prepare("SELECT body FROM document_text").first("body")).toBe("current text");
    expect(await f.db.prepare("SELECT token FROM index_meta WHERE key='maintenance-lease'").first()).toBeNull();
  } finally { finish?.(); await f.dispose(); }
}, 20_000);

it("parks an opaque prefix that exhausts a fresh allowance, preserving its cursor without endless R2 replay", async () => {
  const f = await createLibraryFixture();
  let actualLists = 0;
  try {
    for (let i = 0; i < 42; i++) await f.bucket.put(`Long0001/${String(i).padStart(4, "0")}.txt`, "body");
    // Native R2 is permitted to return short truncated pages. Force that documented
    // behavior at the native binding seam so Documents performs its real internal traversal.
    const shortPages = new Proxy(f.bucket, { get(target, key) {
      if (key === "list") return (options: R2ListOptions) => { actualLists++; return target.list({ ...options, limit: 1 }); };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    const run = async (explicit = false) => {
      const resources = createInvocationResources(() => f.db, shortPages);
      const deps = { ...f.deps, db: resources.db, budget: resources.budget, documents: createDocuments(resources.bucket, f.deps.publicOrigin) };
      const report = await createLibraryMaintenance(deps, createLibraryRecords(deps)).maintain({ ...limits, documents: 0, reconcile: explicit });
      expect(resources.budget.used).toBeLessThanOrEqual(50);
      expect(report).toMatchObject({ outcome: "partial", reconciledPages: 0, status: { lastReconciledAt: null } });
    };
    await run();
    await run();
    const checkpoint = JSON.parse((await f.db.prepare("SELECT value FROM index_meta WHERE key='reconcile'").first<string>("value"))!);
    expect(checkpoint).toMatchObject({ cursor: null, listingRetry: true, listingBlocked: true });
    const before = actualLists;
    await run();
    expect(actualLists).toBe(before);
    await run(true);
    expect(actualLists).toBeGreaterThan(before);
    expect((await f.bucket.list({ prefix: "Long0001/" })).objects).toHaveLength(42);
  } finally { await f.dispose(); }
}, 20_000);

it("resumes native missing-row confirmation within a range when atomic record batches stop at the budget", async () => {
  const f = await createLibraryFixture({ now: () => Date.now() - 1000 });
  try {
    const records = createLibraryRecords(f.deps);
    for (let i = 0; i < 5; i++) {
      const id = `Miss${String(i).padStart(4, "0")}`;
      await f.bucket.put(`${id}/note.txt`, "removed outside decorated path");
      await records.ingest((await f.documents.resolve(id))!.summary, f.deps.now());
      await f.bucket.delete(`${id}/note.txt`);
    }
    const first = await invocation(f).maintain({ ...limits, documents: 0 });
    expect(first).toMatchObject({ outcome: "partial", reconciledPages: 0 });
    expect(first.status.lastReconciledAt).toBeNull();
    const next = await invocation(f).maintain({ ...limits, documents: 0 });
    expect(next).toMatchObject({ outcome: "complete", reconciledPages: 1, status: { counts: { documents: 0 } } });
    expect((await f.db.prepare("SELECT id FROM deleted_ids WHERE state='deleted'").all()).results).toHaveLength(5);
  } finally { await f.dispose(); }
}, 20_000);

it("does not tombstone a concurrent insertion absent from the captured R2 page at the same clock", async () => {
  let now = Date.now();
  const f = await createLibraryFixture({ now: () => now });
  try {
    const resources = createInvocationResources(() => f.db, f.bucket);
    const native = createDocuments(resources.bucket, f.deps.publicOrigin);
    const concurrentRecords = createLibraryRecords(f.deps);
    const deps = { ...f.deps, db: resources.db, budget: resources.budget, documents: { ...native,
      async page(cursor?: string) {
        const page = await native.page(cursor);
        now = Date.parse(page.observedAt);
        await f.bucket.put("New00001/note.txt", "new after the captured page");
        await concurrentRecords.ingest((await f.documents.resolve("New00001"))!.summary, now);
        return page;
      },
    } };
    const records = createLibraryRecords(deps);
    const confirm = vi.spyOn(records, "confirmMissing");
    const report = await createLibraryMaintenance(deps, records).maintain({ ...limits, documents: 0 });
    expect(report.status.counts.documents).toBe(1);
    expect(confirm).not.toHaveBeenCalled();
    expect(await f.db.prepare("SELECT id FROM deleted_ids WHERE id='New00001'").first()).toBeNull();
  } finally { await f.dispose(); }
}, 20_000);

it("admits only whole bounded bodies, clamps document limits, and awaits one extraction at a time", async () => {
  const f = await createLibraryFixture({ config: { drainDocuments: 1 } });
  try {
    const records = createLibraryRecords(f.deps);
    for (let i = 0; i < 3; i++) {
      const id = `Byte${String(i).padStart(4, "0")}`;
      await f.bucket.put(`${id}/note.txt`, "x".repeat(524288));
      await records.ingest((await f.documents.resolve(id))!.summary, f.deps.now());
    }
    const refused = await invocation(f).maintain({ ...limits, documents: 1000, textBytes: 524287, listPages: 0 });
    expect(refused).toMatchObject({ outcome: "partial", processed: 0, textBytes: 0 });
    let active = 0;
    let maximum = 0;
    const run = invocation(f, async (doc) => { active++; maximum = Math.max(maximum, active); try { return await extractText(doc); } finally { active--; } });
    const report = await run.maintain({ ...limits, documents: 1000, textBytes: 524288, listPages: 0 });
    expect(report).toMatchObject({ outcome: "partial", processed: 1, indexed: 1, textBytes: 524288 });
    expect(maximum).toBe(1);
    expect(run.resources.budget.used).toBeLessThanOrEqual(50);
  } finally { await f.dispose(); }
}, 20_000);

it("stops admitting new work after the elapsed deadline, including after an async extraction handoff", async () => {
  let now = Date.now();
  const f = await createLibraryFixture({ now: () => now });
  try {
    const records = createLibraryRecords(f.deps);
    for (const id of ["Time0001", "Time0002"]) {
      await f.bucket.put(`${id}/note.txt`, "bounded text");
      await records.ingest((await f.documents.resolve(id))!.summary, now);
    }
    const run = invocation(f, async (doc) => { const text = await extractText(doc); now += 101; return text; });
    const report = await run.maintain({ ...limits, deadlineMs: 100 });
    expect(report).toMatchObject({ outcome: "partial", processed: 1, indexed: 1, status: { counts: { pending: 1 } } });
  } finally { await f.dispose(); }
}, 20_000);

it("a no-change reconcile prepares no visible table mutations and keeps generation fixed", async () => {
  const f = await createLibraryFixture();
  try {
    await f.bucket.put("Idle0001/note.txt", "stable searchable text");
    await invocation(f).maintain(limits);
    await invocation(f).maintain(limits);
    const before = await f.db.prepare("SELECT value FROM index_meta WHERE key='generation'").first("value");
    const statements: string[] = [];
    const observed = new Proxy(f.db, { get(target, property) {
      if (property === "prepare") return (sql: string) => { statements.push(sql); return target.prepare(sql); };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    const resources = createInvocationResources(() => observed, f.bucket);
    const deps = { ...f.deps, db: resources.db, budget: resources.budget, documents: createDocuments(resources.bucket, f.deps.publicOrigin) };
    const report = await createLibraryMaintenance(deps, createLibraryRecords(deps)).maintain({ ...limits, reconcile: true });
    expect(report).toMatchObject({ outcome: "complete", processed: 0, reconciledPages: 1 });
    expect(report.generation).toBe(Number(before));
    expect(statements.filter((sql) => /(?:INSERT INTO|UPDATE|DELETE FROM)\s+(?:documents|document_text|document_fts|deleted_ids)\b/i.test(sql))).toEqual([]);
    expect(resources.budget.used).toBeLessThanOrEqual(15);
  } finally { await f.dispose(); }
}, 20_000);

it("reconciles and backfills real records over multiple native pages, then completes the discovered text backlog", async () => {
  let now = Date.now();
  const f = await createLibraryFixture({ now: () => now });
  try {
    const records = createLibraryRecords({ ...f.deps, extract: extractText });
    for (let i = 0; i < 205; i++) {
      const id = `Page${String(i).padStart(4, "0")}`;
      await f.bucket.put(`${id}/note.txt`, "native multipage body");
      if (i < 200) {
        const summary = (await f.documents.resolve(id))!.summary;
        await records.ingest(summary, now);
        await records.index((await records.claim(summary))!);
      }
    }
    let pages = 0;
    let report;
    for (let i = 0; i < 20; i++) {
      now += 41_000;
      const run = invocation(f);
      report = await run.maintain({ ...limits, documents: 0 });
      pages += report.reconciledPages;
      expect(run.resources.budget.used).toBeLessThanOrEqual(50);
      if (report.status.lastReconciledAt !== null) break;
      expect(report.outcome).toBe("partial");
    }
    expect(pages).toBeGreaterThanOrEqual(2);
    expect(report!.status).toMatchObject({ counts: { documents: 205, indexed: 200, pending: 5 } });
    expect(report!.status.lastReconciledAt).not.toBeNull();
    for (let i = 0; i < 10 && report!.status.counts.pending > 0; i++) {
      now += 41_000;
      report = await invocation(f).maintain(limits);
    }
    expect(report).toMatchObject({ outcome: "complete", status: { counts: { documents: 205, indexed: 205, pending: 0 } } });
  } finally { await f.dispose(); }
}, 60_000);

it("does not begin extraction if a claim handoff has already consumed the deadline", async () => {
  let now = Date.now();
  const f = await createLibraryFixture({ now: () => now });
  try {
    await f.bucket.put("Wait0001/note.txt", "body");
    const records = createLibraryRecords({ ...f.deps, extract: extractText });
    await records.ingest((await f.documents.resolve("Wait0001"))!.summary, now);
    const nativeClaim = records.claim;
    vi.spyOn(records, "claim").mockImplementation(async (...args) => { const claim = await nativeClaim(...args); now += 101; return claim; });
    const index = vi.spyOn(records, "index");
    const report = await createLibraryMaintenance(f.deps, records).maintain({ ...limits, deadlineMs: 100 });
    expect(report).toMatchObject({ outcome: "partial", processed: 0, indexed: 0 });
    expect(index).not.toHaveBeenCalled();
    now += 40_001;
    expect((await invocation(f).maintain(limits)).indexed).toBe(1);
  } finally { await f.dispose(); }
}, 20_000);
