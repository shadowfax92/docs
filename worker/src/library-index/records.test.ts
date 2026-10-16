import { afterEach, describe, expect, it, vi } from "vitest";
import { createLibraryFixture } from "../library-index.test-support";
import type { TextRecord } from "../contracts";
import type { ResolvedDocument } from "../documents";
import { createLibraryRecords } from "./records";
import { createDocuments } from "../documents";
import { createInvocationResources, InvocationBudgetExceeded } from "../invocation-budget";
import { Headers as NativeHeaders } from "miniflare";

function barrier<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
type Fixture = Awaited<ReturnType<typeof createLibraryFixture>>;
const fixtures: Fixture[] = [];
async function setup(options: Parameters<typeof createLibraryFixture>[0] = {}) {
  // Host-side Documents must use Miniflare's own Headers implementation for native R2
  // conditional puts. This adapts only the host transport; SQL/R2/Documents stay real.
  vi.stubGlobal("Headers", NativeHeaders);
  const f = await createLibraryFixture(options);
  fixtures.push(f);
  return { ...f, records: createLibraryRecords(f.deps) };
}
afterEach(async () => { await Promise.all(fixtures.splice(0).map((f) => f.dispose())); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function seed(f: Fixture, id = "Records1", body = "body needle") {
  await f.bucket.put(`${id}/note.txt`, body, {
    customMetadata: { filename: "note.txt", contentType: "text/plain", docName: "Title searchable" },
  });
  return (await f.documents.resolve(id))!.summary;
}
async function generation(f: Fixture) { return Number(await f.db.prepare("SELECT value FROM index_meta WHERE key='generation'").first("value")); }
async function row(f: Fixture, id: string) { return f.db.prepare("SELECT * FROM documents WHERE id=?").bind(id).first<Record<string, unknown>>(); }
async function matches(f: Fixture, term: string) {
  return (await f.db.prepare("SELECT rowid FROM document_fts WHERE document_fts MATCH ?").bind(`"${term}"`).all()).results;
}
function text(id: string, version: string, value: string): TextRecord {
  return { version: 1, id, documentVersion: version, coverage: "full", reason: null,
    text: value, sourceBytes: value.length, indexedBytes: new TextEncoder().encode(value).length, extractorVersion: 1 };
}

describe("LibraryRecords native D1/R2 lifecycle", () => {
  it("publishes exact upload bytes and searchable names before deferred body, extracting once per version", async () => {
    const entered = barrier<void>(); const release = barrier<void>();
    const extract = vi.fn(async (doc: ResolvedDocument) => { entered.resolve(); await release.promise; return text(doc.summary.id, doc.summary.version, "deferred needle"); });
    const f = await setup({ extract });
    const bytes = new TextEncoder().encode("original\r\nbytes 😀\0");
    // Miniflare's host stream bridge loses fixed length; native R2 also accepts byte
    // bodies. The built Worker proof separately exercises the real Request.body seam.
    const stream = bytes as unknown as ReadableStream;
    const created = await f.records.documents.create({ body: stream, filename: "name.txt", title: "Title searchable", mime: "text/plain" });
    try {
      await entered.promise;
      expect(await row(f, created.id)).toMatchObject({ state: "pending", indexed_bytes: 0 });
      expect(await matches(f, "searchable")).toHaveLength(1);
      expect(await matches(f, "needle")).toHaveLength(0);
      const original = await f.bucket.get(`${created.id}/name.txt`);
      expect(new Uint8Array(await original!.arrayBuffer())).toEqual(bytes);
      expect(await f.records.claim(created)).toBeNull();
    } finally { release.resolve(); }
    await f.flush();
    expect(await row(f, created.id)).toMatchObject({ state: "indexed", coverage: "full" });
    expect(await matches(f, "needle")).toHaveLength(1);
    const g = await generation(f);
    expect(await f.records.ingest(created, Date.now())).toBe("unchanged");
    expect(await f.records.claim(created)).toBeNull();
    expect(await generation(f)).toBe(g);
    expect(extract).toHaveBeenCalledTimes(1);
    expect(await matches(f, "needle")).toHaveLength(1);
  }, 20_000);

  it("keeps a paused public upload pending without invoking extraction or spending attempts", async () => {
    const extract = vi.fn(); const f = await setup({ extract });
    await f.db.prepare("INSERT INTO index_meta(key,value) VALUES ('storage',?)").bind(JSON.stringify({
      bytes: 100, budgetBytes: 400_000_000, planningBytes: null, projectedBytes: 500_000_000, paused: true, reason: "paused: index size budget",
    })).run();
    const created = await f.records.documents.create({ body: null, filename: "name.txt", title: "Paused searchable", mime: "text/plain" });
    await f.flush();
    expect(extract).not.toHaveBeenCalled();
    expect(await row(f, created.id)).toMatchObject({ state: "pending", attempts: 0, claim_token: null });
    expect(await matches(f, "searchable")).toHaveLength(1);
    expect(await generation(f)).toBe(1);
  }, 20_000);

  it("does not let late extraction overwrite a newer version or a permanent delete", async () => {
    const entered = barrier<void>(); const release = barrier<void>();
    const f = await setup({ now: () => 1000, extract: async (doc) => { entered.resolve(); await release.promise; return text(doc.summary.id, doc.summary.version, "stale needle"); } });
    const old = await seed(f);
    await f.records.ingest(old, 1000);
    const claim = (await f.records.claim(old))!;
    const work = f.records.index(claim);
    await entered.promise;
    await f.bucket.put(`${old.id}/note.txt`, "newer body");
    const current = (await f.documents.resolve(old.id))!.summary;
    await f.records.ingest(current, 1000);
    release.resolve();
    expect(await work).toEqual({ outcome: "stale", textBytes: 12 });
    expect(await matches(f, "needle")).toHaveLength(0);
    expect(await row(f, old.id)).toMatchObject({ version: current.version, state: "pending" });
    await f.records.documents.remove(old.id, current.version);
    expect(await f.records.ingest(old, 1000)).toBe("tombstoned");
    expect(await row(f, old.id)).toBeNull();
    expect(await f.db.prepare("SELECT state FROM deleted_ids WHERE id=?").bind(old.id).first("state")).toBe("deleted");
  }, 20_000);
});

async function lease(f: Fixture, token = "lease-owner", expiresAt = 100_000) {
  await f.db.prepare(`INSERT INTO index_meta(key,value,token,expires_at) VALUES ('maintenance-lease','',?,?)
    ON CONFLICT(key) DO UPDATE SET token=excluded.token,expires_at=excluded.expires_at`).bind(token, expiresAt).run();
  return { token, expiresAt };
}
async function deleting(f: Fixture, id: string) {
  return (await f.db.prepare(`SELECT id,token,at,restore_state AS restoreState,restore_version AS restoreVersion
    FROM deleted_ids WHERE id=?`).bind(id).first<import("./contracts").DeletionClaim>())!;
}
async function indexed(f: Awaited<ReturnType<typeof setup>>, id = "Records1") {
  const summary = await seed(f, id);
  await f.records.ingest(summary, f.deps.now());
  const owned = (await f.records.claim(summary))!;
  expect(await f.records.index(owned)).toMatchObject({ outcome: "indexed" });
  return summary;
}
function withDb(f: Fixture, batch: D1Database["batch"]) {
  return createLibraryRecords({ ...f.deps, db: new Proxy(f.db, { get(target, key) {
    if (key === "batch") return batch;
    const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
  } }) });
}

describe("LibraryRecords persistence and ownership guards", () => {
  it("uses native extraction and retains body/rowid through current replay and metadata-only edits", async () => {
    const f = await setup({ now: () => 1000 }); const summary = await indexed(f);
    const before = (await row(f, summary.id))!; const g = await generation(f);
    expect(await f.records.ingest(summary, 1000)).toBe("unchanged");
    expect(await generation(f)).toBe(g);
    expect(await f.records.ingest({ ...summary, title: "Renamed searchable", warnings: ["inert"] }, 1000)).toBe("written");
    expect(await row(f, summary.id)).toMatchObject({ doc: before.doc, state: "indexed", indexed_bytes: 11, warnings_json: '["inert"]' });
    expect(await matches(f, "needle")).toEqual([{ rowid: before.doc }]);
    expect(await matches(f, "Renamed")).toHaveLength(1);
    expect(await generation(f)).toBe(g + 1);
  }, 20_000);

  it("bounds UTF-8 without splitting scalars and sanitizes control/NUL at the writer seam", async () => {
    const source = "start\0\u0001\u007f" + "😀".repeat(200_000);
    const f = await setup({ now: () => 1000, extract: async (doc) => text(doc.summary.id, doc.summary.version, source) });
    const summary = await indexed(f);
    const stored = await f.db.prepare("SELECT body FROM document_text").first<string>("body");
    expect(new TextEncoder().encode(stored!)).toHaveLength(524_288);
    expect(stored).not.toMatch(/[\u0000-\u0008\u007f\ufffd]/);
    expect(await row(f, summary.id)).toMatchObject({ state: "indexed", coverage: "truncated", indexed_bytes: 524_288 });
  }, 20_000);

  it("rolls back generation, metadata, text and FTS together when an admitted native batch fails", async () => {
    const f = await setup({ now: () => 1000 }); const summary = await seed(f);
    const broken = withDb(f, (statements) => f.db.batch([...statements, f.db.prepare("SELECT no_such_column FROM documents")]));
    await expect(broken.ingest(summary, 1000)).rejects.toThrow();
    expect(await row(f, summary.id)).toBeNull();
    expect(await generation(f)).toBe(0);
    expect(await matches(f, "searchable")).toHaveLength(0);
    expect(await f.db.prepare("SELECT token FROM index_meta WHERE key='generation'").first("token")).toBeNull();
    await f.records.ingest(summary, 1000);
    const owned = (await f.records.claim(summary))!;
    await expect(broken.index(owned)).rejects.toThrow();
    expect(await row(f, summary.id)).toMatchObject({ state: "pending", claim_token: owned.token });
    expect(await f.db.prepare("SELECT count(*) AS n FROM document_text").first("n")).toBe(0);
    expect(await generation(f)).toBe(1);
    expect(await f.records.index(owned)).toMatchObject({ outcome: "indexed" });
  }, 20_000);

  it("preserves a successful upload response on D1 outage and observes deferred failures safely", async () => {
    const f = await setup(); const log = vi.spyOn(console, "warn").mockImplementation(() => {});
    const broken = withDb(f, async () => { throw new Error("private SQL body secret"); });
    const summary = await broken.documents.create({ body: null, filename: "empty.txt", title: "Kept", mime: "text/plain" });
    expect(await f.documents.resolve(summary.id)).not.toBeNull();
    expect(await row(f, summary.id)).toBeNull();
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/private|secret|SQL/);
    expect(await f.records.ingest(summary, Date.now())).toBe("written");
    const deferred = createLibraryRecords({ ...f.deps, extract: async () => { throw new Error("private body"); } });
    await deferred.documents.create({ body: null, filename: "empty.txt", title: "Retry", mime: "text/plain" });
    await f.flush();
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/private|secret|SQL/);
  }, 20_000);

  it("backs off failures, caps attempts, and retries exact failed refs without generation bookkeeping bumps", async () => {
    let now = 1000;
    const f = await setup({ now: () => now, config: { maxAttempts: 2 }, extract: async () => { throw new Error("unsafe error detail"); } });
    const summary = await seed(f); await f.records.ingest(summary, now);
    expect(await f.records.index((await f.records.claim(summary))!)).toMatchObject({ outcome: "failed" });
    expect(await row(f, summary.id)).toMatchObject({ attempts: 1, retry_at: 61_000, state: "failed" });
    const firstFailure = await generation(f);
    expect(await f.records.claim(summary)).toBeNull();
    now = 61_000;
    expect(await f.records.index((await f.records.claim(summary))!)).toMatchObject({ outcome: "failed" });
    expect(await row(f, summary.id)).toMatchObject({ attempts: 2, retry_at: null });
    expect(await generation(f)).toBe(firstFailure);
    expect(await f.records.claim(summary)).toBeNull();
    const ownedLease = await lease(f, "retry", now + 100_000);
    expect(await f.records.retry([{ ...summary, version: "stale" }], ownedLease)).toBe(0);
    expect(await f.records.retry([summary], ownedLease)).toBe(1);
    expect(await f.records.retry([summary], ownedLease)).toBe(0);
    expect(await generation(f)).toBe(firstFailure);
    expect(await f.records.claim(summary, ownedLease)).not.toBeNull();
  }, 20_000);

  it("rejects expired/foreign leases and claims, but accepts a live renewal of the same lease token", async () => {
    let now = 1000; const f = await setup({ now: () => now }); const summary = await seed(f);
    const owner = await lease(f, "first", 1500);
    await f.records.ingest(summary, now, owner);
    const claimed = (await f.records.claim(summary, owner))!;
    const g = await generation(f);
    now = 1500;
    expect(await f.records.index(claimed)).toMatchObject({ outcome: "stale" });
    expect(await f.records.ingest({ ...summary, title: "expired" }, now, owner)).toBe("stale");
    await lease(f, owner.token, 5000);
    expect(await f.records.index(claimed)).toMatchObject({ outcome: "indexed" });
    expect(await generation(f)).toBe(g + 1);
    const next = await seed(f, "Records2"); await f.records.ingest(next, now);
    const old = (await f.records.claim(next, owner))!;
    await lease(f, "second", 100_000);
    expect(await f.records.index(old)).toMatchObject({ outcome: "stale" });
    now = old.expiresAt;
    const fresh = (await f.records.claim(next, { token: "second", expiresAt: 100_000 }))!;
    expect(fresh.token).not.toBe(old.token);
    expect(await f.records.index(old)).toMatchObject({ outcome: "stale" });
    expect(await row(f, next.id)).toMatchObject({ claim_token: fresh.token });
  }, 20_000);

  it("rechecks a size pause installed during extraction and does not create failed attempts", async () => {
    const entered = barrier<void>(); const release = barrier<void>();
    const f = await setup({ now: () => 1000, extract: async (doc) => { entered.resolve(); await release.promise; return text(doc.summary.id, doc.summary.version, "body needle"); } });
    const summary = await seed(f); await f.records.ingest(summary, 1000);
    const work = f.records.index((await f.records.claim(summary))!); await entered.promise;
    await f.db.prepare("INSERT INTO index_meta(key,value) VALUES ('storage',?)").bind(JSON.stringify({
      bytes: 100, budgetBytes: 400_000_000, planningBytes: null, projectedBytes: null, paused: true, reason: "paused: index size budget",
    })).run();
    release.resolve();
    expect(await work).toEqual({ outcome: "paused", textBytes: 11 });
    expect(await row(f, summary.id)).toMatchObject({ state: "pending", attempts: 0, claim_token: null });
    expect(await generation(f)).toBe(1);
    expect(await matches(f, "needle")).toHaveLength(0);
  }, 20_000);

  it("enforces actual D1 capacity on direct uploads even before maintenance has stored a pause", async () => {
    const extract = vi.fn(); const f = await setup({ extract, config: { sizeBudgetBytes: 100 } });
    const summary = await f.records.documents.create({ body: null, filename: "x.txt", title: "Searchable", mime: "text/plain" });
    await f.flush();
    expect(extract).not.toHaveBeenCalled();
    expect(await row(f, summary.id)).toMatchObject({ state: "pending", attempts: 0, claim_token: null });
    const storage = JSON.parse((await f.db.prepare("SELECT value FROM index_meta WHERE key='storage'").first<string>("value"))!);
    expect(storage).toMatchObject({ paused: true, reason: "paused: index size budget", budgetBytes: 100 });
    expect(storage.bytes).toBeGreaterThan(100);
  }, 20_000);
});

