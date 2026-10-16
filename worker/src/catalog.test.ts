import { afterEach, describe, expect, it, vi } from "vitest";
import { createCatalog, type CatalogSecurity } from "./catalog";
import type { SessionResponse } from "./contracts";
import { DEFAULT_LIBRARY_CONFIG, LibraryIndexError, type LibraryIndex } from "./library-index";
import type { LibraryPage, LibrarySearchResponse, LibraryStatus } from "./library-contracts";
import type { Documents, ResolvedDocument } from "./documents";

const origin = "https://library.example";
const security: CatalogSecurity = {
  catalogOrigin: origin, publicOrigin: "https://docs.example",
  password: "fixture password", sessionKey: "fixture-signing-key-at-least-32-bytes",
};

/** Native-shaped R2 adapter with conditional writes; only disposable authentication state lives here. */
class AuthBucket {
  records = new Map<string, { bytes: string; etag: string }>();
  writes = 0;
  fail = false;
  conflicts = false;
  async get(key: string) {
    if (this.fail) throw new Error("private storage detail");
    const entry = this.records.get(key);
    return entry ? { etag: entry.etag, size: new TextEncoder().encode(entry.bytes).length, body: new Response(entry.bytes).body! } : null;
  }
  async put(key: string, value: string, options: R2PutOptions) {
    if (this.fail) throw new Error("private storage detail");
    const condition = options.onlyIf as R2Conditional;
    const entry = this.records.get(key);
    if (this.conflicts || (condition.etagMatches && condition.etagMatches !== entry?.etag)
      || (condition.etagDoesNotMatch === "*" && entry)) return null;
    const etag = String(++this.writes);
    this.records.set(key, { bytes: value, etag });
    return { etag };
  }
}

