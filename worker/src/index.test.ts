import { describe, expect, it } from "vitest";

import worker from "./index";
import type { PublicEnv } from "./contracts";
import { createDocuments } from "./documents";
import { extractText } from "./extract";
import { createSearchIndex } from "./search";
import { catalogAssets } from "./ui";

const uploadId = "Ab12Cd34";

interface ListedPage {
  objects: Array<{ key: string }>;
  truncated: boolean;
  cursor?: string;
}

/** In-memory R2 boundary used to exercise deletion through the Worker's fetch handler. */
class FakeBucket {
  readonly deletedBatches: string[][] = [];
  readonly listCalls: Array<{ prefix?: string; cursor?: string }> = [];
  failList = false;
  failDelete = false;

  constructor(private readonly pages: Record<string, ListedPage>) {}

  async list(options: { prefix?: string; cursor?: string }): Promise<ListedPage> {
    this.listCalls.push(options);
    if (this.failList) throw new Error("list failed");
    return this.pages[options.cursor ?? "first"] ?? { objects: [], truncated: false };
  }

  async delete(keys: string | string[]): Promise<void> {
    if (this.failDelete) throw new Error("delete failed");
    this.deletedBatches.push(Array.isArray(keys) ? keys : [keys]);
  }
}

function request(path = `/upload/${uploadId}`, token = "secret"): Request {
  const headers = token ? { Authorization: `Bearer ${token}` } : undefined;
  return new Request(`https://docs.example${path}`, { method: "DELETE", headers });
}

function environment(bucket: FakeBucket): PublicEnv {
  return {
    DOCS_BUCKET: bucket as unknown as R2Bucket, AUTH_TOKEN: "secret", APP_ROLE: "public",
    PUBLIC_DOCS_ORIGIN: "https://docs.example", CATALOG_ORIGIN: "https://library.example",
  };
}

describe("DELETE /upload/:id", () => {
  it("deletes every paginated object in R2-sized batches", async () => {
    const firstKeys = Array.from({ length: 1000 }, (_, index) => `${uploadId}/part-${index}`);
    const remainingKeys = [`${uploadId}/part-1000`, `${uploadId}/part-1001`];
    const bucket = new FakeBucket({
      first: {
        objects: firstKeys.map((key) => ({ key })),
        truncated: true,
        cursor: "next-page",
      },
      "next-page": {
        objects: remainingKeys.map((key) => ({ key })),
        truncated: false,
      },
    });

    const response = await worker.fetch(request(), environment(bucket));

    expect(response.status).toBe(204);
    expect(response.headers.get("X-Docs-Delete-Result")).toBe("deleted");
    expect(bucket.listCalls).toEqual([
      { prefix: `${uploadId}/`, cursor: undefined },
      { prefix: `${uploadId}/`, cursor: "next-page" },
    ]);
    expect(bucket.deletedBatches).toEqual([firstKeys, remainingKeys]);
  });

  it("returns not found without deleting when the ID has no objects", async () => {
    const bucket = new FakeBucket({ first: { objects: [], truncated: false } });

    const response = await worker.fetch(request(), environment(bucket));

    expect(response.status).toBe(404);
    expect(response.headers.get("X-Docs-Delete-Result")).toBe("not-found");
    expect(bucket.deletedBatches).toEqual([]);
  });

  it("rejects missing or invalid bearer authentication before accessing R2", async () => {
    for (const token of ["", "wrong-token"]) {
      const bucket = new FakeBucket({ first: { objects: [{ key: `${uploadId}/report.html` }], truncated: false } });

      const response = await worker.fetch(request(`/upload/${uploadId}`, token), environment(bucket));

      expect(response.status).toBe(401);
      expect(bucket.listCalls).toEqual([]);
    }
  });

  it("rejects malformed IDs and filename-bearing paths without accessing R2", async () => {
    for (const path of ["/upload/short", `/upload/${uploadId}/report.html`]) {
      const bucket = new FakeBucket({ first: { objects: [{ key: `${uploadId}/report.html` }], truncated: false } });

      const response = await worker.fetch(request(path), environment(bucket));

      expect(response.status).toBe(404);
      expect(bucket.listCalls).toEqual([]);
    }
  });

  it("returns a storage error when listing fails", async () => {
    const bucket = new FakeBucket({});
    bucket.failList = true;

    const response = await worker.fetch(request(), environment(bucket));

    expect(response.status).toBe(500);
    expect(await response.text()).toBe("Storage error");
  });

  it("returns a storage error when deletion fails", async () => {
    const bucket = new FakeBucket({
      first: { objects: [{ key: `${uploadId}/report.html` }], truncated: false },
    });
    bucket.failDelete = true;

    const response = await worker.fetch(request(), environment(bucket));

    expect(response.status).toBe(500);
    expect(await response.text()).toBe("Storage error");
  });
});