describe("LibraryRecords durable deletion races", () => {
  it.each([false, true])("hides legacy IDs absent from D1 before public/reviewed R2 removal (reviewed=%s)", async (reviewed) => {
    const f = await setup({ now: () => 1000 }); const summary = await seed(f);
    const remove = vi.fn(async (id: string, version?: string) => {
      expect(await f.db.prepare("SELECT state FROM deleted_ids WHERE id=?").bind(id).first("state")).toBe("deleting");
      expect(await row(f, id)).toBeNull();
      expect(await f.records.ingest(summary, 1000)).toBe("tombstoned");
      return f.documents.remove(id, version);
    });
    const records = createLibraryRecords({ ...f.deps, documents: { ...f.documents, remove } });
    expect(await records.documents.remove(summary.id, reviewed ? summary.version : undefined)).toMatchObject({ status: "deleted" });
    expect(await f.documents.resolve(summary.id)).toBeNull();
    expect(await f.db.prepare("SELECT state FROM deleted_ids WHERE id=?").bind(summary.id).first("state")).toBe("deleted");
    expect(await generation(f)).toBe(0);
    expect(await records.documents.remove(summary.id)).toMatchObject({ status: "not-found" });
    expect(remove).toHaveBeenCalledTimes(1);
  }, 20_000);

  it("never steals an active same-clock delete nonce or duplicates its R2 removal", async () => {
    const f = await setup({ now: () => 1000 }); const summary = await indexed(f);
    const entered = barrier<void>(); const release = barrier<void>();
    const remove = vi.fn(async (id: string, version?: string) => { entered.resolve(); await release.promise; return f.documents.remove(id, version); });
    const records = createLibraryRecords({ ...f.deps, documents: { ...f.documents, remove } });
    const first = records.documents.remove(summary.id, summary.version); await entered.promise;
    const owner = await deleting(f, summary.id); const g = await generation(f);
    await expect(records.documents.remove(summary.id, summary.version)).rejects.toMatchObject({ code: "library_unavailable" });
    expect(await deleting(f, summary.id)).toEqual(owner);
    expect(await generation(f)).toBe(g);
    release.resolve(); expect(await first).toMatchObject({ status: "deleted" });
    expect(remove).toHaveBeenCalledTimes(1);
    expect(await generation(f)).toBe(g);
    expect(await row(f, summary.id)).toBeNull();
    expect(await matches(f, "needle")).toHaveLength(0);
  }, 20_000);

  it("restores exactly the captured version/state/body when authoritative reviewed removal reports changed", async () => {
    const f = await setup({ now: () => 1000 }); const summary = await indexed(f);
    const original = await row(f, summary.id); const g = await generation(f);
    expect(await f.records.documents.remove(summary.id, "0".repeat(64))).toMatchObject({ status: "changed" });
    expect(await row(f, summary.id)).toMatchObject({ doc: original!.doc, version: summary.version, state: "indexed" });
    expect(await f.db.prepare("SELECT count(*) AS n FROM deleted_ids").first("n")).toBe(0);
    expect(await matches(f, "needle")).toHaveLength(1);
    expect(await generation(f)).toBe(g + 2);
  }, 20_000);

  it("fails closed before R2 on D1 hide failure and permits a safe retry", async () => {
    const f = await setup({ now: () => 1000 }); const summary = await indexed(f);
    const broken = withDb(f, async () => { throw new Error("D1 unavailable"); });
    await expect(broken.documents.remove(summary.id, summary.version)).rejects.toThrow("D1 unavailable");
    expect(await f.documents.resolve(summary.id)).not.toBeNull();
    expect(await row(f, summary.id)).toMatchObject({ state: "indexed" });
    expect(await f.records.documents.remove(summary.id, summary.version)).toMatchObject({ status: "deleted" });
  }, 20_000);

  it("keeps partial R2 failures hidden until ten-minute repair resolves the surviving current objects", async () => {
    let now = 1000; const f = await setup({ now: () => now });
    await seed(f); await f.bucket.put("Records1/second.txt", "survivor");
    const summary = (await f.documents.resolve("Records1"))!.summary;
    await f.records.ingest(summary, now);
    const records = createLibraryRecords({ ...f.deps, documents: { ...f.documents, remove: async () => {
      await f.bucket.delete("Records1/note.txt"); throw new Error("partial R2 failure");
    } } });
    await expect(records.documents.remove(summary.id, summary.version)).rejects.toThrow("partial R2 failure");
    const owner = await deleting(f, summary.id); const g = await generation(f);
    expect(await row(f, summary.id)).toMatchObject({ state: "deleting" });
    const held = await lease(f, "repair", 1_000_000);
    expect(await f.records.repairDeletion(owner, held)).toBe("stale");
    now += 600_000;
    expect(await f.records.repairDeletion(owner, { token: "expired", expiresAt: now - 1 })).toBe("stale");
    expect(await f.records.repairDeletion(owner, held)).toBe("restored");
    expect(await row(f, summary.id)).toMatchObject({ state: "pending", version: summary.version });
    expect(await generation(f)).toBe(g + 1);
    // Reconcile replaces this old derived ref only after resolving the surviving R2 version.
    const current = (await f.documents.resolve(summary.id))!.summary;
    expect(current.version).not.toBe(summary.version);
    expect(await f.records.ingest(current, now, held)).toBe("written");
    expect(await row(f, summary.id)).toMatchObject({ version: current.version });
  }, 20_000);

  it("permanently finalizes missing R2 after an exception without bumping an already-hidden generation", async () => {
    let now = 1000; const f = await setup({ now: () => now }); const summary = await indexed(f);
    const records = createLibraryRecords({ ...f.deps, documents: { ...f.documents, remove: async (id, version) => {
      await f.documents.remove(id, version); throw new Error("response lost");
    } } });
    await expect(records.documents.remove(summary.id, summary.version)).rejects.toThrow("response lost");
    const owner = await deleting(f, summary.id); const g = await generation(f);
    now += 600_000; const held = await lease(f, "repair", now + 100_000);
    expect(await f.records.repairDeletion(owner, held)).toBe("deleted");
    expect(await f.records.repairDeletion(owner, held)).toBe("stale");
    expect(await row(f, summary.id)).toBeNull();
    expect(await generation(f)).toBe(g);
    expect(await f.records.ingest(summary, now, held)).toBe("tombstoned");
    // Unsupported recreation is an anomaly for maintenance, never authority to index or delete.
    await seed(f);
    expect(await f.records.documents.remove(summary.id)).toMatchObject({ status: "not-found" });
    expect(await f.documents.resolve(summary.id)).not.toBeNull();
    expect(await matches(f, "needle")).toHaveLength(0);
  }, 20_000);

  it("cannot restore a late losing delete after repair and another successful deletion", async () => {
    let now = 1000; const f = await setup({ now: () => now }); const summary = await indexed(f);
    const entered = barrier<void>(); const release = barrier<void>();
    const records = createLibraryRecords({ ...f.deps, documents: { ...f.documents, remove: async () => {
      entered.resolve(); await release.promise; return { status: "changed", deletedObjectCount: 0 };
    } } });
    const losing = records.documents.remove(summary.id, summary.version);
    const observed = losing.catch((error) => error);
    await entered.promise; const first = await deleting(f, summary.id);
    now += 600_000; const held = await lease(f, "repair", now + 100_000);
    expect(await f.records.repairDeletion(first, held)).toBe("restored");
    expect(await f.records.documents.remove(summary.id, summary.version)).toMatchObject({ status: "deleted" });
    const final = await deleting(f, summary.id); const g = await generation(f);
    expect(final.token).not.toBe(first.token);
    release.resolve(); expect(await observed).toMatchObject({ code: "library_unavailable" });
    expect(await deleting(f, summary.id)).toEqual(final);
    expect(await row(f, summary.id)).toBeNull();
    expect(await generation(f)).toBe(g);
  }, 20_000);

  it("rejects extraction finishing after deletion and preserves extracted-byte budget accounting", async () => {
    const entered = barrier<void>(); const release = barrier<void>();
    const f = await setup({ now: () => 1000, extract: async (doc) => { entered.resolve(); await release.promise; return text(doc.summary.id, doc.summary.version, "late needle"); } });
    const summary = await seed(f); await f.records.ingest(summary, 1000);
    const work = f.records.index((await f.records.claim(summary))!); await entered.promise;
    expect(await f.records.documents.remove(summary.id, summary.version)).toMatchObject({ status: "deleted" });
    const g = await generation(f); release.resolve();
    expect(await work).toEqual({ outcome: "stale", textBytes: 11 });
    expect(await generation(f)).toBe(g);
    expect(await matches(f, "needle")).toHaveLength(0);
    expect(await row(f, summary.id)).toBeNull();
  }, 20_000);

  it("fences missing-confirmation against same-clock metadata ingestion, then finalizes a confirmed absence", async () => {
    const f = await setup({ now: () => 1000 }); const summary = await indexed(f);
    const held = await lease(f); const entered = barrier<void>(); const release = barrier<void>();
    const records = createLibraryRecords({ ...f.deps, documents: { ...f.documents, resolve: async () => {
      entered.resolve(); await release.promise; return null;
    } } });
    const work = records.confirmMissing(summary, 2000, held); await entered.promise;
    await f.records.ingest({ ...summary, title: "new metadata at same clock" }, 2000, held);
    release.resolve(); expect(await work).toBe("stale");
    expect(await row(f, summary.id)).toMatchObject({ state: "indexed", title: "new metadata at same clock" });
    expect(await f.records.confirmMissing(summary, 2000, held)).toBe("stale");
    await f.bucket.delete(`${summary.id}/note.txt`);
    const g = await generation(f);
    expect(await f.records.confirmMissing(summary, 2000, held)).toBe("written");
    expect(await row(f, summary.id)).toBeNull();
    expect(await generation(f)).toBe(g + 1);
    expect(await f.records.ingest(summary, 2000, held)).toBe("tombstoned");
  }, 20_000);

  it("does not let a stale repair missing-result race another operation's finalized tombstone", async () => {
    let now = 1000; const f = await setup({ now: () => now }); const summary = await indexed(f);
    const removeEntered = barrier<void>(); const removeRelease = barrier<void>();
    const records = createLibraryRecords({ ...f.deps, documents: { ...f.documents, remove: async (id, version) => {
      await f.documents.remove(id, version); removeEntered.resolve(); await removeRelease.promise;
      return { status: "deleted", deletedObjectCount: 1 };
    } } });
    const removing = records.documents.remove(summary.id, summary.version); await removeEntered.promise;
    const owner = await deleting(f, summary.id); now += 600_000; const held = await lease(f, "repair", now + 100_000);
    const entered = barrier<void>(); const release = barrier<void>();
    const repairing = createLibraryRecords({ ...f.deps, documents: { ...f.documents, resolve: async () => {
      entered.resolve(); await release.promise; return null;
    } } });
    const work = repairing.repairDeletion(owner, held); await entered.promise;
    removeRelease.resolve(); expect(await removing).toMatchObject({ status: "deleted" });
    const g = await generation(f); release.resolve();
    expect(await work).toBe("stale");
    expect(await generation(f)).toBe(g);
    expect(await f.db.prepare("SELECT state FROM deleted_ids WHERE id=?").bind(summary.id).first("state")).toBe("deleted");
  }, 20_000);
});