function setup(overrides: Partial<CatalogSecurity> = {}, bucket = new AuthBucket()) {
  const page = vi.fn<LibraryIndex["page"]>().mockResolvedValue(libraryPage());
  const resolve = vi.fn<Documents["resolve"]>().mockResolvedValue(null);
  const remove = vi.fn<Documents["remove"]>().mockResolvedValue({ status: "deleted", deletedObjectCount: 1 });
  const documents: Documents = { create: vi.fn(), page, resolve, remove };
  const search = vi.fn<LibraryIndex["search"]>().mockResolvedValue(searchPage());
  const snippets = vi.fn<LibraryIndex["snippets"]>().mockResolvedValue({ version: 1, generation: 1, hits: [], unavailable: [], remaining: [] });
  const maintain = vi.fn<LibraryIndex["maintain"]>().mockResolvedValue({ version: 1, outcome: "complete", generation: 1, processed: 0, indexed: 0, failed: 0, repaired: 0, reconciledPages: 0, textBytes: 0, status: libraryStatus() });
  const library = vi.fn(() => ({ documents, page, search, snippets, maintain }));
  const assets = vi.fn((path: string) => new Response(path === "/all-docs" ? "<h1>Trusted shell</h1>" : "trusted asset", {
    headers: { "Content-Type": path === "/all-docs" ? "text/html" : "text/javascript" },
  }));
  const catalog = createCatalog({ library, config: DEFAULT_LIBRARY_CONFIG, assets, security: { ...security, ...overrides }, bucket: bucket as unknown as R2Bucket });
  return { catalog, bucket, documents, page, resolve, remove, search, snippets, maintain, library, assets };
}
function req(path: string, options: RequestInit = {}) { return new Request(origin + path, options); }
function jsonRequest(path: string, method = "GET", body?: unknown, headers: Record<string, string | undefined> = {}) {
  const merged = new Headers({ Origin: origin, "Sec-Fetch-Site": "same-origin", "X-Docs-Catalog": "1", "Content-Type": "application/json" });
  for (const [key, value] of Object.entries(headers)) if (value !== undefined) merged.set(key, value);
  return req(path, { method, headers: merged, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function login(app: ReturnType<typeof setup>) {
  const response = await app.catalog.fetch(jsonRequest("/all-docs/session", "POST", { password: security.password }));
  expect(response.status).toBe(200);
  const session = await response.json() as SessionResponse;
  const cookie = response.headers.get("Set-Cookie")!.split(";")[0];
  return { response, session, cookie };
}
function privateHeaders(response: Response) {
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(response.headers.get("X-Robots-Tag")).toContain("noindex");
  expect(response.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
  expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
  expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
  expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
}
afterEach(() => vi.useRealTimers());

describe("Catalog HTTP security", () => {
  it("serves only the trusted shell/assets and issues a private host-only 12h session", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-14T00:00:00Z"));
    const app = setup();
    const shell = await app.catalog.fetch(req("/all-docs"));
    expect(shell.status).toBe(200);
    expect(await shell.text()).toBe("<h1>Trusted shell</h1>");
    privateHeaders(shell);
    // Card previews may frame only the configured public origin; nothing else is loosened.
    expect(shell.headers.get("Content-Security-Policy")).toBe(
      "default-src 'none'; script-src 'self'; style-src 'self'; worker-src 'self'; connect-src 'self'; img-src 'self'; font-src 'self'; frame-src https://docs.example; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    expect(app.bucket.writes).toBe(0);
    expect(app.page).not.toHaveBeenCalled();
    const { response, session, cookie } = await login(app);
    privateHeaders(response);
    expect(session).toMatchObject({ version: 1, expiresAt: "2026-10-14T12:00:00.000Z" });
    expect(session.csrfToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    for (const attribute of ["__Host-docs_catalog=", "Path=/", "Secure", "HttpOnly", "SameSite=Strict", "Max-Age=43200"]) expect(response.headers.get("Set-Cookie")).toContain(attribute);
    expect(response.headers.get("Set-Cookie")).not.toMatch(/Domain=/i);
    const bootstrap = await app.catalog.fetch(jsonRequest("/all-docs/session", "GET", undefined, { Cookie: cookie }));
    expect(await bootstrap.json()).toEqual(session);
  });
});

describe("authentication, isolation and private failures", () => {
  it("fails closed on absent/oversized secrets, nonliteral/shared origins and aliases", async () => {
    for (const override of [
      { password: "" }, { password: "x".repeat(1025) }, { sessionKey: "" }, { sessionKey: "short" },
      { catalogOrigin: security.publicOrigin }, { publicOrigin: origin }, { catalogOrigin: origin + "/" },
      { catalogOrigin: "http://library.example" },
    ]) {
      const app = setup(override);
      const response = await app.catalog.fetch(req("/all-docs"));
      expect(response.status).toBe(503);
      privateHeaders(response);
      expect(response.headers.get("Content-Security-Policy")).not.toContain("frame-src");
      expect(app.assets).not.toHaveBeenCalled();
      expect(app.bucket.writes).toBe(0);
    }
    const app = setup();
    const alias = await app.catalog.fetch(new Request("https://preview.example/all-docs"));
    expect(alias.status).toBe(503);
    privateHeaders(alias);
    expect(app.assets).not.toHaveBeenCalled();
  });

  it("never falls back to public uploads, raw/download, encoded aliases or legacy delete jobs", async () => {
    const app = setup();
    for (const path of ["/", "/all-docs/", "/Ab12Cd34", "/Ab12Cd34/raw", "/Ab12Cd34/download", "/upload", "/%61ll-docs", "/all-docs/assets/extra.js", "/all-docs/assets/%61pp.js", "/all-docs/api/delete-review", "/all-docs/api/delete-batch"]) {
      const response = await app.catalog.fetch(req(path));
      expect(response.status).toBe(404);
      privateHeaders(response);
    }
    for (const method of ["OPTIONS", "HEAD", "PUT", "PATCH"]) {
      const response = await app.catalog.fetch(req("/all-docs/session", { method }));
      expect(response.status).toBe(404);
      privateHeaders(response);
    }
    expect(app.assets).not.toHaveBeenCalled();
    expect(app.resolve).not.toHaveBeenCalled();
    expect(app.remove).not.toHaveBeenCalled();
    expect(app.bucket.writes).toBe(0);
  });

  it("authenticates before document validation, existence, cursors and storage errors", async () => {
    const app = setup();
    app.page.mockRejectedValue(new Error("private detail"));
    for (const path of ["/all-docs/session", "/all-docs/api/documents?cursor=bad", "/all-docs/api/delete"]) {
      const response = await app.catalog.fetch(jsonRequest(path, path.endsWith("delete") ? "POST" : "GET", path.endsWith("delete") ? {} : undefined));
      expect(response.status).toBe(401);
      privateHeaders(response);
      expect(response.headers.get("Set-Cookie")).toBeNull();
    }
    expect(app.page).not.toHaveBeenCalled();
    expect(app.resolve).not.toHaveBeenCalled();
    expect(app.remove).not.toHaveBeenCalled();
  });

  it("compares passwords exactly without trimming or space padding", async () => {
    for (const password of ["wrong", security.password + " ", " " + security.password, security.password.toUpperCase()]) {
      const app = setup();
      const response = await app.catalog.fetch(jsonRequest("/all-docs/session", "POST", { password }));
      expect(response.status).toBe(401);
      expect(response.headers.get("Set-Cookie")).toBeNull();
      privateHeaders(response);
    }
  });

  it("rejects tampered, oversized and duplicate cookies; expires and rotates credentials", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-14T00:00:00Z"));
    const app = setup();
    const { cookie } = await login(app);
    for (const badCookie of [cookie.slice(0, -3) + "xyz", cookie + "; " + cookie, "__Host-docs_catalog=" + "x".repeat(9000), "__Host-docs_catalog=bad"]) {
      const response = await app.catalog.fetch(jsonRequest("/all-docs/session", "GET", undefined, { Cookie: badCookie }));
      expect(response.status).toBe(401);
      privateHeaders(response);
    }
    for (const override of [{ password: "rotated password" }, { sessionKey: "rotated-random-signing-key-at-least-32-bytes" }]) {
      expect((await setup(override, app.bucket).catalog.fetch(jsonRequest("/all-docs/session", "GET", undefined, { Cookie: cookie }))).status).toBe(401);
    }
    vi.setSystemTime(new Date("2026-10-14T11:59:59Z"));
    expect((await app.catalog.fetch(jsonRequest("/all-docs/session", "GET", undefined, { Cookie: cookie }))).status).toBe(200);
    vi.setSystemTime(new Date("2026-10-14T12:00:00Z"));
    expect((await app.catalog.fetch(jsonRequest("/all-docs/session", "GET", undefined, { Cookie: cookie }))).status).toBe(401);
  });

  it("requires exact Origin and header on login before any storage or password evaluation", async () => {
    for (const headers of [
      { Origin: "https://docs.example" }, { Origin: "null" }, { Origin: origin + "/" },
      { "Sec-Fetch-Site": "same-site" }, { "Sec-Fetch-Site": "cross-site" }, { "X-Docs-Catalog": "0" },
    ]) {
      const app = setup();
      const response = await app.catalog.fetch(jsonRequest("/all-docs/session", "POST", { password: security.password }, headers));
      expect(response.status).toBe(403);
      privateHeaders(response);
      expect(app.bucket.writes).toBe(0);
    }
    const app = setup();
    const request = jsonRequest("/all-docs/session", "POST", { password: security.password });
    request.headers.delete("Origin");
    expect((await app.catalog.fetch(request)).status).toBe(403);
    expect(app.bucket.writes).toBe(0);
  });

  it("requires session plus read header and consistent browser provenance, even when Fetch Metadata is spoofed", async () => {
    const app = setup();
    const { cookie } = await login(app);
    for (const headers of [
      { Origin: "https://docs.example", "Sec-Fetch-Site": "same-origin" },
      { Origin: origin, "Sec-Fetch-Site": "same-site" }, { Origin: origin, "Sec-Fetch-Site": "cross-site" },
      { Origin: "null" }, { "X-Docs-Catalog": "" },
    ]) {
      const response = await app.catalog.fetch(jsonRequest("/all-docs/api/documents", "GET", undefined, { Cookie: cookie, ...headers }));
      expect(response.status).toBe(403);
      privateHeaders(response);
    }
    const absent = jsonRequest("/all-docs/api/documents", "GET", undefined, { Cookie: cookie });
    absent.headers.delete("Origin"); absent.headers.delete("Sec-Fetch-Site");
    expect((await app.catalog.fetch(absent)).status).toBe(403);
    expect(app.page).not.toHaveBeenCalled();
    const browser = jsonRequest("/all-docs/api/documents", "GET", undefined, { Cookie: cookie });
    browser.headers.delete("Origin");
    expect((await app.catalog.fetch(browser)).status).toBe(200);
  });

  it("checks session-bound CSRF and exact Origin on logout, then clears the host cookie", async () => {
    const app = setup();
    const { cookie, session } = await login(app);
    const other = await login(app);
    for (const headers of [
      { "X-CSRF-Token": "" }, { "X-CSRF-Token": "x".repeat(43) }, { "X-CSRF-Token": other.session.csrfToken },
      { "X-CSRF-Token": session.csrfToken, Origin: security.publicOrigin },
    ]) {
      const response = await app.catalog.fetch(jsonRequest("/all-docs/session", "DELETE", undefined, { Cookie: cookie, ...headers }));
      expect(response.status).toBe(403);
      expect(response.headers.get("Set-Cookie")).toBeNull();
    }
    const response = await app.catalog.fetch(jsonRequest("/all-docs/session", "DELETE", undefined, { Cookie: cookie, "X-CSRF-Token": session.csrfToken }));
    expect(response.status).toBe(204);
    expect(response.headers.get("Set-Cookie")).toContain("Max-Age=0");
    privateHeaders(response);
  });

  it("keeps asset failures, unexpected exceptions and storage failure details private", async () => {
    const app = setup();
    app.assets.mockImplementationOnce(() => { throw new Error("secret asset detail"); });
    const failure = await app.catalog.fetch(req("/all-docs"));
    expect(failure.status).toBe(503);
    expect(await failure.text()).not.toContain("secret asset detail");
    privateHeaders(failure);
    const { cookie } = await login(app);
    app.page.mockRejectedValueOnce(new Error("secret storage key"));
    const storage = await app.catalog.fetch(jsonRequest("/all-docs/api/documents", "GET", undefined, { Cookie: cookie }));
    expect(storage.status).toBe(503);
    expect(await storage.text()).not.toContain("secret storage key");
    privateHeaders(storage);
  });
});

function streamed(body: ReadableStream<Uint8Array>, path = "/all-docs/session", headers = new Headers(jsonRequest(path).headers)) {
  return req(path, { method: "POST", headers, body, ...{ duplex: "half" } });
}

describe("bounded bodies and shared login throttling", () => {
  it("caps declared and streamed credential bytes and cancels oversized streams", async () => {
    const app = setup();
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(2049)); },
      cancel() { cancelled = true; },
    });
    const response = await app.catalog.fetch(streamed(body));
    expect(response.status).toBe(413);
    expect(cancelled).toBe(true);
    privateHeaders(response);
    expect(app.bucket.writes).toBe(0);
    const declared = jsonRequest("/all-docs/session", "POST", { password: security.password }, { "Content-Length": "2049" });
    expect((await app.catalog.fetch(declared)).status).toBe(413);
    expect(app.bucket.writes).toBe(0);
    const lied = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(2049)); c.close(); } });
    const headers = new Headers(jsonRequest("/all-docs/session").headers);
    headers.set("Content-Length", "1");
    expect((await app.catalog.fetch(streamed(lied, undefined, headers))).status).toBe(413);
  });

  it("rejects malformed JSON, credentials, invalid UTF-8 and non-JSON without R2 access", async () => {
    const app = setup();
    for (const body of [null, [], {}, { password: 42 }, { password: "" }, { password: "x".repeat(1025) }]) {
      expect((await app.catalog.fetch(jsonRequest("/all-docs/session", "POST", body))).status).toBe(400);
    }
    const headers = jsonRequest("/all-docs/session").headers;
    expect((await app.catalog.fetch(req("/all-docs/session", { method: "POST", headers, body: "{" }))).status).toBe(400);
    expect((await app.catalog.fetch(req("/all-docs/session", { method: "POST", headers, body: new Uint8Array([0xff]) }))).status).toBe(400);
    expect((await app.catalog.fetch(jsonRequest("/all-docs/session", "POST", {}, { "Content-Type": "text/plain" }))).status).toBe(415);
    expect(app.bucket.writes).toBe(0);
  });

  it("times out and cancels a credential stream that never finishes", async () => {
    vi.useFakeTimers();
    let cancelled = false;
    const app = setup();
    const response = app.catalog.fetch(streamed(new ReadableStream({ cancel() { cancelled = true; } })));
    await vi.advanceTimersByTimeAsync(10_001);
    const result = await response;
    expect(result.status).toBe(408);
    expect(cancelled).toBe(true);
    privateHeaders(result);
    expect(app.bucket.writes).toBe(0);
  });

  it("persists per-IP budgets across new catalog instances and resets at the next fixed window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-14T00:00:00Z"));
    const bucket = new AuthBucket();
    for (let attempt = 0; attempt < 10; attempt++) {
      const response = await setup({}, bucket).catalog.fetch(jsonRequest("/all-docs/session", "POST", { password: "wrong" }));
      expect(response.status).toBe(401);
    }
    const throttled = await setup({}, bucket).catalog.fetch(jsonRequest("/all-docs/session", "POST", { password: security.password }));
    expect(throttled.status).toBe(429);
    expect(throttled.headers.get("Retry-After")).toBe("600");
    privateHeaders(throttled);
    expect([...bucket.records.keys()].every((key) => key.startsWith("__docs_internal/catalog/v1/throttle/"))).toBe(true);
    expect(JSON.stringify([...bucket.records])).not.toContain(security.password);
    vi.advanceTimersByTime(600_000);
    await login(setup({}, bucket));
  });

  it("caps IP churn with a shared global budget and never stores the connecting IP", async () => {
    const app = setup();
    for (let index = 0; index < 100; index++) {
      expect((await app.catalog.fetch(jsonRequest("/all-docs/session", "POST", { password: "wrong" }, { "CF-Connecting-IP": `192.0.2.${index}` }))).status).toBe(401);
    }
    const response = await app.catalog.fetch(jsonRequest("/all-docs/session", "POST", { password: security.password }, { "CF-Connecting-IP": "192.0.2.101" }));
    expect(response.status).toBe(429);
    expect(app.bucket.records.size).toBe(101);
    expect(JSON.stringify([...app.bucket.records])).not.toContain("192.0.2.");
  });

  it("fails closed after bounded CAS conflicts and R2 failure", async () => {
    for (const failure of ["conflicts", "fail"] as const) {
      const app = setup();
      app.bucket[failure] = true;
      const response = await app.catalog.fetch(jsonRequest("/all-docs/session", "POST", { password: security.password }));
      expect(response.status).toBe(failure === "conflicts" ? 429 : 503);
      expect(response.headers.get("Set-Cookie")).toBeNull();
      expect(await response.text()).not.toContain("private storage detail");
      privateHeaders(response);
    }
  });

  it("coordinates concurrent attempts without losing counter increments", async () => {
    const bucket = new AuthBucket();
    const responses = await Promise.all(Array.from({ length: 20 }, () => setup({}, bucket).catalog.fetch(jsonRequest("/all-docs/session", "POST", { password: "wrong" }))));
    expect(responses.every((response) => [401, 429].includes(response.status))).toBe(true);
    expect(responses.filter((response) => response.status === 401).length).toBeLessThanOrEqual(10);
    expect(responses.some((response) => response.status === 429)).toBe(true);
  });
});

