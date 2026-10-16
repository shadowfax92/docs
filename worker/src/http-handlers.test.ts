import { describe, expect, it, vi } from "vitest";
import { Miniflare } from "miniflare";
// @ts-expect-error Node-only proof consumes the exact production bundle emitted before npm test.
import { readFile } from "node:fs/promises";
import worker, { createWorker } from "./index";
import type { CatalogEnv, PublicEnv, SessionResponse } from "./contracts";
import type { LibraryPage, LibrarySearchResponse, LibrarySnippetsResponse, MaintenanceReport } from "./library-contracts";
import { createLibraryFixture } from "./library-index.test-support";
import type { LibraryDependencies, LibraryIndex } from "./library-index";

const publicOrigin = "https://docs.example";
const catalogOrigin = "https://library.example";
const password = "native disposable fixture password";
const sessionKey = "native-disposable-fixture-signing-key-32-bytes";
const query = { text: "needle", mode: "literal", ignoreCase: true };
const filter = { kinds: [], uploadedBefore: null, uploadedAfter: null };
function request(path: string, body?: unknown, headers: Record<string, string> = {}) {
  return new Request(catalogOrigin + path, { method: body === undefined ? "GET" : "POST",
    headers: { Origin: catalogOrigin, "Sec-Fetch-Site": "same-origin", "X-Docs-Catalog": "1", "Content-Type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
function privateResponse(response: Response) {
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(response.headers.get("X-Robots-Tag")).toContain("noindex");
  expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
}

/** Two roles run the exact production bundle against the same disposable native D1/R2. These
 * checks exercise composition, auth, extraction and decorated writes together, without fake SQL.
 * Deployments, credentials and integration-owner scripts are never read or changed.
 */
async function nativeHttp(migrate = true) {
  const script = await readFile(new URL("../.wrangler/build/index.js", (import.meta as { url: string }).url), "utf8");
  const common = { modules: true, script, compatibilityDate: "2024-12-01", r2Buckets: { DOCS_BUCKET: "http-docs" },
    d1Databases: { LIBRARY_DB: "http-library" } } as const;
  const origins = { PUBLIC_DOCS_ORIGIN: publicOrigin, CATALOG_ORIGIN: catalogOrigin, LIBRARY_SIZE_BUDGET_BYTES: "400000000" };
  const runtime = new Miniflare({ host: "127.0.0.1", port: 0, cf: false,
    workers: [
      { ...common, name: "public", bindings: { ...origins, APP_ROLE: "public", AUTH_TOKEN: "fixture-bearer" } },
      { ...common, name: "catalog", bindings: { ...origins, APP_ROLE: "catalog", ALL_DOCS_PASSWORD: password, CATALOG_SESSION_KEY: sessionKey } },
    ],
  });
  try {
    const db = await runtime.getD1Database("LIBRARY_DB", "catalog");
    const bucket = await runtime.getR2Bucket("DOCS_BUCKET", "public");
    if (migrate) {
      const sql: string = await readFile(new URL("../migrations/0001_library_index.sql", (import.meta as { url: string }).url), "utf8");
      await db.batch(sql.replace(/^\s*--.*$/gm, "").split(";").map((part) => part.trim()).filter(Boolean).map((sql) => db.prepare(sql)));
    }
    const handle = await runtime.getWorker("catalog");
    // Miniflare3 uses its own undici Request class. Cross the host/runtime seam with URL/bytes,
    // preserving known body length, rather than passing Node's incompatible Request instance.
    const init = async (input: Request) => ({ method: input.method, headers: Object.fromEntries(input.headers),
      ...(input.body === null ? {} : { body: new Uint8Array(await input.arrayBuffer()) }) });
    const catalog = { fetch: async (input: Request) => handle.fetch(input.url, await init(input)) as unknown as Promise<Response> };
    const fetchPublic = async (input: Request) => runtime.dispatchFetch(input.url, await init(input)) as unknown as Promise<Response>;
    const login = async () => {
      const response = await catalog.fetch(request("/all-docs/session", { password }));
      expect(response.status).toBe(200);
      const session = await response.json() as SessionResponse;
      return { Cookie: response.headers.get("Set-Cookie")!.split(";")[0], "X-CSRF-Token": session.csrfToken };
    };
    const upload = async (body: string, filename = "fixture.html") => {
      const response = await fetchPublic(new Request(publicOrigin + "/upload", { method: "PUT", body,
        headers: { Authorization: "Bearer fixture-bearer", "X-Filename": filename, "X-Doc-Name": "Needle title", "Content-Type": filename.endsWith("html") ? "text/html" : "text/plain" } }));
      expect(response.status).toBe(200);
      return await response.json() as { id: string; url: string };
    };
    return { runtime, db, bucket, catalog, fetchPublic, login, upload, dispose: () => runtime.dispose() };
  } catch (error) { await runtime.dispose(); throw error; }
}

describe("compiled native HTTP roles", () => {
  it("keeps public reads/login/uploads available without D1 schema and refuses deletes before R2 removal", async () => {
    const fixture = await nativeHttp(false);
    try {
      await fixture.bucket.put("Legacy01/fixture.txt", "original bytes", { customMetadata: { filename: "fixture.txt", contentType: "text/plain" } });
      const raw = await fixture.fetchPublic(new Request(publicOrigin + "/Legacy01/raw"));
      expect(raw.status).toBe(200); expect(await raw.text()).toBe("original bytes");
      const credentials = await fixture.login();
      const unauthenticated = await fixture.catalog.fetch(request("/all-docs/api/documents"));
      expect(unauthenticated.status).toBe(401);
      const page = await fixture.catalog.fetch(request("/all-docs/api/documents", undefined, credentials));
      expect(page.status).toBe(503); privateResponse(page);
      expect(await page.text()).not.toMatch(/SELECT|no such table|D1_ERROR|__docs_internal/);
      const uploaded = await fixture.upload("upload survives derived-index failure", "note.txt");
      expect(await (await fixture.fetchPublic(new Request(uploaded.url + "/raw"))).text()).toBe("upload survives derived-index failure");
      const deletion = await fixture.fetchPublic(new Request(publicOrigin + "/upload/Legacy01", { method: "DELETE", headers: { Authorization: "Bearer fixture-bearer" } }));
      expect(deletion.status).toBe(500); expect(deletion.headers.get("X-Docs-Delete-Result")).toBeNull();
      expect(await (await fixture.bucket.get("Legacy01/fixture.txt"))?.text()).toBe("original bytes");
      for (const [path, method] of [["/all-docs/api/documents", "GET"], ["/all-docs/api/search", "POST"], ["/all-docs/api/snippets", "POST"], ["/all-docs/api/index/maintain", "POST"]]) {
        expect((await fixture.fetchPublic(new Request(publicOrigin + path, { method }))).status).toBe(404);
      }
    } finally { await fixture.dispose(); }
  }, 30_000);

  it("indexes upload metadata/text, preserves original representations and decorates both removal paths", async () => {
    const fixture = await nativeHttp();
    try {
      const credentials = await fixture.login();
      const body = '<!doctype html><html><body><p>Body needle twice needle.</p><script>private script</script></body></html>';
      const uploaded = await fixture.upload(body);
      const page = await fixture.catalog.fetch(request("/all-docs/api/documents", undefined, credentials));
      expect(page.status).toBe(200); privateResponse(page);
      const metadata = await page.json() as LibraryPage;
      expect(metadata.items).toEqual([expect.objectContaining({ id: uploaded.id, title: "Needle title" })]);
      for (const suffix of ["/raw", "/download"]) {
        const response = await fixture.fetchPublic(new Request(uploaded.url + suffix));
        expect(response.status).toBe(200); expect(await response.text()).toBe(body);
      }
      const preview = await fixture.fetchPublic(new Request(uploaded.url));
      expect(preview.status).toBe(200); expect(await preview.text()).toContain('data-vh="runtime"');
      // Poll an observable persisted result; no fixed sleep is treated as extraction completion.
      await vi.waitFor(async () => {
        const result = await fixture.catalog.fetch(request("/all-docs/api/search", { version: 1, query, filter }, credentials));
        expect(result.status).toBe(200);
        const search = await result.json() as LibrarySearchResponse;
        expect(search.hits).toContainEqual(expect.objectContaining({ id: uploaded.id, matchCount: 3 }));
      }, { timeout: 10000, interval: 25 });
      const current = await (await fixture.catalog.fetch(request("/all-docs/api/documents", undefined, credentials))).json() as LibraryPage;
      const ref = { id: uploaded.id, version: current.items[0].version };
      const snippets = await fixture.catalog.fetch(request("/all-docs/api/snippets", { version: 1, generation: current.generation, query, refs: [ref] }, credentials));
      expect(snippets.status).toBe(200);
      const snippet = await snippets.json() as LibrarySnippetsResponse;
      expect(snippet.hits).toContainEqual(expect.objectContaining({ ...ref, matchCount: 3 }));
      expect(snippet.hits[0].snippet).not.toContain("private script");
      expect(snippet.remaining).toEqual([]);
      const deleted = await fixture.catalog.fetch(request("/all-docs/api/delete", { version: 1, items: [ref], confirmCount: 1, confirmation: "DELETE 1 documents" }, credentials));
      expect(deleted.status).toBe(200); expect(await deleted.json()).toEqual({ version: 1, outcomes: [{ id: uploaded.id, status: "deleted" }] });
      expect((await fixture.fetchPublic(new Request(uploaded.url + "/raw"))).status).toBe(404);
      const second = await fixture.upload("another needle", "second.txt");
      const bearerDelete = () => fixture.fetchPublic(new Request(publicOrigin + "/upload/" + second.id, { method: "DELETE", headers: { Authorization: "Bearer fixture-bearer" } }));
      const removed = await bearerDelete();
      expect(removed.status).toBe(204); expect(removed.headers.get("X-Docs-Delete-Result")).toBe("deleted");
      const missing = await bearerDelete();
      expect(missing.status).toBe(404); expect(missing.headers.get("X-Docs-Delete-Result")).toBe("not-found");
      await vi.waitFor(async () => {
        const result = await (await fixture.catalog.fetch(request("/all-docs/api/search", { version: 1, query, filter }, credentials))).json() as LibrarySearchResponse;
        expect(result.hits).toEqual([]);
      }, { timeout: 10000, interval: 25 });
      expect((await fixture.catalog.fetch(request("/all-docs/api/documents/" + uploaded.id + "/text?version=" + ref.version, undefined, credentials))).status).toBe(404);
      expect((await fixture.catalog.fetch(request("/all-docs/assets/search-worker.js"))).status).toBe(404);
    } finally { await fixture.dispose(); }
  }, 30_000);

  it("uses the same native maintenance lease for bounded backfill and exact retry", async () => {
    const fixture = await nativeHttp();
    try {
      const credentials = await fixture.login();
      await fixture.db.prepare("INSERT INTO index_meta(key,value,token,expires_at) VALUES ('maintenance-lease','',?,?)").bind("another-runner", Date.now() + 60000).run();
      for (const [path, payload] of [
        ["/all-docs/api/index/maintain", { version: 1, options: { documents: 0, textBytes: 0, listPages: 0, deadlineMs: 0 } }],
        ["/all-docs/api/index/retry", { version: 1, refs: [{ id: "Absent01", version: "reviewed" }] }],
      ] as const) {
        const response = await fixture.catalog.fetch(request(path, payload, credentials));
        expect(response.status).toBe(200); privateResponse(response);
        expect(await response.json()).toMatchObject({ version: 1, outcome: "busy" } satisfies Partial<MaintenanceReport>);
      }
      expect(await fixture.db.prepare("SELECT token FROM index_meta WHERE key='maintenance-lease'").first("token")).toBe("another-runner");
    } finally { await fixture.dispose(); }
  }, 30_000);
});

it("gives only catalog cron a fresh bounded invocation and retains its deferred lifetime", async () => {
  const fixture = await createLibraryFixture();
  try {
    const seen: LibraryDependencies[] = [];
    const maintain = vi.fn<LibraryIndex["maintain"]>().mockResolvedValue({ version: 1 } as MaintenanceReport);
    const handler = createWorker((deps) => { seen.push(deps); return { ...fixture.library, maintain }; });
    const common = { DOCS_BUCKET: fixture.bucket, LIBRARY_DB: fixture.db, PUBLIC_DOCS_ORIGIN: publicOrigin, CATALOG_ORIGIN: catalogOrigin };
    const publicEnv: PublicEnv = { ...common, APP_ROLE: "public", AUTH_TOKEN: "fixture-bearer" };
    const catalogEnv: CatalogEnv = { ...common, APP_ROLE: "catalog", ALL_DOCS_PASSWORD: password, CATALOG_SESSION_KEY: sessionKey };
    const deferred: Promise<unknown>[] = [];
    const context = { waitUntil(work: Promise<unknown>) { deferred.push(work); } };
    const controller = { scheduledTime: Date.now(), cron: "*/5 * * * *", noRetry() {} };
    handler.scheduled(controller, publicEnv, context);
    expect(seen).toHaveLength(0); expect(deferred).toHaveLength(0);
    handler.scheduled(controller, catalogEnv, context);
    handler.scheduled(controller, catalogEnv, context);
    await Promise.all(deferred);
    expect(maintain).toHaveBeenCalledWith({ documents: 12, textBytes: 33554432, listPages: 1, deadlineMs: 20000 });
    expect(seen).toHaveLength(2); expect(seen[0].budget).toMatchObject({ used: 0, remaining: 40 });
    expect(seen[0].budget).not.toBe(seen[1].budget);
    const forbidden = { ...publicEnv, get LIBRARY_DB(): D1Database { throw new Error("public reads cannot resolve D1"); } };
    for (const path of ["/", "/Missing1", "/Missing1/raw", "/all-docs"]) {
      const response = await worker.fetch(new Request(publicOrigin + path), forbidden, context);
      expect([200, 302, 404]).toContain(response.status);
    }
  } finally { await fixture.dispose(); }
}, 20_000);