describe("LibraryRecords stale metadata observations", () => {
  it("rejects older replay even when the newer version was ingested at the identical clock tick", async () => {
    const f = await setup({ now: () => 1000 }); const old = await seed(f); await f.records.ingest(old, 1000);
    await f.bucket.put(`${old.id}/note.txt`, "new bytes");
    const current = (await f.documents.resolve(old.id))!.summary;
    expect(await f.records.ingest(current, 1000)).toBe("written");
    const g = await generation(f);
    expect(await f.records.ingest(old, 1000)).toBe("stale");
    expect(await row(f, old.id)).toMatchObject({ version: current.version });
    expect(await generation(f)).toBe(g);
  }, 20_000);

  it("fences revalidated metadata when another ingest wins during its R2 handoff", async () => {
    const f = await setup({ now: () => 1000 }); const old = await seed(f); await f.records.ingest(old, 1000);
    await f.bucket.put(`${old.id}/note.txt`, "second bytes");
    const second = (await f.documents.resolve(old.id))!;
    const entered = barrier<void>(); const release = barrier<void>();
    const slow = createLibraryRecords({ ...f.deps, documents: { ...f.documents, resolve: async () => {
      entered.resolve(); await release.promise; return second;
    } } });
    const work = slow.ingest(second.summary, 1000); await entered.promise;
    await f.bucket.put(`${old.id}/note.txt`, "third bytes");
    const third = (await f.documents.resolve(old.id))!.summary;
    expect(await f.records.ingest(third, 1000)).toBe("written");
    release.resolve(); expect(await work).toBe("stale");
    expect(await row(f, old.id)).toMatchObject({ version: third.version });
  }, 20_000);
});