function document(id = "Ab12Cd34", version = "v1"): ResolvedDocument {
  return {
    summary: { id, version, title: "Fixture <script>", filename: "fixture.txt", kind: "text", mime: "text/plain", sizeBytes: 4,
      uploadedAt: "2026-01-01T00:00:00Z", timeSource: "r2", createdAt: null, publicUrl: `https://docs.example/${id}`,
      rawUrl: `https://docs.example/${id}/raw`, downloadUrl: `https://docs.example/${id}/download`, objectCount: 1, warnings: [] },
    objects: [], openBody: vi.fn(),
  };
}
function batch(items = [{ id: "Ab12Cd34", version: "v1" }]) {
  return { version: 1, items, confirmCount: items.length, confirmation: `DELETE ${items.length} documents` };
}

describe("metadata discovery and reviewed removal", () => {
  it("signs session-owned cursor continuations, including empty pages, and rejects tampering/other sessions/expiry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-14T00:00:00Z"));
    const app = setup();
    const { cookie } = await login(app);
    app.page.mockResolvedValueOnce(libraryPage("private-storage-continuation"));
    const first = await app.catalog.fetch(jsonRequest("/all-docs/api/documents", "GET", undefined, { Cookie: cookie }));
    expect(first.status).toBe(200);
    const page = await first.json() as { items: unknown[]; nextCursor: string; scanComplete: boolean };
    expect(page.items).toEqual([]);
    expect(page.scanComplete).toBe(false);
    expect(page.nextCursor).not.toBe("private-storage-continuation");
    const path = "/all-docs/api/documents?cursor=" + encodeURIComponent(page.nextCursor);
    expect((await app.catalog.fetch(jsonRequest(path, "GET", undefined, { Cookie: cookie }))).status).toBe(200);
    expect(app.page).toHaveBeenLastCalledWith("private-storage-continuation");
    app.page.mockClear();
    const other = await login(app);
    for (const [target, credential] of [[path + "tampered", cookie], [path, other.cookie], ["/all-docs/api/documents?cursor=unsigned", cookie]]) {
      expect((await app.catalog.fetch(jsonRequest(target, "GET", undefined, { Cookie: credential }))).status).toBe(400);
    }
    vi.advanceTimersByTime(30 * 60 * 1000);
    expect((await app.catalog.fetch(jsonRequest(path, "GET", undefined, { Cookie: cookie }))).status).toBe(400);
    expect(app.page).not.toHaveBeenCalled();
  });

  it("rejects unexpected/repeated queries without document I/O", async () => {
    const app = setup();
    const { cookie } = await login(app);
    for (const path of ["/all-docs/api/documents?cursor=a&cursor=b", "/all-docs/api/documents?olderThan=90", "/all-docs/session?token=bad"]) {
      expect((await app.catalog.fetch(jsonRequest(path, "GET", undefined, { Cookie: cookie }))).status).toBe(400);
    }
    expect(app.page).not.toHaveBeenCalled();
    expect(app.resolve).not.toHaveBeenCalled();
  });

  it("retires extraction routes without any index or document reads, even with a signed session", async () => {
    const app = setup();
    const { cookie } = await login(app);
    for (const credential of [undefined, cookie]) {
      for (const suffix of ["", "?version=v1", "?version=v1&version=v2"]) {
        const response = await app.catalog.fetch(jsonRequest("/all-docs/api/documents/Ab12Cd34/text" + suffix, "GET", undefined, { Cookie: credential }));
        expect(response.status).toBe(404);
        privateHeaders(response);
      }
    }
    expect(app.library).not.toHaveBeenCalled();
    expect(app.resolve).not.toHaveBeenCalled();
  });

  it("deletes exactly the confirmed IDs/versions in order and retains partial failures", async () => {
    const app = setup();
    const { cookie, session } = await login(app);
    app.remove.mockResolvedValueOnce({ status: "deleted", deletedObjectCount: 1 })
      .mockResolvedValueOnce({ status: "changed", deletedObjectCount: 0 })
      .mockRejectedValueOnce(new Error("private storage failure"))
      .mockResolvedValueOnce({ status: "not-found", deletedObjectCount: 0 })
      .mockResolvedValueOnce({ status: "deleted", deletedObjectCount: 2 });
    const items = ["Ab12Cd34", "Changed1", "Failed12", "Missing1", "Last1234"].map((id) => ({ id, version: "reviewed" }));
    const response = await app.catalog.fetch(jsonRequest("/all-docs/api/delete", "POST", { ...batch(items), cutoffAt: "1900-01-01T00:00:00Z" }, { Cookie: cookie, "X-CSRF-Token": session.csrfToken }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ version: 1, outcomes: [
      { id: "Ab12Cd34", status: "deleted" }, { id: "Changed1", status: "changed" }, { id: "Failed12", status: "failed" },
      { id: "Missing1", status: "not-found" }, { id: "Last1234", status: "deleted" },
    ] });
    expect(app.remove.mock.calls).toEqual(items.map((item) => [item.id, item.version]));
    expect(app.page).not.toHaveBeenCalled();
    expect(app.resolve).not.toHaveBeenCalled();
    privateHeaders(response);
  });

  it("validates count, exact confirmation, IDs, versions, uniqueness and the 100-item cap before deleting anything", async () => {
    const app = setup();
    const { cookie, session } = await login(app);
    for (const input of [
      { ...batch(), version: 2 }, { ...batch(), confirmCount: 2 }, { ...batch(), confirmation: "DELETE 1 document" },
      { ...batch(), confirmation: " DELETE 1 documents" }, batch([]), batch([{ id: "invalid", version: "v1" }]),
      batch([{ id: "Ab12Cd34", version: "" }]), batch([{ id: "Ab12Cd34", version: "v1" }, { id: "Ab12Cd34", version: "v2" }]),
      batch(Array.from({ length: 101 }, (_, i) => ({ id: String(i).padStart(8, "0"), version: "v1" }))),
    ]) {
      const response = await app.catalog.fetch(jsonRequest("/all-docs/api/delete", "POST", input, { Cookie: cookie, "X-CSRF-Token": session.csrfToken }));
      expect(response.status).toBe(400);
      privateHeaders(response);
    }
    expect(app.remove).not.toHaveBeenCalled();
    const items = Array.from({ length: 100 }, (_, i) => ({ id: String(i).padStart(8, "0"), version: "v1" }));
    expect((await app.catalog.fetch(jsonRequest("/all-docs/api/delete", "POST", batch(items), { Cookie: cookie, "X-CSRF-Token": session.csrfToken }))).status).toBe(200);
    expect(app.remove).toHaveBeenCalledTimes(100);
  });

  it("checks delete Origin/CSRF before reading bodies and caps the mutation body", async () => {
    const app = setup();
    const { cookie, session } = await login(app);
    for (const override of [{ "X-CSRF-Token": "" }, { Origin: security.publicOrigin }, { "Sec-Fetch-Site": "same-site" }]) {
      const response = await app.catalog.fetch(jsonRequest("/all-docs/api/delete", "POST", batch(), { Cookie: cookie, "X-CSRF-Token": session.csrfToken, ...override }));
      expect(response.status).toBe(403);
      privateHeaders(response);
    }
    const response = await app.catalog.fetch(jsonRequest("/all-docs/api/delete", "POST", { ...batch(), extra: "x".repeat(33 * 1024) }, { Cookie: cookie, "X-CSRF-Token": session.csrfToken }));
    expect(response.status).toBe(413);
    expect(app.remove).not.toHaveBeenCalled();
  });
});

