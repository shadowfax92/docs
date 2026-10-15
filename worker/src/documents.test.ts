import { afterEach, describe, expect, it, vi } from "vitest";
import { createDocuments } from "./documents";
import type { DocumentSummary } from "./contracts";

const origin = "https://docs.example";
const firstId = "Ab12Cd34";
// The pinned Workers type snapshot omits list.include although native R2 supports it.
type MetadataListOptions = R2ListOptions & { include?: ("customMetadata" | "httpMetadata")[] };

/** Only native R2 is substituted. Listings honor metadata inclusion, opaque cursors and short
 * pages; conditional writes are checked at commit so competing creators cannot both acquire a key.
 * Hooks inject external failures/mutations at the storage seam without mocking Documents itself.
 */
class LocalBucket {
  readonly entries = new Map<string, { object: R2Object; bytes: Uint8Array }>();
  readonly deletedBatches: string[][] = [];
  readonly listCalls: MetadataListOptions[] = [];
  readonly getCalls: string[] = [];
  pageSize = 1000;
  beforeList?: (options: MetadataListOptions) => void | Promise<void>;
  beforePut?: (key: string) => void | Promise<void>;
  beforeDelete?: (keys: string[]) => void | Promise<void>;
  failGet = false;
  failHead = false;
  private revision = 0;

  binding(): R2Bucket { return this as unknown as R2Bucket; }

  async put(key: string, value: ReadableStream | string | null, options: R2PutOptions = {}): Promise<R2Object | null> {
    await this.beforePut?.(key);
    const bytes = new Uint8Array(await new Response(value).arrayBuffer());
    const etag = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
      .map((byte) => byte.toString(16).padStart(2, "0")).join("");
    if (!matches(this.entries.get(key)?.object, options.onlyIf)) return null;
    const object: R2Object = {
      key, version: String(++this.revision), etag, httpEtag: `"${etag}"`, size: bytes.length,
      uploaded: new Date("2026-10-14T12:00:00Z"), customMetadata: options.customMetadata,
      httpMetadata: options.httpMetadata instanceof Headers ? undefined : options.httpMetadata,
      checksums: { toJSON: () => ({}) }, storageClass: "Standard", writeHttpMetadata() {},
    };
    this.entries.set(key, { object, bytes });
    return object;
  }

  async head(key: string): Promise<R2Object | null> {
    if (this.failHead) throw new Error("head failed");
    return this.entries.get(key)?.object ?? null;
  }

  async list(options: MetadataListOptions = {}): Promise<R2Objects> {
    this.listCalls.push(options);
    await this.beforeList?.(options);
    const prefix = options.prefix ?? "";
    const cursor = options.cursor ? JSON.parse(atob(options.cursor)) as { prefix: string; after: string } : null;
    if (cursor && cursor.prefix !== prefix) throw new Error("wrong cursor scope");
    const all = [...this.entries.values()].map(({ object }) => object)
      .filter((object) => object.key.startsWith(prefix) && (!cursor || object.key > cursor.after))
      .sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
    const selected = all.slice(0, Math.min(options.limit ?? 1000, this.pageSize));
    const objects = selected.map((object) => ({
      ...object,
      customMetadata: options.include?.includes("customMetadata") ? object.customMetadata : undefined,
      httpMetadata: options.include?.includes("httpMetadata") ? object.httpMetadata : undefined,
      writeHttpMetadata() {},
    }));
    return all.length > selected.length
      ? { objects, truncated: true, cursor: btoa(JSON.stringify({ prefix, after: selected.at(-1)!.key })), delimitedPrefixes: [] }
      : { objects, truncated: false, delimitedPrefixes: [] };
  }