function invocation(f: Fixture, overrides: Partial<import("./contracts").LibraryDependencies> = {}) {
  const resources = createInvocationResources(() => f.db, f.bucket);
  const documents = createDocuments(resources.bucket, f.deps.publicOrigin);
  const records = createLibraryRecords({ ...f.deps, ...resources, documents, ...overrides });
  return { ...resources, records };
}
async function consume(db: D1Database, count: number) {
  await db.batch(Array.from({ length: count }, () => db.prepare("SELECT 1")));
}

describe("LibraryRecords shared invocation accounting", () => {
  it("uses one native ledger for upload and deferred extraction without double charging", async () => {
    const f = await setup({ extract: async (doc) => text(doc.summary.id, doc.summary.version, "budget needle") });
    const run = invocation(f);
    const summary = await run.records.documents.create({ body: null, filename: "x.txt", title: "Budget searchable", mime: "text/plain" });
    const before = run.budget.used;
    await f.flush();
    expect(await row(f, summary.id)).toMatchObject({ state: "indexed", attempts: 0 });
    expect(run.budget.used).toBe(24);
    expect(run.budget.used).toBeGreaterThanOrEqual(before);
    expect(run.budget.remaining).toBe(40 - run.budget.used);
  }, 20_000);

  it("returns successful R2 creation when the whole metadata batch cannot be admitted", async () => {
    const f = await setup(); const log = vi.spyOn(console, "warn").mockImplementation(() => {});
    const run = invocation(f); await consume(run.db, 32);
    const summary = await run.records.documents.create({ body: null, filename: "x.txt", title: "Survives budget", mime: "text/plain" });
    await f.flush();
    expect(run.budget.used).toBe(37);
    expect(await row(f, summary.id)).toBeNull();
    expect(await generation(f)).toBe(0);
    expect(await f.documents.resolve(summary.id)).not.toBeNull();
    expect(log).toHaveBeenCalledWith("library-records", { category: "upload-upkeep" });
    expect(await f.records.ingest(summary, Date.now())).toBe("written");
  }, 20_000);

  it("does not record admission refusal as extraction failure, even inside the extractor", async () => {
    const f = await setup(); const summary = await seed(f); await f.records.ingest(summary, Date.now());
    const owned = (await f.records.claim(summary))!;
    const run = invocation(f, { extract: async () => { throw new InvocationBudgetExceeded(); } });
    await expect(run.records.index(owned)).rejects.toBeInstanceOf(InvocationBudgetExceeded);
    expect(await row(f, summary.id)).toMatchObject({ state: "pending", attempts: 0, claim_token: owned.token });
    expect(await generation(f)).toBe(1);
  }, 20_000);

  it("rejects the final text batch atomically without retry attempts or partial FTS/body state", async () => {
    const f = await setup({ extract: async (doc) => text(doc.summary.id, doc.summary.version, "budget needle") });
    const summary = await seed(f); await f.records.ingest(summary, Date.now());
    const owned = (await f.records.claim(summary))!;
    const run = invocation(f); await consume(run.db, 31);
    await expect(run.records.index(owned)).rejects.toBeInstanceOf(InvocationBudgetExceeded);
    expect(run.budget.used).toBe(35);
    expect(await row(f, summary.id)).toMatchObject({ state: "pending", attempts: 0 });
    expect(await matches(f, "needle")).toHaveLength(0);
    expect(await generation(f)).toBe(1);
  }, 20_000);

  it("refuses an indivisible hide before R2 and leaves a refused finalization hidden for repair", async () => {
    let now = 1000; const f = await setup({ now: () => now }); const summary = await indexed(f);
    const rejectedHide = invocation(f); await consume(rejectedHide.db, 37);
    await expect(rejectedHide.records.documents.remove(summary.id, summary.version)).rejects.toBeInstanceOf(InvocationBudgetExceeded);
    expect(rejectedHide.budget.used).toBe(37);
    expect(await f.documents.resolve(summary.id)).not.toBeNull();
    expect(await f.db.prepare("SELECT count(*) AS n FROM deleted_ids").first("n")).toBe(0);
    const rejectedFinish = invocation(f); await consume(rejectedFinish.db, 25);
    await expect(rejectedFinish.records.documents.remove(summary.id, summary.version)).rejects.toBeInstanceOf(InvocationBudgetExceeded);
    expect(rejectedFinish.budget.used).toBe(35);
    expect(await f.documents.resolve(summary.id)).toBeNull();
    expect(await row(f, summary.id)).toMatchObject({ state: "deleting" });
    const owner = await deleting(f, summary.id); now += 600_000;
    const held = await lease(f, "repair", now + 100_000);
    const fresh = invocation(f);
    expect(await fresh.records.repairDeletion(owner, held)).toBe("deleted");
    expect(fresh.budget.used).toBeLessThanOrEqual(40);
    expect(await row(f, summary.id)).toBeNull();
  }, 20_000);
});