function libraryStatus(): LibraryStatus {
  return { counts: { documents: 0, pending: 0, indexed: 0, failed: 0, metadataOnly: 0, truncated: 0 }, lastReconciledAt: null, anomalies: 0,
    storage: { bytes: 0, budgetBytes: 400000000, planningBytes: null, projectedBytes: null, paused: false, reason: null } };
}
function libraryPage(nextCursor: string | null = null): LibraryPage {
  return { version: 1, generation: 1, items: [], nextCursor, scanComplete: nextCursor === null, observedAt: "2026-10-14T00:00:00Z", status: libraryStatus() };
}
function searchPage(nextCursor: string | null = null): LibrarySearchResponse {
  return { version: 1, generation: 1, hits: [], complete: nextCursor === null, nextCursor, scope: { documents: 0, pending: 0, failed: 0 }, status: libraryStatus() };
}
const searchRequest = () => ({ version: 1, query: { text: "needle", mode: "literal", ignoreCase: true }, filter: { kinds: [], uploadedBefore: null, uploadedAfter: null } });
const snippetRequest = () => ({ version: 1, generation: 1, query: searchRequest().query, refs: [{ id: "Ab12Cd34", version: "v1" }] });
const maintainRequest = () => ({ version: 1, options: { documents: 100, textBytes: 99999999, listPages: 100, deadlineMs: 99999 } });
const newPosts = [
  ["/all-docs/api/search", searchRequest], ["/all-docs/api/snippets", snippetRequest],
  ["/all-docs/api/index/maintain", maintainRequest], ["/all-docs/api/index/retry", () => ({ version: 1, refs: snippetRequest().refs })],
] as const;