describe("role isolation", () => {
  it("redirects the public catalog entry without touching document storage", async () => {
    const bucket = new FakeBucket({});
    const response = await worker.fetch(new Request("https://docs.example/all-docs"), {
      ...environment(bucket),
      APP_ROLE: "public",
      PUBLIC_DOCS_ORIGIN: "https://docs.example",
      CATALOG_ORIGIN: "https://library.example",
    });

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("https://library.example/all-docs");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("X-Robots-Tag")).toContain("noindex");
    expect(bucket.listCalls).toEqual([]);
  });

  it("serves trusted catalog assets and rejects unauthenticated JSON and unknown paths without public storage", async () => {
    for (const [path, status] of [
      ["/all-docs", 200], ["/all-docs/assets/app.js", 200],
      ["/all-docs/api/documents", 401], ["/all-docs/session", 401],
      ["/", 404], [`/${uploadId}`, 404], [`/${uploadId}/raw`, 404],
      [`/${uploadId}/download`, 404], ["/upload", 404],
    ] as const) {
      const bucket = new FakeBucket({});
      const response = await worker.fetch(new Request(`https://library.example${path}`), {
        DOCS_BUCKET: bucket as unknown as R2Bucket,
        APP_ROLE: "catalog",
        PUBLIC_DOCS_ORIGIN: "https://docs.example",
        CATALOG_ORIGIN: "https://library.example",
        ALL_DOCS_PASSWORD: "fixture-password",
        CATALOG_SESSION_KEY: "fixture-signing-key-at-least-32-bytes",
      });
      expect(response.status).toBe(status);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(response.headers.get("X-Robots-Tag")).toContain("noindex");
      expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
      expect(response.headers.get("Set-Cookie")).toBeNull();
      expect(bucket.listCalls).toEqual([]);
    }
    const bucket = new FakeBucket({});
    const response = await worker.fetch(new Request("https://library.example/all-docs"), {
      DOCS_BUCKET: bucket as unknown as R2Bucket, APP_ROLE: "catalog",
      PUBLIC_DOCS_ORIGIN: "https://docs.example", CATALOG_ORIGIN: "https://library.example",
      ALL_DOCS_PASSWORD: "", CATALOG_SESSION_KEY: "",
    });
    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(bucket.listCalls).toEqual([]);
  });

  it("never resolves arbitrary or private prefixes as public documents", async () => {
    for (const path of ["/__docs_internal", "/__docs_internal/raw", "/short/download", "/%5F_private/raw"]) {
      const bucket = new FakeBucket({});
      const response = await worker.fetch(new Request(`https://docs.example${path}`), environment(bucket));

      expect(response.status).toBe(404);
      expect(bucket.listCalls).toEqual([]);
    }
  });
});

/** Native R2-shaped adapter. All owned routing/rendering/storage modules remain real in these tests. */
class MemoryBucket {
  readonly records = new Map<string, { object: R2Object; bytes: Uint8Array }>();
  failGet = false;
  failPut = false;
  private revision = 0;