describe("LibraryRecords reviewed storage guards", () => {
  it("fences concurrent actual-size samples so four bodies cannot spend the same capacity", async () => {
    const body = "x".repeat(524_288);
    const extract = vi.fn(async (doc: ResolvedDocument) => text(doc.summary.id, doc.summary.version, body));
    const f = await setup({ now: () => 1000, extract, config: { sizeBudgetBytes: 2_000_000 } });
    const refs = [];
    for (let i = 0; i < 4; i++) {
      const summary = await seed(f, `Budget0${i}`); refs.push(summary);
      await f.records.ingest(summary, 1000);
    }
    const claims = [];
    for (const ref of refs) claims.push((await f.records.claim(ref))!);
    const allReady = barrier<void>(); let admitted = 0;
    // Hold every final transaction until all four have sampled the same actual size. This
    // reproduced the review failure (4,308,992 bytes under a 2,000,000-byte budget) before the fix.
    const concurrent = withDb(f, async (statements) => {
      if (++admitted === 4) allReady.resolve();
      await allReady.promise; return f.db.batch(statements);
    });
    const outcomes = await Promise.all(claims.map((claim) => concurrent.index(claim)));
    expect(outcomes.filter((result) => result.outcome === "indexed")).toHaveLength(1);
    expect(outcomes.filter((result) => result.outcome === "paused")).toHaveLength(3);
    expect(outcomes.every((result) => result.textBytes === 524_288)).toBe(true);
    expect(extract).toHaveBeenCalledTimes(4);
    const actual = await f.db.prepare("SELECT count(*) AS n FROM document_text").all();
    expect(actual.results).toEqual([{ n: 1 }]);
    expect(actual.meta.size_after).toBeLessThan(2_000_000);
    const storage = JSON.parse((await f.db.prepare("SELECT value FROM index_meta WHERE key='storage'").first<string>("value"))!);
    expect(storage).toMatchObject({ paused: true, reason: "paused: index size budget" });
    expect(await generation(f)).toBe(5);
    for (const ref of refs) expect(await row(f, ref.id)).toMatchObject({ attempts: 0, claim_token: null });
  }, 20_000);

  it("recognizes D1's documented database-size error, pauses and releases without a retry loop", async () => {
    const extract = vi.fn(async (doc: ResolvedDocument) => text(doc.summary.id, doc.summary.version, "body needle"));
    const f = await setup({ now: () => 1000, extract });
    const summary = await seed(f); await f.records.ingest(summary, 1000);
    const owned = (await f.records.claim(summary))!; let fail = true;
    const records = withDb(f, async (statements) => {
      if (fail) { fail = false; throw new Error("D1_ERROR: Exceeded maximum DB size."); }
      return f.db.batch(statements);
    });
    expect(await records.index(owned)).toEqual({ outcome: "paused", textBytes: 11 });
    expect(await row(f, summary.id)).toMatchObject({ state: "pending", attempts: 0, retry_at: null, claim_token: null });
    expect(await generation(f)).toBe(1);
    expect(await f.records.index((await f.records.claim(summary))!)).toEqual({ outcome: "paused", textBytes: 0 });
    expect(extract).toHaveBeenCalledTimes(1);
    const storage = JSON.parse((await f.db.prepare("SELECT value FROM index_meta WHERE key='storage'").first<string>("value"))!);
    expect(storage).toMatchObject({ paused: true, reason: "paused: index size budget" });
  }, 20_000);
});

describe("LibraryRecords paused retry state", () => {
  it("leaves paused retry work visibly pending without consuming another failure attempt", async () => {
    let now = 1000; const f = await setup({ now: () => now, extract: async () => { throw new Error("read failed"); } });
    const summary = await seed(f); await f.records.ingest(summary, now);
    expect(await f.records.index((await f.records.claim(summary))!)).toMatchObject({ outcome: "failed" });
    const g = await generation(f); now = 61_000;
    await f.db.prepare("INSERT INTO index_meta(key,value) VALUES ('storage',?)").bind(JSON.stringify({
      bytes: 100, budgetBytes: 400_000_000, planningBytes: null, projectedBytes: null, paused: true, reason: "paused: index size budget",
    })).run();
    expect(await f.records.index((await f.records.claim(summary))!)).toEqual({ outcome: "paused", textBytes: 0 });
    expect(await row(f, summary.id)).toMatchObject({ state: "pending", attempts: 1, claim_token: null });
    expect(await generation(f)).toBe(g + 1);
  }, 20_000);
});