describe("persistent library HTTP admission", () => {
  it("authenticates every new POST before body consumption or index construction", async () => {
    const app = setup();
    const { cookie, session } = await login(app);
    for (const [path, body] of newPosts) {
      for (const [headers, status] of [
        [{}, 401], [{ Cookie: cookie }, 403],
        [{ Cookie: cookie, "X-CSRF-Token": session.csrfToken, Origin: security.publicOrigin }, 403],
        [{ Cookie: cookie, "X-CSRF-Token": session.csrfToken, "Sec-Fetch-Site": "same-site" }, 403],
        [{ Cookie: cookie, "X-CSRF-Token": session.csrfToken, "X-Docs-Catalog": "" }, 403],
      ] as const) {
        const input = jsonRequest(path, "POST", body(), headers);
        const response = await app.catalog.fetch(input);
        expect(response.status).toBe(status);
        expect(input.bodyUsed).toBe(false);
        privateHeaders(response);
      }
    }
    expect(app.library).not.toHaveBeenCalled();
  });

  it("maps safe typed failures and redacts SQL/storage failures without hiding validation errors", async () => {
    const app = setup();
    const { cookie, session } = await login(app);
    const headers = { Cookie: cookie, "X-CSRF-Token": session.csrfToken };
    for (const [code, status, retryable] of [
      ["invalid_library_request", 400, false], ["invalid_search_request", 400, false], ["invalid_pattern", 400, false],
      ["invalid_cursor", 400, false], ["stale_generation", 409, true], ["search_budget_exceeded", 422, false], ["library_unavailable", 503, true],
    ] as const) {
      app.search.mockRejectedValueOnce(new LibraryIndexError(code, "SELECT private storage key", !retryable));
      const response = await app.catalog.fetch(jsonRequest("/all-docs/api/search", "POST", searchRequest(), headers));
      expect(response.status).toBe(status);
      const payload = await response.json();
      expect(payload).toMatchObject({ error: { code, retryable } });
      expect(JSON.stringify(payload)).not.toMatch(/SELECT|private storage key/);
      privateHeaders(response);
    }
    app.search.mockRejectedValueOnce(new Error("D1_ERROR SELECT private storage key"));
    const response = await app.catalog.fetch(jsonRequest("/all-docs/api/search", "POST", searchRequest(), headers));
    expect(response.status).toBe(503);
    expect(await response.text()).not.toMatch(/SELECT|private storage key/);
    const invalid = await app.catalog.fetch(jsonRequest("/all-docs/api/search", "POST", { version: 2 }, headers));
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ error: { retryable: false } });
  });
});