  async put(key: string, body: ReadableStream | string | null, options: R2PutOptions = {}): Promise<R2Object | null> {
    if (this.failPut) throw new Error("put failed");
    const bytes = new Uint8Array(await new Response(body).arrayBuffer());
    const etag = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
      .map((byte) => byte.toString(16).padStart(2, "0")).join("");
    // Check after the async body read, at commit, so overlapping creates cannot both win.
    if (!this.matches(this.records.get(key)?.object, options.onlyIf)) return null;
    const revision = String(++this.revision);
    const object: R2Object = {
      key, version: revision, etag, httpEtag: `"${etag}"`, size: bytes.length,
      uploaded: new Date("2026-10-14T12:00:00Z"), customMetadata: options.customMetadata,
      httpMetadata: options.httpMetadata instanceof Headers ? undefined : options.httpMetadata,
      checksums: { toJSON: () => ({}) }, storageClass: "Standard", writeHttpMetadata() {},
    };
    this.records.set(key, { object, bytes });
    return object;
  }

  async list(options: R2ListOptions & { include?: ("customMetadata" | "httpMetadata")[] } = {}) {
    const prefix = options.prefix ?? "";
    const cursor = options.cursor ? JSON.parse(atob(options.cursor)) as { prefix: string; after: string } : null;
    if (cursor && cursor.prefix !== prefix) throw new Error("wrong cursor scope");
    const all = [...this.records.values()].map((entry) => entry.object)
      .filter((object) => object.key.startsWith(prefix) && (!cursor || object.key > cursor.after))
      .sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
    const selected = all.slice(0, Math.min(options.limit ?? 1000, 1000));
    const objects = selected.map((object) => ({
      ...object, writeHttpMetadata() {},
      customMetadata: options.include?.includes("customMetadata") ? object.customMetadata : undefined,
      httpMetadata: options.include?.includes("httpMetadata") ? object.httpMetadata : undefined,
    }));
    return all.length > selected.length
      ? { objects, truncated: true, cursor: btoa(JSON.stringify({ prefix, after: selected.at(-1)!.key })) }
      : { objects, truncated: false };
  }

  async head(key: string): Promise<R2Object | null> {
    if (this.failGet) throw new Error("head failed");
    return this.records.get(key)?.object ?? null;
  }

  private matches(object: R2Object | undefined, condition?: R2Conditional | Headers): boolean {
    if (!condition) return true;
    const equal = (value: string) => value === "*" ? !!object : !!object && value.replace(/^"|"$/g, "") === object.etag;
    const match = condition instanceof Headers ? condition.get("If-Match") : condition.etagMatches;
    const none = condition instanceof Headers ? condition.get("If-None-Match") : condition.etagDoesNotMatch;
    return (!match || equal(match)) && (!none || !equal(none));
  }