  async get(key: string, options: R2GetOptions = {}): Promise<R2Object | R2ObjectBody | null> {
    this.getCalls.push(key);
    if (this.failGet) throw new Error("get failed");
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (!matches(entry.object, options.onlyIf)) return entry.object;
    let bytes = entry.bytes;
    const range = options.range;
    if (range && !(range instanceof Headers)) {
      const offset = "suffix" in range ? Math.max(0, bytes.length - range.suffix) : range.offset ?? 0;
      const length = "length" in range ? range.length : undefined;
      bytes = bytes.slice(offset, length === undefined ? undefined : offset + length);
    }
    const response = new Response(bytes);
    return {
      ...entry.object, writeHttpMetadata() {}, body: response.body!, get bodyUsed() { return response.bodyUsed; },
      text: () => response.text(), arrayBuffer: () => response.arrayBuffer(),
      bytes: async () => new Uint8Array(await response.arrayBuffer()),
      json: <T>() => response.json() as Promise<T>, blob: () => response.blob(),
    };
  }

  async delete(input: string | string[]): Promise<void> {
    const keys = typeof input === "string" ? [input] : input;
    if (keys.length > 1000) throw new Error("native R2 delete limit exceeded");
    await this.beforeDelete?.(keys);
    this.deletedBatches.push([...keys]);
    keys.forEach((key) => this.entries.delete(key));
  }
}

function matches(object: R2Object | undefined, condition?: R2Conditional | Headers): boolean {
  if (!condition) return true;
  const equal = (value: string) => value === "*" ? !!object : !!object && value.replace(/^"|"$/g, "") === object.etag;
  const match = condition instanceof Headers ? condition.get("If-Match") : condition.etagMatches;
  const none = condition instanceof Headers ? condition.get("If-None-Match") : condition.etagDoesNotMatch;
  return (!match || equal(match)) && (!none || !equal(none));
}

async function seed(bucket: LocalBucket, key: string, body = "data", options: R2PutOptions = {}, uploadedAt?: string) {
  const object = (await bucket.put(key, body, options))!;
  const dated = { ...object, writeHttpMetadata() {}, uploaded: uploadedAt ? new Date(uploadedAt) : object.uploaded };
  bucket.entries.set(key, { ...bucket.entries.get(key)!, object: dated });
  return dated;
}