describe("bounded library requests and operation-owned cursors", () => {
  it("admits only the frozen request grammar before calling LibraryIndex", async () => {
    const app = setup();
    const { cookie, session } = await login(app);
    const headers = { Cookie: cookie, "X-CSRF-Token": session.csrfToken };
    const badSearch = [
      { ...searchRequest(), version: 2 }, { ...searchRequest(), unexpected: true },
      { ...searchRequest(), query: { ...searchRequest().query, text: "😀".repeat(65) } },
      { ...searchRequest(), query: { ...searchRequest().query, mode: "sql" } },
      { ...searchRequest(), query: { text: "needle", mode: "literal" } },
      { ...searchRequest(), filter: { ...searchRequest().filter, kinds: ["unknown"] } },
      { ...searchRequest(), filter: { ...searchRequest().filter, kinds: ["text", "text"] } },
      { ...searchRequest(), filter: { ...searchRequest().filter, uploadedBefore: "bad date" } },
      { ...searchRequest(), cursor: "raw-forged-internal-cursor" },
    ];
    for (const body of badSearch) {
      const response = await app.catalog.fetch(jsonRequest("/all-docs/api/search", "POST", body, headers));
      expect(response.status).toBe(400);
      privateHeaders(response);
    }
    for (const [path, body] of [
      ["/all-docs/api/snippets", { ...snippetRequest(), generation: -1 }],
      ["/all-docs/api/snippets", { ...snippetRequest(), generation: 1.5 }],
      ["/all-docs/api/snippets", { ...snippetRequest(), refs: [{ id: "bad", version: "v1" }] }],
      ["/all-docs/api/snippets", { ...snippetRequest(), refs: [{ id: "Ab12Cd34", version: "" }] }],
      ["/all-docs/api/snippets", { ...snippetRequest(), refs: [snippetRequest().refs[0], { id: "Ab12Cd34", version: "v2" }] }],
      ["/all-docs/api/snippets", { ...snippetRequest(), refs: Array.from({ length: 49 }, (_, i) => ({ id: String(i).padStart(8, "0"), version: "v1" })) }],
      ["/all-docs/api/index/retry", { version: 2, refs: [] }],
      ["/all-docs/api/index/maintain", { ...maintainRequest(), options: { ...maintainRequest().options, documents: -1 } }],
      ["/all-docs/api/index/maintain", { ...maintainRequest(), options: { ...maintainRequest().options, deadlineMs: 0.5 } }],
      ["/all-docs/api/index/maintain", { ...maintainRequest(), options: { ...maintainRequest().options, reconcile: "yes" } }],
      ["/all-docs/api/index/maintain", { ...maintainRequest(), options: { ...maintainRequest().options, raiseBudget: 999 } }],
    ] as const) {
      expect((await app.catalog.fetch(jsonRequest(path, "POST", body, headers))).status).toBe(400);
    }
    expect(app.library).not.toHaveBeenCalled();
    const exactLimit = { ...searchRequest(), query: { ...searchRequest().query, text: "😀".repeat(64) } };
    expect((await app.catalog.fetch(jsonRequest("/all-docs/api/search", "POST", exactLimit, headers))).status).toBe(200);
    expect(app.search).toHaveBeenCalledWith(exactLimit);
  });

  it("rejects duplicate/prototype JSON fields, URL query text and oversized streams before index I/O", async () => {
    const app = setup();
    const { cookie, session } = await login(app);
    const headers = new Headers(jsonRequest("/all-docs/api/search", "POST", undefined, { Cookie: cookie, "X-CSRF-Token": session.csrfToken }).headers);
    for (const body of [
      '{"version":1,"version":1}', '{"version":1,"__proto__":{}}', '{"version":1,"query":{"constructor":{}}}',
      '{"version":1,"ver\\u0073ion":1}', '{"version":1,"options":{"documents":1,"documents":2}}',
    ]) {
      const response = await app.catalog.fetch(req("/all-docs/api/search", { method: "POST", body, headers }));
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: "invalid_json", retryable: false } });
    }
    for (const [path, body] of newPosts) {
      expect((await app.catalog.fetch(jsonRequest(path + "?query=private", "POST", body(), Object.fromEntries(headers)))).status).toBe(400);
      expect((await app.catalog.fetch(jsonRequest(path, "POST", body(), { ...Object.fromEntries(headers), "Content-Type": "text/plain" }))).status).toBe(415);
    }
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(80 * 1024)); }, cancel() { cancelled = true; } });
    expect((await app.catalog.fetch(streamed(stream, "/all-docs/api/search", headers))).status).toBe(413);
    expect(cancelled).toBe(true);
    expect(app.library).not.toHaveBeenCalled();
  });

  it("passes snippets unchanged and caps maintain/retry to the same configured work allowance", async () => {
    const app = setup();
    const { cookie, session } = await login(app);
    const headers = { Cookie: cookie, "X-CSRF-Token": session.csrfToken };
    const snippets = { version: 1 as const, generation: 1, hits: [], unavailable: [], remaining: snippetRequest().refs };
    app.snippets.mockResolvedValueOnce(snippets);
    const response = await app.catalog.fetch(jsonRequest("/all-docs/api/snippets", "POST", snippetRequest(), headers));
    expect(await response.json()).toEqual(snippets);
    expect(app.snippets).toHaveBeenCalledWith(snippetRequest());
    expect((await app.catalog.fetch(jsonRequest("/all-docs/api/index/maintain", "POST", maintainRequest(), headers))).status).toBe(200);
    expect(app.maintain).toHaveBeenLastCalledWith({ documents: 12, textBytes: 33554432, listPages: 1, deadlineMs: 20000 });
    expect((await app.catalog.fetch(jsonRequest("/all-docs/api/index/retry", "POST", { version: 1, refs: snippetRequest().refs }, headers))).status).toBe(200);
    expect(app.maintain).toHaveBeenLastCalledWith({ documents: 12, textBytes: 33554432, listPages: 1, deadlineMs: 20000, retry: snippetRequest().refs });
  });

  it("round-trips worst-size opaque cursors, separates operations and refuses session replay/expiry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-16T00:00:00Z"));
    const app = setup();
    const { cookie, session } = await login(app);
    const headers = { Cookie: cookie, "X-CSRF-Token": session.csrfToken };
    const raw = "\u0000".repeat(8192);
    app.page.mockResolvedValueOnce(libraryPage(raw));
    const first = await app.catalog.fetch(jsonRequest("/all-docs/api/documents", "GET", undefined, headers));
    expect(first.status).toBe(200);
    const metadata = await first.json() as LibraryPage;
    const path = "/all-docs/api/documents?cursor=" + encodeURIComponent(metadata.nextCursor!);
    expect((await app.catalog.fetch(jsonRequest(path, "GET", undefined, headers))).status).toBe(200);
    expect(app.page).toHaveBeenLastCalledWith(raw);
    app.search.mockResolvedValueOnce(searchPage(raw));
    const search = await app.catalog.fetch(jsonRequest("/all-docs/api/search", "POST", searchRequest(), headers));
    const result = await search.json() as LibrarySearchResponse;
    expect(result.nextCursor).not.toBe(metadata.nextCursor);
    expect((await app.catalog.fetch(jsonRequest("/all-docs/api/search", "POST", { ...searchRequest(), cursor: result.nextCursor }, headers))).status).toBe(200);
    expect(app.search).toHaveBeenLastCalledWith({ ...searchRequest(), cursor: raw });
    app.page.mockClear(); app.search.mockClear();
    expect((await app.catalog.fetch(jsonRequest("/all-docs/api/search", "POST", { ...searchRequest(), cursor: metadata.nextCursor }, headers))).status).toBe(400);
    expect((await app.catalog.fetch(jsonRequest("/all-docs/api/documents?cursor=" + result.nextCursor, "GET", undefined, headers))).status).toBe(400);
    const other = await login(app);
    expect((await app.catalog.fetch(jsonRequest("/all-docs/api/search", "POST", { ...searchRequest(), cursor: result.nextCursor }, { Cookie: other.cookie, "X-CSRF-Token": other.session.csrfToken }))).status).toBe(400);
    vi.advanceTimersByTime(1800000);
    expect((await app.catalog.fetch(jsonRequest("/all-docs/api/search", "POST", { ...searchRequest(), cursor: result.nextCursor }, headers))).status).toBe(400);
    expect(app.page).not.toHaveBeenCalled(); expect(app.search).not.toHaveBeenCalled();
  });
});