  async get(key: string, options: R2GetOptions = {}): Promise<R2Object | R2ObjectBody | null> {
    if (this.failGet) throw new Error("get failed");
    const entry = this.records.get(key);
    if (!entry) return null;
    if (!this.matches(entry.object, options.onlyIf)) return entry.object;
    const range = options.range;
    let bytes = entry.bytes;
    if (range && !(range instanceof Headers)) {
      const offset = "suffix" in range ? Math.max(0, bytes.length - range.suffix) : range.offset || 0;
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

  async delete(keys: string | string[]) {
    const batch = Array.isArray(keys) ? keys : [keys];
    if (batch.length > 1000) throw new Error("native R2 delete limit exceeded");
    for (const key of batch) this.records.delete(key);
  }
}

function memoryEnv(bucket: MemoryBucket): PublicEnv {
  return { ...environment(new FakeBucket({})), DOCS_BUCKET: bucket as unknown as R2Bucket };
}

async function fixture(filename: string, body: string, mime?: string): Promise<MemoryBucket> {
  const bucket = new MemoryBucket();
  await bucket.put(`${uploadId}/${filename}`, body, {
    customMetadata: { filename, docName: "Fixture <title>", ...(mime ? { contentType: mime } : {}) },
  });
  return bucket;
}

describe("legacy public document routes", () => {
  it("round-trips upload, HTML page, raw/download bytes and marked deletion", async () => {
    const bucket = new MemoryBucket();
    const env = memoryEnv(bucket);
    const body = '<!doctype html><html><body><h1>Original</h1><script>window.fixture = true</script></body></html>';
    const upload = await worker.fetch(new Request("https://docs.example/upload", {
      method: "PUT", body,
      headers: { Authorization: "Bearer secret", "X-Filename": "a report.html", "X-Doc-Name": "A report", "Content-Type": "text/html" },
    }), env);
    expect(upload.status).toBe(200);
    const result = await upload.json() as { id: string; url: string };
    expect(result.id).toMatch(/^[A-Za-z0-9]{8}$/);
    expect(result.url).toBe(`https://docs.example/${result.id}`);
    for (const variant of ["", "/raw", "/download"]) {
      const response = await worker.fetch(new Request(`${result.url}${variant}`), env);
      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe("text/html");
      const served = await response.text();
      if (variant) expect(served).toBe(body); // Raw/download retain the exact original bytes.
      else {
        expect(served.startsWith(body)).toBe(true); // Authored markup, scripts and styles survive.
        expect(served).toContain('data-vh="runtime"');
      }
      if (variant) expect(response.headers.get("Content-Disposition")).toBe(`${variant === "/raw" ? "inline" : "attachment"}; filename="a_report.html"`);
    }
    const deleted = await worker.fetch(request(`/upload/${result.id}`), env);
    expect(deleted.status).toBe(204);
    expect(deleted.headers.get("X-Docs-Delete-Result")).toBe("deleted");
    expect((await worker.fetch(new Request(result.url), env)).status).toBe(404);
  });

  it("renders safe Markdown, native PDF and metadata/download previews", async () => {
    for (const [filename, bytes, expected] of [
      ["notes.md", "# A note\nSome Markdown", "<h1>A note</h1>"],
      ["report.pdf", "%PDF fixture", '<iframe src="https://docs.example/Ab12Cd34/raw"'],
      ["archive.zip", "binary fixture", "No preview for archive files."],
    ]) {
      const bucket = await fixture(filename, bytes);
      const env = memoryEnv(bucket);
      const response = await worker.fetch(new Request(`https://docs.example/${uploadId}`), env);
      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
      const html = await response.text();
      expect(html).toContain(expected);
      expect(html).toContain("Fixture &#60;title&#62;");
      const raw = await worker.fetch(new Request(`https://docs.example/${uploadId}/raw`), env);
      expect(await raw.text()).toBe(bytes);
    }
  });

  it("rejects unauthorized upload without creating any document", async () => {
    const bucket = new MemoryBucket();
    const response = await worker.fetch(new Request("https://docs.example/upload", { method: "PUT", body: "bad" }), memoryEnv(bucket));
    expect(response.status).toBe(401);
    expect(bucket.records.size).toBe(0);
  });

  it("turns body-read and upload storage failures into unmarked 500 responses", async () => {
    const bucket = await fixture("page.html", "<h1>Test</h1>");
    bucket.failGet = true;
    const read = await worker.fetch(new Request(`https://docs.example/${uploadId}`), memoryEnv(bucket));
    expect(read.status).toBe(500);
    expect(await read.text()).toBe("Storage error");
    bucket.failPut = true;
    const upload = await worker.fetch(new Request("https://docs.example/upload", {
      method: "PUT", body: "test", headers: { Authorization: "Bearer secret" },
    }), memoryEnv(bucket));
    expect(upload.status).toBe(500);
    expect(upload.headers.get("X-Docs-Delete-Result")).toBeNull();
  });

  it("keeps malformed continuations and partial deletion failures unmarked", async () => {
    const bucket = new FakeBucket({ first: { objects: [{ key: `${uploadId}/part` }], truncated: true } });
    const response = await worker.fetch(request(), environment(bucket));
    expect(response.status).toBe(500);
    expect(response.headers.get("X-Docs-Delete-Result")).toBeNull();
    expect(bucket.deletedBatches).toEqual([]);
  });

  it("fails closed for absent role, same origins and wrong request origin", async () => {
    const bucket = new FakeBucket({});
    for (const env of [
      { ...environment(bucket), APP_ROLE: undefined } as unknown as PublicEnv,
      { ...environment(bucket), CATALOG_ORIGIN: "https://docs.example" },
      { ...environment(bucket), PUBLIC_DOCS_ORIGIN: "https://other.example" },
    ]) {
      const response = await worker.fetch(new Request(`https://docs.example/${uploadId}`), env);
      expect(response.status).toBe(503);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
    }
    expect(bucket.listCalls).toEqual([]);
  });
});

describe("Documents and trusted asset interfaces", () => {
  it("derives aggregate metadata and versions from storage, ignoring a legacy client timestamp", async () => {
    const bucket = await fixture("a.html", "<h1>A</h1>", "text/html");
    await bucket.put(`${uploadId}/b.html`, "B", { customMetadata: { uploadedAt: "1900-01-01T00:00:00Z" } });
    const documents = createDocuments(bucket as unknown as R2Bucket, "https://docs.example");
    const doc = await documents.resolve(uploadId);
    expect(doc?.summary).toMatchObject({
      id: uploadId, filename: "a.html", kind: "html", mime: "text/html", sizeBytes: 11,
      uploadedAt: "2026-10-14T12:00:00.000Z", timeSource: "r2", createdAt: null,
      objectCount: 2, publicUrl: `https://docs.example/${uploadId}`,
    });
    expect(doc?.summary.warnings).toHaveLength(1);
    expect(doc?.summary.version).toMatch(/^[a-f0-9]{64}$/);
    await bucket.put(`${uploadId}/b.html`, "B");
    const updated = await documents.resolve(uploadId);
    expect(updated?.summary.version).not.toBe(doc?.summary.version);
    expect(await (await doc?.openBody())?.text()).toBe("<h1>A</h1>");
  });

  it("bounds body reads and enforces single-consumer ownership", async () => {
    const bucket = await fixture("note.txt", "abcdef", "text/plain");
    const documents = createDocuments(bucket as unknown as R2Bucket, "https://docs.example");
    const doc = (await documents.resolve(uploadId))!;
    expect(await (await doc.openBody({ maxBytes: 3 }))?.text()).toBe("abc");
    await expect(doc.openBody()).rejects.toThrow("already been opened");
    const changed = (await documents.resolve(uploadId))!;
    await bucket.put(`${uploadId}/note.txt`, "replacement");
    await expect(changed.openBody()).rejects.toThrow("changed before body read");
  });

  it("discovers complete metadata and removes the reviewed legacy version", async () => {
    const bucket = await fixture("notes.md", "# test");
    const documents = createDocuments(bucket as unknown as R2Bucket, "https://docs.example");
    const doc = (await documents.resolve(uploadId))!;
    const page = await documents.page();
    expect(page).toMatchObject({ items: [doc.summary], scanComplete: true, nextCursor: null });
    expect(await documents.remove(uploadId, doc.summary.version)).toEqual({ status: "deleted", deletedObjectCount: 1 });
    expect(await documents.resolve(uploadId)).toBeNull();
  });

  it("extracts legacy source and searches its content through the owned interfaces", async () => {
    const bucket = await fixture("notes.md", "# test");
    const documents = createDocuments(bucket as unknown as R2Bucket, "https://docs.example");
    const doc = (await documents.resolve(uploadId))!;
    const text = await extractText(doc);
    expect(text).toMatchObject({ coverage: "full", text: "# test", indexedBytes: 6 });
    await expect(doc.openBody()).rejects.toThrow("already been opened");
    const index = createSearchIndex();
    index.add(doc.summary, text);
    expect(index.query(
      { text: "test", mode: "literal", ignoreCase: true },
      { kinds: [], uploadedBefore: null, uploadedAfter: null },
    )).toMatchObject([{ id: uploadId, matchCount: 1 }]);
  });

  it("only exposes explicitly bundled trusted assets through the asset interface", async () => {
    expect(catalogAssets("/all-docs/assets/app.js")?.headers.get("Content-Type")).toBe("text/javascript; charset=utf-8");
    for (const path of ["/all-docs/assets/../../raw", `/${uploadId}/raw`, "/toString", "/__proto__"]) {
      expect(catalogAssets(path)).toBeNull();
    }
  });
});