async function discover(bucket: LocalBucket): Promise<DocumentSummary[]> {
  const documents = createDocuments(bucket.binding(), origin);
  const summaries: DocumentSummary[] = [];
  let cursor: string | undefined;
  do {
    const page = await documents.page(cursor);
    expect(page.scanComplete).toBe(page.nextCursor === null);
    summaries.push(...page.items);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return summaries;
}

afterEach(() => vi.restoreAllMocks());

function idsInOrder(...byteValues: number[]) {
  let call = 0;
  vi.spyOn(crypto, "getRandomValues").mockImplementation((array) => {
    if (array) new Uint8Array(array.buffer, array.byteOffset, array.byteLength).fill(byteValues[Math.min(call++, byteValues.length - 1)]);
    return array;
  });
}

describe("Documents discovery", () => {
  it("groups a legacy ID across short truncated pages and excludes private/unowned keys", async () => {
    const bucket = new LocalBucket();
    bucket.pageSize = 2;
    await seed(bucket, `${firstId}/a.html`, "a", {
      customMetadata: { filename: "report.html", docName: "Report", contentType: "text/html", uploadedAt: "1900-01-01" },
    }, "2026-01-01T00:00:00Z");
    await seed(bucket, `${firstId}/b.html`, "bb", {}, "2026-10-01T00:00:00Z");
    await seed(bucket, `${firstId}/c.html`, "ccc", {}, "2026-02-01T00:00:00Z");
    await seed(bucket, "Bc23De45/notes.txt", "four");
    await seed(bucket, "__docs_internal/reservations/Ab12Cd34");
    await seed(bucket, "__docs_internal/catalog/state");
    await seed(bucket, "no-owned-id/report.html");
    await seed(bucket, "short/file");
    await seed(bucket, "Xx12Yy34/");
    const items = await discover(bucket);
    expect(items.map((item) => item.id)).toEqual([firstId, "Bc23De45"]);
    expect(items[0]).toMatchObject({
      title: "Report", filename: "report.html", mime: "text/html", kind: "html",
      sizeBytes: 6, objectCount: 3, uploadedAt: "2026-10-01T00:00:00.000Z", timeSource: "r2", createdAt: null,
    });
    expect(items[0].warnings).toHaveLength(1);
    expect(items[0].version).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(items)).not.toContain("__docs_internal");
    expect(bucket.getCalls).toEqual([]);
  });

  it.each([
    ["notes.txt", "text/plain", "text"], ["main.go", "text/plain", "text"],
    ["photo.PNG", "image/png", "image"], ["song.mp3", "audio/mpeg", "audio"],
    ["clip.mp4", "video/mp4", "video"], ["report.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "office"],
    ["table.csv", "text/csv", "data"], ["bundle.zip", "application/zip", "archive"],
    ["unknown.bin", "application/octet-stream", "binary"],
    ["file.constructor", "application/octet-stream", "binary"], ["file.__proto__", "application/octet-stream", "binary"],
  ])("infers missing MIME and kind for %s", async (filename, mime, kind) => {
    const bucket = new LocalBucket();
    await seed(bucket, `${firstId}/${filename}`);
    const documents = createDocuments(bucket.binding(), origin);
    const summary = (await documents.resolve(firstId))!.summary;
    expect(summary).toMatchObject({ filename, mime, kind, createdAt: null, objectCount: 1 });
    expect((await discover(bucket))[0]).toEqual(summary);
  });

  it("uses HTTP metadata without opening a body and keeps metadata/version consistent between callers", async () => {
    const bucket = new LocalBucket();
    await seed(bucket, `${firstId}/payload`, "hi", { httpMetadata: { contentType: "image/webp" } });
    const documents = createDocuments(bucket.binding(), origin);
    const resolved = (await documents.resolve(firstId))!;
    expect(resolved.summary).toMatchObject({ filename: "payload", mime: "image/webp", kind: "image" });
    expect((await documents.page()).items).toEqual([resolved.summary]);
    expect(bucket.getCalls).toEqual([]);
    await seed(bucket, `${firstId}/payload`, "hi"); // Same bytes/etag, new R2 version.
    expect((await documents.resolve(firstId))!.summary.version).not.toBe(resolved.summary.version);
  });

  it("continues past an empty truncated page and does not mistake a short page for the end", async () => {
    const bucket = new LocalBucket();
    bucket.pageSize = 1;
    await seed(bucket, `${firstId}/a.txt`);
    await seed(bucket, "Bc23De45/b.txt");
    const actualList = bucket.list.bind(bucket);
    vi.spyOn(bucket, "list").mockImplementationOnce(async () => ({
      objects: [], truncated: true, cursor: btoa(JSON.stringify({ prefix: "", after: "" })), delimitedPrefixes: [],
    })).mockImplementation(actualList);
    expect((await discover(bucket)).map((item) => item.id)).toEqual([firstId, "Bc23De45"]);
  });

  it("enumerates more than one native 1000-object page without omissions or duplicate IDs", async () => {
    const bucket = new LocalBucket();
    await Promise.all(Array.from({ length: 1005 }, (_, index) => seed(bucket, `A${String(index).padStart(7, "0")}/note.txt`)));
    const items = await discover(bucket);
    expect(items).toHaveLength(1005);
    expect(new Set(items.map((item) => item.id)).size).toBe(1005);
    expect(items.at(-1)?.id).toBe("A0001004");
  });

  it("rejects malformed cursor state before R2 access and propagates storage failures", async () => {
    const bucket = new LocalBucket();
    const documents = createDocuments(bucket.binding(), origin);
    for (const cursor of ["", "null", "{}", '{"version":1,"r2":"x","lastId":"../private"}', "x".repeat(16_385)]) {
      await expect(documents.page(cursor)).rejects.toThrow("Invalid document cursor");
    }
    expect(bucket.listCalls).toEqual([]);
    bucket.beforeList = () => { throw new Error("storage offline"); };
    await expect(documents.page()).rejects.toThrow("storage offline");
    await expect(documents.resolve(firstId)).rejects.toThrow("storage offline");
  });

  it("rejects missing/repeating native continuation and bounds anomalous groups instead of splitting them", async () => {
    const bucket = new LocalBucket();
    const documents = createDocuments(bucket.binding(), origin);
    const list = vi.spyOn(bucket, "list");
    list.mockResolvedValue({ objects: [], truncated: true, cursor: "same", delimitedPrefixes: [] });
    const page = await documents.page();
    await expect(documents.page(page.nextCursor!)).rejects.toThrow("Invalid R2 continuation");
    list.mockResolvedValue({ objects: [], truncated: true, cursor: "", delimitedPrefixes: [] });
    await expect(documents.page()).rejects.toThrow("Invalid R2 continuation");
    list.mockRestore();
    bucket.pageSize = 1;
    await Promise.all(Array.from({ length: 129 }, (_, index) => seed(bucket, `${firstId}/${index}.txt`)));
    await expect(documents.page()).rejects.toThrow("prefix page limit");
    expect(bucket.deletedBatches).toEqual([]);
  });

  it("fails an over-limit ID without deleting or silently returning partial metadata", async () => {
    const bucket = new LocalBucket();
    const object = await seed(bucket, `${firstId}/seed.txt`);
    for (let index = 0; index < 10_001; index++) {
      const key = `${firstId}/${String(index).padStart(5, "0")}.txt`;
      bucket.entries.set(key, { bytes: new Uint8Array(0), object: { ...object, key, version: String(index), writeHttpMetadata() {} } });
    }
    const documents = createDocuments(bucket.binding(), origin);
    await expect(documents.resolve(firstId)).rejects.toThrow("object limit");
    await expect(documents.page()).rejects.toThrow("object limit");
    await expect(documents.remove(firstId)).rejects.toThrow("object limit");
    expect(bucket.deletedBatches).toEqual([]);
  });
});

describe("Documents immutable upload", () => {
  it("does not overwrite legacy objects on an ID collision, and streams a sanitized new payload", async () => {
    const bucket = new LocalBucket();
    await seed(bucket, "aaaaaaaa/old.html", "legacy");
    idsInOrder(0, 1);
    const documents = createDocuments(bucket.binding(), origin);
    const request = new Request("https://fixture.example", { method: "PUT", body: "new payload" });
    const uploaded = await documents.create({ body: request.body, filename: "../new note.txt", mime: "", title: "New note" });
    expect(uploaded).toMatchObject({ id: "bbbbbbbb", filename: ".._new_note.txt", title: "New note", mime: "text/plain" });
    expect(request.bodyUsed).toBe(true);
    expect(await (await (await documents.resolve("aaaaaaaa"))!.openBody())!.text()).toBe("legacy");
    expect(await (await (await documents.resolve(uploaded.id))!.openBody())!.text()).toBe("new payload");
    expect((await discover(bucket)).map((item) => item.id)).toEqual(["aaaaaaaa", "bbbbbbbb"]);
  });

  it("retains ID reservations across deletion, and two concurrent creators cannot share an ID", async () => {
    const bucket = new LocalBucket();
    idsInOrder(0, 0, 1, 2);
    const create = () => createDocuments(bucket.binding(), origin).create({ body: null, filename: "empty.txt", mime: "", title: "" });
    const [a, b] = await Promise.all([create(), create()]);
    expect(new Set([a.id, b.id]).size).toBe(2);
    await createDocuments(bucket.binding(), origin).remove(a.id);
    idsInOrder(0, 1, 2);
    const next = await create();
    expect(next.id).not.toBe(a.id);
    expect(next.id).not.toBe(b.id);
    expect(await createDocuments(bucket.binding(), origin).resolve(a.id)).toBeNull();
  });

  it("fails a colliding payload conditional write without replacing it or reusing its upload stream", async () => {
    const bucket = new LocalBucket();
    idsInOrder(0);
    bucket.beforePut = async (key) => {
      if (key === "aaaaaaaa/new.txt") {
        bucket.beforePut = undefined;
        await seed(bucket, key, "external replacement");
      }
    };
    const documents = createDocuments(bucket.binding(), origin);
    await expect(documents.create({ body: new Response("original").body, filename: "new.txt", mime: "", title: "" })).rejects.toThrow();
    expect(await (await (await documents.resolve("aaaaaaaa"))!.openBody())!.text()).toBe("external replacement");
  });

  it("bounds repeated reservation collisions and keeps a failed upload reservation private", async () => {
    const bucket = new LocalBucket();
    idsInOrder(0);
    const documents = createDocuments(bucket.binding(), origin);
    const first = await documents.create({ body: null, filename: "one.txt", mime: "", title: "" });
    await documents.remove(first.id);
    await expect(documents.create({ body: null, filename: "two.txt", mime: "", title: "" })).rejects.toThrow("reserve");
    idsInOrder(1, 2);
    bucket.beforePut = (key) => { if (key === "bbbbbbbb/fail.txt") throw new Error("payload failed"); };
    await expect(documents.create({ body: null, filename: "fail.txt", mime: "", title: "" })).rejects.toThrow("payload failed");
    bucket.beforePut = undefined;
    const next = await documents.create({ body: null, filename: "next.txt", mime: "", title: "" });
    expect(next.id).toBe("cccccccc");
    expect((await discover(bucket)).map((item) => item.id)).toEqual(["cccccccc"]);
  });
});

describe("Documents reviewed removal", () => {
  it("removes the exact complete legacy ID/version and leaves a permanent reservation", async () => {
    const bucket = new LocalBucket();
    bucket.pageSize = 1;
    await seed(bucket, `${firstId}/a.txt`);
    await seed(bucket, `${firstId}/b.txt`);
    await seed(bucket, "Bc23De45/other.txt");
    const documents = createDocuments(bucket.binding(), origin);
    const summary = (await documents.resolve(firstId))!.summary;
    expect(await documents.remove(firstId, summary.version)).toEqual({ status: "deleted", deletedObjectCount: 2 });
    expect(await documents.remove(firstId, summary.version)).toEqual({ status: "not-found", deletedObjectCount: 0 });
    expect(await documents.resolve("Bc23De45")).not.toBeNull();
    expect((await discover(bucket)).map((item) => item.id)).toEqual(["Bc23De45"]);
    const reservations = [...bucket.entries.keys()].filter((key) => key.startsWith("__docs_internal/"));
    expect(reservations).toHaveLength(1);
    expect(bucket.deletedBatches.flat()).toEqual([`${firstId}/a.txt`, `${firstId}/b.txt`]);
  });

  it("deletes a committed immutable upload using its reviewed version", async () => {
    const bucket = new LocalBucket();
    const documents = createDocuments(bucket.binding(), origin);
    const summary = await documents.create({ body: null, filename: "note.txt", mime: "", title: "" });
    expect(await documents.remove(summary.id, summary.version)).toEqual({ status: "deleted", deletedObjectCount: 1 });
    expect(await documents.resolve(summary.id)).toBeNull();
  });

  it("skips stale keys/versions (including identical bytes with a new version) and unsafe refs", async () => {
    const bucket = new LocalBucket();
    await seed(bucket, `${firstId}/a.txt`, "same bytes");
    const documents = createDocuments(bucket.binding(), origin);
    const original = (await documents.resolve(firstId))!.summary;
    await seed(bucket, `${firstId}/a.txt`, "same bytes");
    expect(await documents.remove(firstId, original.version)).toEqual({ status: "changed", deletedObjectCount: 0 });
    const current = (await documents.resolve(firstId))!.summary;
    await seed(bucket, `${firstId}/b.txt`);
    expect((await documents.remove(firstId, current.version)).status).toBe("changed");
    expect((await documents.remove(firstId, "not a version")).status).toBe("changed");
    expect((await documents.remove("../__docs_internal", original.version)).status).toBe("not-found");
    expect(bucket.deletedBatches).toEqual([]);
  });

  it("rechecks the captured version after claiming legacy ownership and fails closed on a pending upload", async () => {
    const bucket = new LocalBucket();
    await seed(bucket, `${firstId}/a.txt`);
    const documents = createDocuments(bucket.binding(), origin);
    const summary = (await documents.resolve(firstId))!.summary;
    bucket.beforePut = async (key) => {
      if (key.startsWith("__docs_internal/")) {
        bucket.beforePut = undefined;
        await seed(bucket, `${firstId}/a.txt`, "replaced while claiming");
      }
    };
    expect((await documents.remove(firstId, summary.version)).status).toBe("changed");
    expect(bucket.deletedBatches).toEqual([]);

    idsInOrder(0);
    let resume!: () => void;
    const pending = new Promise<void>((resolve) => { resume = resolve; });
    let arrived!: () => void;
    const atPayload = new Promise<void>((resolve) => { arrived = resolve; });
    bucket.beforePut = async (key) => {
      if (key === "aaaaaaaa/payload.txt") { arrived(); await pending; }
    };
    const upload = documents.create({ body: null, filename: "payload.txt", mime: "", title: "" });
    await atPayload;
    await seed(bucket, "aaaaaaaa/external.txt");
    const observed = (await documents.resolve("aaaaaaaa"))!.summary;
    expect((await documents.remove("aaaaaaaa", observed.version)).status).toBe("changed");
    resume();
    await upload;
    expect(await documents.resolve("aaaaaaaa")).not.toBeNull();
  });

  it("captures all keys before bounded delete batches and preserves unprocessed keys on failure", async () => {
    const bucket = new LocalBucket();
    await Promise.all(Array.from({ length: 2005 }, (_, index) => seed(bucket, `${firstId}/${String(index).padStart(5, "0")}.txt`)));
    const documents = createDocuments(bucket.binding(), origin);
    const summary = (await documents.resolve(firstId))!.summary;
    bucket.beforeDelete = () => {
      // Deleting invalidates cursor positions on many adapters. A new listing during deletion is
      // forbidden here, so this proves all server-owned keys were captured before any mutation.
      bucket.beforeList = () => { throw new Error("listing after deletion began"); };
      if (bucket.deletedBatches.length === 1) throw new Error("second batch failed");
    };
    await expect(documents.remove(firstId, summary.version)).rejects.toThrow("second batch failed");
    expect(bucket.deletedBatches.map((keys) => keys.length)).toEqual([1000]);
    bucket.beforeList = undefined;
    bucket.beforeDelete = undefined;
    const remaining = (await documents.resolve(firstId))!.summary;
    expect(remaining.objectCount).toBe(1005);
    expect((await documents.remove(firstId, summary.version)).status).toBe("changed");
    expect(await documents.remove(firstId, remaining.version)).toEqual({ status: "deleted", deletedObjectCount: 1005 });
    expect(bucket.deletedBatches.map((keys) => keys.length)).toEqual([1000, 1000, 5]);
  });

  it("propagates ownership/read failures before any destructive storage call", async () => {
    const bucket = new LocalBucket();
    await seed(bucket, `${firstId}/a.txt`);
    const documents = createDocuments(bucket.binding(), origin);
    const summary = (await documents.resolve(firstId))!.summary;
    bucket.failHead = true;
    await expect(documents.remove(firstId, summary.version)).rejects.toThrow("head failed");
    bucket.failHead = false;
    bucket.beforePut = () => { throw new Error("reservation failed"); };
    await expect(documents.remove(firstId, summary.version)).rejects.toThrow("reservation failed");
    expect(bucket.deletedBatches).toEqual([]);
  });

  it("skips a lost legacy claim rather than delete under another in-flight owner", async () => {
    const bucket = new LocalBucket();
    await seed(bucket, `${firstId}/a.txt`);
    const documents = createDocuments(bucket.binding(), origin);
    const summary = (await documents.resolve(firstId))!.summary;
    bucket.beforePut = async (key) => {
      bucket.beforePut = undefined;
      await seed(bucket, key, "", { customMetadata: { purpose: "upload" } });
    };
    expect((await documents.remove(firstId, summary.version)).status).toBe("changed");
    expect(bucket.deletedBatches).toEqual([]);
  });

  it("does not delete keys appended after the captured prefix in a legacy versionless removal", async () => {
    const bucket = new LocalBucket();
    await seed(bucket, `${firstId}/old.txt`);
    const documents = createDocuments(bucket.binding(), origin);
    bucket.beforeDelete = async () => {
      bucket.beforeDelete = undefined;
      await seed(bucket, `${firstId}/external-new.txt`);
    };
    expect(await documents.remove(firstId)).toEqual({ status: "deleted", deletedObjectCount: 1 });
    expect((await documents.resolve(firstId))?.summary.filename).toBe("external-new.txt");
  });
});

describe("Documents streamed body ownership", () => {
  it("validates read limits before opening, passes ranges, and opens only once", async () => {
    const bucket = new LocalBucket();
    await seed(bucket, `${firstId}/text.txt`, "abcdef");
    const documents = createDocuments(bucket.binding(), origin);
    const doc = (await documents.resolve(firstId))!;
    for (const maxBytes of [0, -1, Infinity, 1.1]) await expect(doc.openBody({ maxBytes })).rejects.toThrow("positive safe integer");
    await expect(doc.openBody({ maxBytes: 1, range: { offset: 1 } })).rejects.toThrow("Choose range or maxBytes");
    expect(bucket.getCalls).toEqual([]);
    expect(await (await doc.openBody({ range: { offset: 2, length: 2 } }))!.text()).toBe("cd");
    await expect(doc.openBody()).rejects.toThrow("already been opened");
    const bounded = (await documents.resolve(firstId))!;
    expect(await (await bounded.openBody({ maxBytes: 2 }))!.text()).toBe("ab");
  });

  it("distinguishes removed bodies from conditional mismatch and cancels same-etag new-version streams", async () => {
    const bucket = new LocalBucket();
    await seed(bucket, `${firstId}/text.txt`, "same");
    const documents = createDocuments(bucket.binding(), origin);
    const changed = (await documents.resolve(firstId))!;
    await seed(bucket, `${firstId}/text.txt`, "same");
    let canceled = false;
    const actualGet = bucket.get.bind(bucket);
    vi.spyOn(bucket, "get").mockImplementation(async (...args) => {
      const object = await actualGet(...args);
      if (object && "body" in object) {
        const cancel = object.body.cancel.bind(object.body);
        vi.spyOn(object.body, "cancel").mockImplementation(async () => { canceled = true; await cancel(); });
      }
      return object;
    });
    await expect(changed.openBody()).rejects.toThrow("changed before body read");
    expect(canceled).toBe(true);
    const missing = (await documents.resolve(firstId))!;
    await bucket.delete(`${firstId}/text.txt`);
    expect(await missing.openBody()).toBeNull();
    await expect(missing.openBody()).rejects.toThrow("already been opened");
    await seed(bucket, `${firstId}/text.txt`, "before");
    const mismatched = (await documents.resolve(firstId))!;
    await seed(bucket, `${firstId}/text.txt`, "after");
    await expect(mismatched.openBody()).rejects.toThrow("changed before body read");
  });

  it("fails get errors and invalid ID/key inputs without leaking a body", async () => {
    const bucket = new LocalBucket();
    const documents = createDocuments(bucket.binding(), origin);
    expect(await documents.resolve("../private")).toBeNull();
    expect((await documents.remove("__docs_internal")).status).toBe("not-found");
    expect(bucket.listCalls).toEqual([]);
    await seed(bucket, `${firstId}/text.txt`);
    const doc = (await documents.resolve(firstId))!;
    bucket.failGet = true;
    await expect(doc.openBody()).rejects.toThrow("get failed");
    await expect(doc.openBody()).rejects.toThrow("already been opened");
  });
});
