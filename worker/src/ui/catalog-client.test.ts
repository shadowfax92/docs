import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeleteBatchRequest, DeleteProgress, DocumentSummary } from "../contracts";
import type {
  LibraryDocument, LibraryHit, LibraryMetadata, LibrarySearchRequest, LibrarySnippetsRequest, LibraryStatus, SelectionRef,
} from "../library-contracts";
import { compileSearchMatcher, SearchError } from "../search";
import {
  CatalogClient, MAX_SNAPSHOT_RESTARTS, ageWindow, describeWindow, filtersFromParams, filtersToParams, formatBytes,
  formatRelative,
} from "./catalog-client";
import { MAX_STALE_RESTARTS, REQUEST_TIMEOUT_MS, SEARCH_DEBOUNCE_MS } from "./persistent-search";

// The catalog's HTTP routes are the client's only seam. FakeCatalog speaks the frozen library
// protocol (metadata pages, search slices, snippets, retry, delete) over an in-memory corpus and
// answers queries with the production RE2 matcher, so counts and snippet ranges are real. Tests
// drive the client only through the interface app.ts uses. Timers are faked (debounce, request
// timeout); replies settle on real macrotasks, so `flush`/`until` step with setImmediate.

const NOW = Date.UTC(2026, 9, 15, 4, 16); // Oct 14, 2026, 9:16 PM PDT
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function summary(n: number, patch: Partial<DocumentSummary> = {}): DocumentSummary {
  const id = `doc${String(n).padStart(5, "0")}`;
  return {
    id, version: `v1-${id}`, title: `Document ${n}`, filename: `document-${n}.md`, kind: "markdown",
    mime: "text/markdown", sizeBytes: 1_000 + n, uploadedAt: new Date(NOW - n * HOUR).toISOString(), timeSource: "r2",
    createdAt: null, publicUrl: `https://docs.example/${id}`, rawUrl: `https://docs.example/${id}/raw`,
    downloadUrl: `https://docs.example/${id}/download`, objectCount: 1, warnings: [], ...patch,
  };
}

function doc(n: number, patch: Partial<DocumentSummary> = {}, index: Partial<LibraryMetadata> = {}): LibraryDocument {
  return {
    ...summary(n, patch),
    index: { state: "indexed", coverage: "full", reason: null, indexedBytes: 100, extractorVersion: 1, ...index },
  };
}

function range(count: number, start = 1): LibraryDocument[] {
  return Array.from({ length: count }, (_, index) => doc(start + index));
}

function libraryStatus(patch: Partial<LibraryStatus> = {}): LibraryStatus {
  return {
    counts: { documents: 0, pending: 0, indexed: 0, failed: 0, metadataOnly: 0, truncated: 0 },
    lastReconciledAt: null, anomalies: 0,
    storage: { bytes: 0, budgetBytes: 400_000_000, planningBytes: null, projectedBytes: null, paused: false, reason: null },
    ...patch,
  };
}

function error(status: number, retryAfter: string | null = null): Response {
  return Response.json(
    { version: 1, error: { code: `http_${status}`, message: `Failure ${status}`, retryable: false } },
    { status, headers: retryAfter ? { "Retry-After": retryAfter } : {} },
  );
}

function libraryError(status: number, code: string, message = `Library ${code}`, retryable = false): Response {
  return Response.json({ version: 1, error: { code, message, retryable } }, { status });
}

interface Recorded { method: string; path: string; headers: Record<string, string>; body: unknown; init: RequestInit }

class FakeCatalog {
  pages: LibraryDocument[][] = [[]];
  /** Extracted text per ID; only `indexed` rows expose it, like the real index. */
  bodies = new Map<string, string>();
  generation = 7;
  status = libraryStatus();
  recorded: Recorded[] = [];
  sessionStatus = 200;
  loginStatus = 200;
  retryAfter: string | null = null;
  /** Regex searches answer this many documents per slice (a progressive scan); literals at once. */
  regexSlice = Number.POSITIVE_INFINITY;
  /** Snippet calls process at most this many refs; the rest come back as `remaining`. */
  snippetBudget = 48;
  /** Processed refs reported as unavailable (hidden, changed or no longer matching on the server). */
  unavailable = new Set<string>();
  /** Hits appended to the first search slice, e.g. IDs or versions the snapshot doesn't know. */
  extraHits: LibraryHit[] = [];
  /** More matches than this fail the search with search_budget_exceeded, like the 10,000-hit cap. */
  hitCap = Number.POSITIVE_INFINITY;
  /** Search-plane replies wait for release() while true; aborts reject unless ignoreAbort. */
  hold = false;
  ignoreAbort = false;
  held: { path: string; release: () => void }[] = [];
  inFlight = 0;
  maxInFlight = 0;
  pageHook: ((index: number) => void | Promise<void>) | null = null;
  searchReply: ((body: LibrarySearchRequest, call: number) => Response | null) | null = null;
  snippetReply: ((body: LibrarySnippetsRequest) => Response | null) | null = null;
  retryReply: (() => Response) | null = null;
  deleteReply: (request: DeleteBatchRequest, call: number) => Response | Promise<Response> = (request) =>
    Response.json({ version: 1, outcomes: request.items.map((item) => ({ id: item.id, status: "deleted" })) } satisfies DeleteProgress);
  private deleteCalls = 0;
  private searchCalls = 0;

  readonly fetch = async (input: string, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(input, "https://docs-library.test");
    const method = init.method ?? "GET";
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((value, name) => { headers[name] = value; });
    const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    this.recorded.push({ method, path: url.pathname + url.search, headers, body, init });
    const session = () => Response.json({ version: 1, csrfToken: "csrf-token-1", expiresAt: new Date(NOW + 12 * HOUR).toISOString() });
    if (url.pathname === "/all-docs/session") {
      if (method === "GET") return this.sessionStatus === 200 ? session() : error(this.sessionStatus);
      if (method === "POST") {
        if (this.loginStatus !== 200) return error(this.loginStatus, this.retryAfter);
        return (body as { password: string }).password === "correct horse" ? session() : error(401);
      }
      if (method === "DELETE") return new Response(null, { status: 204 });
    }
    if (url.pathname === "/all-docs/api/documents" && method === "GET") return this.page(url.searchParams.get("cursor"));
    if ((url.pathname === "/all-docs/api/search" || url.pathname === "/all-docs/api/snippets") && method === "POST") {
      this.inFlight++;
      this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
      try {
        await this.gate(url.pathname, init);
        return url.pathname.endsWith("search")
          ? this.searchReply?.(body, ++this.searchCalls) ?? this.search(body)
          : this.snippetReply?.(body) ?? this.snippets(body);
      } finally {
        this.inFlight--;
      }
    }
    if (url.pathname === "/all-docs/api/index/retry" && method === "POST") {
      return this.retryReply?.() ?? Response.json({
        version: 1, outcome: "complete", generation: this.generation + 1, processed: 1, indexed: 1, failed: 0, repaired: 0,
        reconciledPages: 0, textBytes: 10, status: this.status,
      });
    }
    if (url.pathname === "/all-docs/api/delete" && method === "POST") {
      return this.deleteReply(body as DeleteBatchRequest, ++this.deleteCalls);
    }
    return error(404);
  };

  requests(method: string, prefix: string): Recorded[] {
    return this.recorded.filter((request) => request.method === method && request.path.startsWith(prefix));
  }

  searches(): (Recorded & { body: LibrarySearchRequest })[] {
    return this.requests("POST", "/all-docs/api/search") as (Recorded & { body: LibrarySearchRequest })[];
  }

  snippetCalls(): (Recorded & { body: LibrarySnippetsRequest })[] {
    return this.requests("POST", "/all-docs/api/snippets") as (Recorded & { body: LibrarySnippetsRequest })[];
  }

  release(): void {
    const next = this.held.shift();
    if (!next) throw new Error("No held request to release");
    next.release();
  }

  private docs(): LibraryDocument[] {
    return this.pages.flat();
  }

  private fields(document: LibraryDocument) {
    const body = document.index.state === "indexed" ? this.bodies.get(document.id) ?? "" : "";
    return { filename: document.filename, title: document.title, body };
  }

  private gate(path: string, init: RequestInit): Promise<void> {
    if (!this.hold) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const entry = { path, release: resolve };
      this.held.push(entry);
      init.signal?.addEventListener("abort", () => {
        if (this.ignoreAbort) return;
        this.held = this.held.filter((other) => other !== entry);
        reject(new DOMException("The operation was aborted.", "AbortError"));
      }, { once: true });
    });
  }

  private async page(cursor: string | null): Promise<Response> {
    let index = 0;
    if (cursor !== null) {
      const parsed = /^g(\d+)p(\d+)$/.exec(cursor);
      if (!parsed) return libraryError(400, "invalid_cursor");
      index = Number(parsed[2]);
      await this.pageHook?.(index);
      // A continuation is bound to its first page's generation.
      if (Number(parsed[1]) !== this.generation) return libraryError(409, "stale_generation", "The library changed.", true);
    } else {
      await this.pageHook?.(0);
    }
    const last = index >= this.pages.length - 1;
    const nextCursor = last ? null : `g${this.generation}p${index + 1}`;
    return Response.json({
      version: 1, generation: this.generation, items: this.pages[index] ?? [], nextCursor, scanComplete: last,
      observedAt: new Date(NOW).toISOString(), status: this.status,
    });
  }

  private search(body: LibrarySearchRequest): Response {
    let start = 0;
    if (body.cursor !== undefined) {
      const parsed = /^g(\d+)s(\d+)$/.exec(body.cursor);
      if (!parsed) return libraryError(400, "invalid_cursor");
      if (Number(parsed[1]) !== this.generation) return libraryError(409, "stale_generation", "The library changed.", true);
      start = Number(parsed[2]);
    }
    const { kinds, uploadedAfter, uploadedBefore } = body.filter;
    const docs = this.docs().filter((document) => (!kinds.length || kinds.includes(document.kind))
      && (uploadedAfter === null || Date.parse(document.uploadedAt) >= Date.parse(uploadedAfter))
      && (uploadedBefore === null || Date.parse(document.uploadedAt) < Date.parse(uploadedBefore)));
    const end = Math.min(docs.length, start + (body.query.mode === "regex" ? this.regexSlice : docs.length));
    let hits: LibraryHit[];
    try {
      const matcher = compileSearchMatcher(body.query);
      try {
        hits = docs.slice(start, end).flatMap((document) => {
          const match = matcher.match(this.fields(document));
          return match ? [{ id: document.id, version: document.version, matchCount: match.matchCount }] : [];
        });
      } finally {
        matcher.dispose();
      }
    } catch (failure) {
      if (failure instanceof SearchError) return libraryError(failure.code === "search_budget_exceeded" ? 422 : 400, failure.code, failure.message);
      throw failure;
    }
    if (start === 0) hits.push(...this.extraHits);
    if (hits.length > this.hitCap) return libraryError(422, "search_budget_exceeded", "Search exceeds 10,000 hits. Narrow the filters.");
    const complete = end >= docs.length;
    return Response.json({
      version: 1, generation: this.generation, hits, complete, nextCursor: complete ? null : `g${this.generation}s${end}`,
      scope: { documents: docs.length, pending: 0, failed: 0 }, status: this.status,
    });
  }

  private snippets(body: LibrarySnippetsRequest): Response {
    if (body.generation !== this.generation) return libraryError(409, "stale_generation", "The library changed.", true);
    const processed = body.refs.slice(0, this.snippetBudget);
    const hits: unknown[] = [];
    const unavailable: SelectionRef[] = [];
    const matcher = compileSearchMatcher(body.query);
    try {
      for (const ref of processed) {
        const document = this.docs().find((candidate) => candidate.id === ref.id);
        const match = document && document.version === ref.version && !this.unavailable.has(ref.id)
          ? matcher.match(this.fields(document)) : null;
        if (match) hits.push({ id: ref.id, version: ref.version, ...match });
        else unavailable.push(ref);
      }
    } finally {
      matcher.dispose();
    }
    return Response.json({ version: 1, generation: this.generation, hits, remaining: body.refs.slice(this.snippetBudget), unavailable });
  }
}

function setup(pages: LibraryDocument[][], options: { params?: string; now?: () => number } = {}) {
  const catalog = new FakeCatalog();
  catalog.pages = pages;
  const announcements: string[] = [];
  const client = new CatalogClient(
    { fetch: catalog.fetch, now: options.now ?? (() => NOW), timeZone: "America/Los_Angeles" },
    new URLSearchParams(options.params ?? ""),
  );
  client.onAnnounce((text) => announcements.push(text));
  return { catalog, client, announcements };
}

// setImmediate stays real under the faked timers; the browser tsconfig doesn't declare it.
const realImmediate = (globalThis as unknown as { setImmediate(callback: () => void): void }).setImmediate;
const tick = () => new Promise<void>((resolve) => realImmediate(resolve));

async function flush(rounds = 12): Promise<void> {
  for (let round = 0; round < rounds; round++) await tick();
}

async function until(predicate: () => boolean, label = "condition"): Promise<void> {
  for (let round = 0; round < 1_000; round++) {
    if (predicate()) return;
    await tick();
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function ready(client: CatalogClient): Promise<void> {
  await client.start();
  await until(() => client.scan.status !== "running" && client.scan.status !== "idle", "library listing");
}

/** Edits the query and lets the debounce elapse, as a pause after typing would. */
async function type(client: CatalogClient, text: string): Promise<void> {
  client.setFilters({ text });
  await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
  await flush();
}

async function searched(client: CatalogClient): Promise<void> {
  await until(() => client.searchState().complete || !!client.searchState().failure, "search to settle");
}

const ids = (docs: DocumentSummary[]) => docs.map((document) => document.id);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("catalog client: metadata snapshot", () => {
  it("lists ≤500-row metadata pages at one generation and never asks for document text", async () => {
    const { client, catalog } = setup([range(3), [], range(2, 4)]);
    catalog.status = libraryStatus({ counts: { documents: 5, pending: 0, indexed: 5, failed: 0, metadataOnly: 0, truncated: 0 } });
    await ready(client);

    expect(client.view).toBe("library");
    expect(client.scan).toMatchObject({ status: "complete", generation: 7, pages: 3 });
    expect(client.library).toEqual(catalog.status);
    expect(ids(client.observed())).toEqual(ids(range(5)));
    expect(catalog.requests("GET", "/all-docs/api/documents").map((request) => request.path))
      .toEqual(["/all-docs/api/documents", "/all-docs/api/documents?cursor=g7p1", "/all-docs/api/documents?cursor=g7p2"]);
    for (const request of catalog.recorded.filter((entry) => entry.method === "GET")) {
      expect(request.headers["x-docs-catalog"]).toBe("1");
      expect(request.headers["x-csrf-token"]).toBeUndefined();
      expect(request.init.credentials).toBe("same-origin");
      expect(request.init.cache).toBe("no-store");
    }
    // No query: nothing is searched, and no per-document text route exists any more.
    expect(catalog.recorded.filter((request) => request.method === "POST")).toEqual([]);
    expect(catalog.recorded.some((request) => request.path.includes("/text"))).toBe(false);
  });

  it("restarts a snapshot whose generation moved mid-listing, a bounded number of times", async () => {
    const { client, catalog } = setup([range(2), range(2, 3)]);
    let bumped = false;
    catalog.pageHook = (index) => {
      if (index === 1 && !bumped) {
        bumped = true;
        catalog.generation = 8;
      }
    };
    await ready(client);

    expect(client.scan).toMatchObject({ status: "complete", generation: 8 });
    expect(catalog.requests("GET", "/all-docs/api/documents").map((request) => request.path)).toEqual([
      "/all-docs/api/documents", "/all-docs/api/documents?cursor=g7p1", "/all-docs/api/documents", "/all-docs/api/documents?cursor=g8p1",
    ]);
    expect(client.observed()).toHaveLength(4);

    // A library that changes during every listing stops instead of re-listing forever.
    catalog.pageHook = (index) => {
      if (index === 1) catalog.generation++;
    };
    const before = catalog.requests("GET", "/all-docs/api/documents").length;
    client.refresh();
    await until(() => client.scan.status === "error", "stale listing");
    expect(client.scan).toMatchObject({ stale: true, error: "The library kept changing while it loaded." });
    const firstPages = catalog.requests("GET", "/all-docs/api/documents").slice(before).filter((request) => !request.path.includes("cursor"));
    expect(firstPages).toHaveLength(MAX_SNAPSHOT_RESTARTS + 1);
    expect(client.selectAllGate()).toEqual({ ok: false, reason: "Unavailable because the library listing is incomplete" });

    // Retry can't resume a cursor bound to an old generation; it lists afresh.
    catalog.pageHook = null;
    client.retryScan();
    await until(() => client.scan.status === "complete", "fresh listing");
    expect(client.observed()).toHaveLength(4);
  });

  it("marks the listing incomplete instead of silently skipping an unreadable entry", async () => {
    const broken = { ...doc(2), index: { state: "indexing" } } as unknown as LibraryDocument;
    const { client } = setup([[doc(1), broken], range(1, 3)]);
    await ready(client);

    expect(client.scan.status).toBe("incomplete");
    expect(client.selectAllGate()).toEqual({ ok: false, reason: "Unavailable because the library listing is incomplete" });
  });

  it("keeps the pages read so far after a load error and resumes from the failed cursor", async () => {
    const { client, catalog } = setup([range(2), range(2, 3)]);
    let failures = 1;
    const fetch = catalog.fetch;
    const flaky = async (input: string, init?: RequestInit) =>
      input.includes("cursor=") && failures-- > 0 ? libraryError(503, "library_unavailable", "The index is unavailable.", true) : fetch(input, init);
    const flakyClient = new CatalogClient({ fetch: flaky, now: () => NOW });
    await ready(flakyClient);
    expect(flakyClient.scan).toMatchObject({ status: "error", error: "The index is unavailable.", stale: false });
    expect(flakyClient.observed()).toHaveLength(2);

    flakyClient.retryScan();
    await until(() => flakyClient.scan.status === "complete", "resumed listing");
    expect(flakyClient.observed()).toHaveLength(4);
    expect(client.view).toBe("booting"); // The unused default client never started.
  });

  it("maps login failures to the designed states and opens the library on success", async () => {
    const { client, catalog } = setup([range(1)]);
    catalog.sessionStatus = 401;
    await client.start();
    expect(client.view).toBe("login");
    expect(client.login.problem).toBeNull();

    await client.signIn("wrong");
    expect(client.login.problem).toBe("wrong-password");

    catalog.loginStatus = 429;
    catalog.retryAfter = "120";
    await client.signIn("correct horse");
    expect(client.login).toMatchObject({ problem: "rate-limited", retryAfterSeconds: 120 });

    catalog.loginStatus = 503;
    await client.signIn("correct horse");
    expect(client.login.problem).toBe("unconfigured");

    catalog.loginStatus = 200;
    await client.signIn("correct horse");
    expect(client.view).toBe("library");
    const login = catalog.requests("POST", "/all-docs/session").at(-1) as Recorded;
    expect(login.body).toEqual({ password: "correct horse" });
    expect(login.headers["content-type"]).toBe("application/json");
    expect(login.headers["x-docs-catalog"]).toBe("1");
  });
});

describe("catalog client: session teardown", () => {
  it("lock aborts the owned search, drops every private byte and ends the session with the CSRF token", async () => {
    const { client, catalog } = setup([range(4)], { params: "q=Document" });
    catalog.hold = true;
    await client.start();
    await until(() => catalog.held.length === 1, "held search");
    const search = catalog.searches()[0];

    await client.lock();

    expect(search.init.signal?.aborted).toBe(true);
    expect(client.view).toBe("login");
    expect(client.observed()).toEqual([]);
    expect(client.results().visible).toEqual([]);
    expect(client.filters.text).toBe("");
    expect(client.searchState()).toMatchObject({ phase: "idle", held: false });
    const logout = catalog.requests("DELETE", "/all-docs/session")[0];
    expect(logout.headers["x-csrf-token"]).toBe("csrf-token-1");
    expect(logout.headers["x-docs-catalog"]).toBe("1");
  });

  it("never lets a late reply from a locked session resurrect hits in the next session", async () => {
    const { client, catalog } = setup([[doc(1, { title: "Invoice March" }), doc(2)]], { params: "q=Invoice" });
    catalog.hold = true;
    catalog.ignoreAbort = true; // A reply that was already on the wire still arrives.
    await client.start();
    await until(() => catalog.held.length === 1, "held search");
    await client.lock();

    catalog.hold = false;
    await client.signIn("correct horse");
    await until(() => client.scan.status === "complete");
    catalog.release(); // The old session's reply lands now.
    await flush();

    expect(client.filters.text).toBe("");
    expect(client.searchState().held).toBe(false);
    expect(client.hitFor(client.summary("doc00001") as DocumentSummary)).toBeNull();
    await type(client, "Document 2");
    await searched(client);
    expect(ids(client.results().matching)).toEqual(["doc00002"]);
  });

  it("ends the session on a 401 even when the reply belongs to a superseded query", async () => {
    const { client, catalog } = setup([range(2)]);
    await ready(client);
    catalog.hold = true;
    catalog.searchReply = () => error(401);
    await type(client, "invoice");
    client.setFilters({ text: "" }); // Nothing newer will be sent.
    catalog.release();
    await flush();

    expect(client.view).toBe("login");
    expect(client.login.problem).toBe("expired");
    expect(client.observed()).toEqual([]);
  });

  it("returns to login with the query kept when the session expires during a search", async () => {
    const { client, catalog } = setup([range(2)]);
    await ready(client);
    catalog.searchReply = () => error(401);
    await type(client, "invoice");

    expect(client.view).toBe("login");
    expect(client.login.problem).toBe("expired");
    expect(client.filters.text).toBe("invoice");
    expect(client.observed()).toEqual([]);
    expect(client.searchState().held).toBe(false);
  });
});

describe("catalog client: search lane", () => {
  it("debounces typing into one authenticated POST with the query and an all-documents filter", async () => {
    const { client, catalog } = setup([range(3)]);
    await ready(client);
    for (const text of ["i", "in", "inv", "invo"]) {
      client.setFilters({ text });
      await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS - 50);
    }
    expect(catalog.searches()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(50);
    await flush();

    const [request, ...rest] = catalog.searches();
    expect(rest).toEqual([]);
    expect(request.path).toBe("/all-docs/api/search"); // Query text never enters a URL.
    expect(request.body).toEqual({
      version: 1, query: { text: "invo", mode: "literal", ignoreCase: true },
      filter: { kinds: [], uploadedBefore: null, uploadedAfter: null },
    });
    expect(request.headers).toMatchObject({ "x-csrf-token": "csrf-token-1", "x-docs-catalog": "1", "content-type": "application/json" });
    // Typing never re-reads metadata or rebuilds anything in the tab.
    expect(catalog.requests("GET", "/all-docs/api/documents")).toHaveLength(1);
  });

  it("keeps one request in flight and sends only the latest input when it settles", async () => {
    const { client, catalog } = setup([[doc(1, { title: "gamma ray" }), doc(2)]]);
    await ready(client);
    catalog.hold = true;
    await type(client, "alpha");
    await type(client, "beta");
    await type(client, "gamma");
    expect(catalog.searches()).toHaveLength(1);
    expect(client.searchState()).toMatchObject({ phase: "pending", current: false });

    catalog.release(); // "alpha" answers after newer input: discarded unread.
    await flush();
    expect(catalog.searches().map((request) => request.body.query.text)).toEqual(["alpha", "gamma"]);
    expect(client.searchState().held).toBe(false);

    catalog.release();
    await flush();
    expect(client.searchState()).toMatchObject({ phase: "complete", current: true });
    expect(ids(client.results().matching)).toEqual(["doc00001"]);
    expect(catalog.maxInFlight).toBe(1);
  });

  it("does not overlap a refresh's search with one still running; the older reply is dropped", async () => {
    const { client, catalog } = setup([range(3)]);
    catalog.bodies.set("doc00001", "invoice");
    await ready(client);
    catalog.hold = true;
    await type(client, "invoice");
    catalog.generation = 8;
    client.refresh();
    await until(() => client.scan.status === "complete");
    expect(client.scan.generation).toBe(8);
    expect(catalog.searches()).toHaveLength(1);

    catalog.release();
    await flush();
    expect(catalog.searches()).toHaveLength(2);
    expect(client.searchState().held).toBe(false);
    catalog.release();
    await searched(client);
    expect(client.searchState()).toMatchObject({ complete: true, resultsKey: expect.stringContaining("@8") });
    expect(catalog.maxInFlight).toBe(1);
  });

  it("finds titles, filenames and cached body text, ignoring unknown IDs and changed versions", async () => {
    const docs = [
      doc(1, { title: "Quarterly invoice" }),
      doc(2, { filename: "invoice-2.md" }),
      doc(3),
      doc(4),
      doc(5, { title: "Invoice draft" }, { state: "pending", coverage: null, indexedBytes: 0, extractorVersion: 0 }),
    ];
    const { client, catalog } = setup([docs]);
    catalog.bodies.set("doc00003", "Paid invoice, invoice two");
    catalog.bodies.set("doc00005", "invoice"); // Pending: the index has no text for it yet.
    catalog.extraHits = [{ id: "zzzzzzzz", version: "v1", matchCount: 9 }, { id: "doc00004", version: "v0-old", matchCount: 2 }];
    await ready(client);
    await type(client, "invoice");
    await searched(client);

    const matching = client.results().matching;
    expect(ids(matching)).toEqual(["doc00003", "doc00001", "doc00002", "doc00005"]);
    expect(matching.map((document) => client.hitFor(document)?.matchCount)).toEqual([2, 1, 1, 1]);
    expect(client.hitFor(client.summary("doc00004") as DocumentSummary)).toBeNull();
    expect(client.indexOf("doc00005")).toMatchObject({ state: "pending" });
  });

  it("accumulates progressive slices and holds most-matches order and select all until complete", async () => {
    const docs = range(6);
    const { client, catalog } = setup([docs]);
    docs.forEach((document, index) => catalog.bodies.set(document.id, "paid ".repeat(index + 1)));
    catalog.regexSlice = 2;
    await ready(client);
    catalog.hold = true;
    client.setFilters({ regex: true });
    await type(client, "pa[iy]d");
    catalog.release();
    await flush();

    expect(client.searchState()).toMatchObject({ phase: "scanning", current: true, complete: false });
    expect(ids(client.results().matching)).toEqual(["doc00001", "doc00002"]);
    expect(client.results().provisional).toBe(true);
    expect(client.selectAllGate()).toEqual({ ok: false, reason: "Available when the search finishes" });
    const [first, continuation] = catalog.searches();
    expect(continuation.body).toEqual({ ...first.body, cursor: "g7s2" });
    expect(catalog.snippetCalls()).toHaveLength(0); // Snippets wait for the final result.

    catalog.release();
    await flush();
    catalog.release();
    await flush();
    expect(client.searchState()).toMatchObject({ phase: "complete", complete: true });
    expect(client.results().provisional).toBe(false);
    expect(ids(client.results().matching)).toEqual(["doc00006", "doc00005", "doc00004", "doc00003", "doc00002", "doc00001"]);
    expect(client.selectAllGate()).toEqual({ ok: true, count: 6 });
    expect(catalog.maxInFlight).toBe(1);
  });

  it("stops a progressive scan's continuations as soon as newer input arrives", async () => {
    const { client, catalog } = setup([range(6)]);
    catalog.regexSlice = 2;
    await ready(client);
    catalog.hold = true;
    client.setFilters({ regex: true });
    await type(client, "Doc[a-z]+");
    catalog.release();
    await flush();
    expect(catalog.searches().at(-1)?.body.cursor).toBe("g7s2");

    await type(client, "Document 1");
    catalog.release(); // The continuation's reply is discarded; no further slice is asked for.
    await flush();
    const sent = catalog.searches();
    expect(sent.map((request) => [request.body.query.text, request.body.cursor ?? null]))
      .toEqual([["Doc[a-z]+", null], ["Doc[a-z]+", "g7s2"], ["Document 1", null]]);
    catalog.hold = false;
    catalog.release();
    await searched(client);
    expect(ids(client.results().matching)).toEqual(["doc00001"]);
  });

  it("restarts a scan whose continuation went stale, then stops after the allowed restarts", async () => {
    const { client, catalog } = setup([range(4)]);
    catalog.regexSlice = 2;
    await ready(client);
    catalog.hold = true;
    client.setFilters({ regex: true });
    await type(client, "Doc[a-z]+");
    for (let attempt = 0; attempt <= MAX_STALE_RESTARTS; attempt++) {
      catalog.release(); // First slice.
      await flush();
      expect(client.searchState().phase).toBe("scanning");
      catalog.generation++; // Indexing lands mid-scan.
      catalog.release(); // The continuation fails with stale_generation.
      await flush();
      if (attempt < MAX_STALE_RESTARTS) {
        // Partial slices of the stale run are cleared; the restart has no cursor.
        expect(client.searchState().held).toBe(false);
        expect(catalog.searches().at(-1)?.body.cursor).toBeUndefined();
      }
    }
    expect(client.searchState().failure).toEqual({
      kind: "changing", message: "The library kept changing during this search. Refresh, then try again.",
    });
    expect(catalog.searches()).toHaveLength(2 * (MAX_STALE_RESTARTS + 1));
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
    await flush();
    expect(catalog.searches()).toHaveLength(2 * (MAX_STALE_RESTARTS + 1));
  });

  it("shows a retryable backend failure instead of an empty list and resumes from the cursor", async () => {
    const { client, catalog } = setup([range(4)]);
    catalog.regexSlice = 2;
    catalog.searchReply = (_, call) => call === 2 ? libraryError(503, "library_unavailable", "The index is unavailable.", true) : null;
    await ready(client);
    client.setFilters({ regex: true });
    await type(client, "Doc[a-z]+");
    await searched(client);

    expect(client.searchState().failure).toEqual({ kind: "unavailable", message: "The index is unavailable." });
    expect(client.results().matching).toHaveLength(2); // The slice already read stays listed.
    expect(client.selectAllGate()).toEqual({ ok: false, reason: "Unavailable while the search reports an error" });

    client.retrySearch();
    await searched(client);
    expect(catalog.searches().map((request) => request.body.cursor ?? null)).toEqual([null, "g7s2", "g7s2"]);
    expect(client.searchState().complete).toBe(true);
    expect(client.results().matching).toHaveLength(4);
  });

  it("reports an invalid pattern and keeps the last valid results on screen", async () => {
    const docs = range(3);
    const { client, catalog } = setup([docs]);
    catalog.bodies.set("doc00002", "paid");
    await ready(client);
    client.setFilters({ regex: true });
    await type(client, "pa[iy]d");
    await searched(client);
    await type(client, "pa[");
    await searched(client);

    expect(client.searchState()).toMatchObject({ phase: "error", held: true, current: false });
    expect(client.searchState().failure?.kind).toBe("pattern");
    expect(ids(client.results().matching)).toEqual(["doc00002"]);
    expect(client.selectAllGate()).toEqual({ ok: false, reason: "Unavailable while the search reports an error" });
  });

  it("fails a too-broad search explicitly and refuses over-long text without a request", async () => {
    const { client, catalog } = setup([range(2)]);
    catalog.searchReply = () => libraryError(422, "search_budget_exceeded", "Search exceeds 10,000 hits. Narrow the filters.");
    await ready(client);
    await type(client, "e");
    await searched(client);
    expect(client.searchState().failure).toEqual({
      kind: "budget", message: "This search matches too many documents to finish. Make it more specific, or filter by type or date.",
    });
    expect(client.results().matching).toEqual([]);

    await type(client, "é".repeat(129)); // 258 UTF-8 bytes.
    expect(catalog.searches()).toHaveLength(1);
    expect(client.searchState().failure).toEqual({ kind: "pattern", message: "Search text is limited to 256 bytes." });
  });

  it("re-runs a query too broad for the whole library within the active filter, and follows it", async () => {
    const docs = [1, 2, 3, 4, 5, 6].map((n) => doc(n, { kind: n % 2 ? "pdf" : "markdown" }));
    const { client, catalog } = setup([docs]);
    catalog.hitCap = 4;
    await ready(client);
    await type(client, "Document");
    await searched(client);
    // No filter can narrow it: the failure says how to proceed, after one request.
    expect(client.searchState().failure?.kind).toBe("budget");
    expect(catalog.searches()).toHaveLength(1);

    await type(client, "Document"); // Unchanged input sends nothing.
    client.setFilters({ kinds: ["pdf"] });
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
    await searched(client);
    const scoped = catalog.searches().at(-1)!;
    expect(scoped.body.filter).toEqual({ kinds: ["pdf"], uploadedAfter: null, uploadedBefore: null });
    expect(client.searchState()).toMatchObject({ complete: true, scoped: true, failure: null });
    expect(ids(client.results().matching)).toEqual(["doc00001", "doc00003", "doc00005"]);
    // Counts outside the scope are unknown, not zero: the other type stays listed without one.
    expect(Object.fromEntries(client.results().kindCounts)).toEqual({ pdf: 3 });
    expect(client.results().unknownKinds).toEqual(["markdown"]);
    expect(client.results().olderThan90).toBe(0);
    expect(client.selectAllGate()).toEqual({ ok: true, count: 3 });

    // An age window narrower than "older than 90 days" makes that chip's count unknowable.
    client.setFilters({ age: "lt7" });
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
    await searched(client);
    expect(catalog.searches().at(-1)!.body.filter).toMatchObject({ kinds: ["pdf"], uploadedBefore: null });
    expect(catalog.searches().at(-1)!.body.filter.uploadedAfter).not.toBeNull();
    expect(client.results().olderThan90).toBeNull();
    client.setFilters({ age: "any" });
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
    await searched(client);

    // Broadening past the budget fails within the filter; clearing it fails without a request.
    client.setFilters({ kinds: ["pdf", "markdown"] });
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
    await searched(client);
    expect(client.searchState().failure?.message).toMatch(/even within these filters/);
    const sent = catalog.searches().length;
    client.setFilters({ kinds: [] });
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
    await flush();
    expect(catalog.searches()).toHaveLength(sent);
    expect(client.searchState().failure?.message).toMatch(/filter by type or date/);
    expect(catalog.maxInFlight).toBe(1);
  });

  it("scopes automatically when the over-budget query arrives with a filter already active", async () => {
    const docs = [1, 2, 3, 4, 5, 6].map((n) => doc(n, { kind: n % 2 ? "pdf" : "markdown" }));
    const { client, catalog } = setup([docs], { params: "kind=markdown" });
    catalog.hitCap = 4;
    await ready(client);
    await type(client, "Document");
    await searched(client);

    expect(catalog.searches().map((request) => request.body.filter.kinds)).toEqual([[], ["markdown"]]);
    expect(ids(client.results().matching)).toEqual(["doc00002", "doc00004", "doc00006"]);
  });

  it("abandons a hung request after the timeout and waits for an explicit retry", async () => {
    const { client, catalog } = setup([range(2)]);
    await ready(client);
    catalog.hold = true;
    await type(client, "Document");
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
    await flush();

    expect(catalog.searches()[0].init.signal?.aborted).toBe(true);
    expect(client.searchState().failure).toEqual({ kind: "unavailable", message: "Couldn't reach the library to search." });
    expect(catalog.searches()).toHaveLength(1); // No automatic re-send: the server may still be busy.

    catalog.hold = false;
    client.retrySearch();
    await searched(client);
    expect(client.searchState().complete).toBe(true);
  });

  it("serves an empty query with filters and newest order without any search request", async () => {
    const docs = [doc(1, { kind: "pdf" }), doc(2), doc(3, { kind: "pdf" })];
    const { client, catalog } = setup([docs]);
    await ready(client);
    await type(client, "Document");
    await searched(client);
    await type(client, "");
    client.setFilters({ kinds: ["pdf"] });

    expect(ids(client.results().matching)).toEqual(["doc00001", "doc00003"]);
    expect(client.searchState().phase).toBe("idle");
    expect(client.selectAllGate()).toEqual({ ok: true, count: 2 });
    expect(catalog.searches()).toHaveLength(1);
  });

  it("asks for Refresh when a search reports a newer library generation", async () => {
    const { client, catalog } = setup([range(3)]);
    await ready(client);
    catalog.generation = 8;
    await type(client, "Document");
    await searched(client);

    expect(client.libraryChanged()).toBe(true);
    expect(client.selectAllGate()).toEqual({ ok: false, reason: "The library changed since it loaded — Refresh to select all matching" });

    client.refresh();
    await until(() => client.scan.status === "complete");
    await searched(client);
    expect(client.libraryChanged()).toBe(false);
    expect(client.selectAllGate()).toEqual({ ok: true, count: 3 });
  });
});

describe("catalog client: snippets", () => {
  it("fetches ≤48 snippets for rendered hit cards, repeats remaining refs and keeps unavailable distinct", async () => {
    const docs = range(60);
    const { client, catalog } = setup([docs]);
    for (const document of docs) catalog.bodies.set(document.id, `<b>paid</b> invoice ${document.id}`);
    catalog.snippetBudget = 30;
    catalog.unavailable.add("doc00003");
    await ready(client);
    await type(client, "invoice");
    await until(() => catalog.snippetCalls().length === 2 && catalog.inFlight === 0, "snippet calls");
    await flush();

    const [first, second, ...rest] = catalog.snippetCalls();
    expect(rest).toEqual([]);
    const rendered = client.rendered().map((document) => ({ id: document.id, version: document.version }));
    expect(first.body).toEqual({ version: 1, generation: 7, query: { text: "invoice", mode: "literal", ignoreCase: true }, refs: rendered });
    expect(second.body.refs).toEqual(rendered.slice(30)); // Remaining refs, same query and generation.
    expect(second.body.generation).toBe(7);

    const one = client.snippetFor(client.summary("doc00001") as DocumentSummary);
    expect(one).toMatchObject({ status: "ready", snippet: expect.stringContaining("<b>paid</b> invoice") });
    expect(one?.status === "ready" && one.ranges.length).toBe(1);
    expect(client.snippetFor(client.summary("doc00003") as DocumentSummary)).toEqual({ version: "v1-doc00003", status: "unavailable" });

    client.showMore();
    await until(() => catalog.snippetCalls().length === 3 && catalog.inFlight === 0, "next page of snippets");
    expect(catalog.snippetCalls()[2].body.refs.map((ref) => ref.id)).toEqual(ids(docs.slice(48)));
    // Unavailable stays unavailable; nothing is asked twice and no body route exists.
    await flush();
    expect(catalog.snippetCalls()).toHaveLength(3);
    expect(catalog.recorded.some((request) => request.path.includes("/text"))).toBe(false);
  });

  it("searches a URL query at once alongside the listing; snippets wait for the listing", async () => {
    const { client, catalog } = setup([range(2), range(2, 3)], { params: "q=Document" });
    let releasePage!: () => void;
    catalog.pageHook = (index) => index === 1 ? new Promise<void>((resolve) => { releasePage = resolve; }) : undefined;
    void client.start();
    await until(() => catalog.searches().length === 1 && client.observed().length === 2, "search and first page");
    await flush();
    expect(client.searchState().complete).toBe(true);
    expect(catalog.snippetCalls()).toHaveLength(0);

    releasePage();
    await until(() => catalog.snippetCalls().length === 1, "snippets after listing");
    expect(catalog.snippetCalls()[0].body.refs).toHaveLength(4);
  });

  it("restarts the search when snippets report a stale generation, keeping results until replaced", async () => {
    const { client, catalog } = setup([range(2)]);
    await ready(client);
    catalog.hold = true;
    await type(client, "Document");
    catalog.release(); // Search at generation 7.
    await flush();
    expect(catalog.snippetCalls()).toHaveLength(1);
    catalog.generation = 8;
    catalog.release(); // Snippets: stale_generation.
    await flush();

    expect(client.searchState()).toMatchObject({ held: true, current: true, complete: true, phase: "pending" });
    expect(client.selectAllGate()).toEqual({ ok: false, reason: "Available when the search finishes" });
    expect(catalog.searches()).toHaveLength(2);
    catalog.release(); // Fresh search at generation 8.
    await flush();
    expect(catalog.snippetCalls().at(-1)?.body.generation).toBe(8);
    catalog.release();
    await flush();
    expect(client.snippetFor(client.summary("doc00001") as DocumentSummary)?.status).toBe("ready");
  });

  it("keeps snippet ranges inert: invalid, overlapping and out-of-bounds ranges are dropped", async () => {
    const { client, catalog } = setup([range(1)]);
    catalog.snippetReply = (body) => Response.json({
      version: 1, generation: body.generation, remaining: [], unavailable: [],
      hits: [{ ...body.refs[0], matchCount: 1, snippet: "<img src=x> paid", ranges: [[12, 16], [13, 15], [-1, 2], [3, 99], ["0", "1"], [5, 5]] }],
    });
    await ready(client);
    await type(client, "Document");
    await until(() => client.snippetFor(client.summary("doc00001") as DocumentSummary) !== null, "snippet");
    expect(client.snippetFor(client.summary("doc00001") as DocumentSummary))
      .toEqual({ version: "v1-doc00001", status: "ready", snippet: "<img src=x> paid", ranges: [[12, 16]] });
  });
});

describe("catalog client: coverage and select all", () => {
  it("discloses pending, failed, partial, name-only and paused coverage and gates select all by scope", async () => {
    const docs = [
      doc(1, { kind: "pdf" }, { state: "pending", coverage: null, reason: "paused: index size budget", indexedBytes: 0 }),
      doc(2),
      doc(3, {}, { state: "failed", coverage: null, reason: "DOCX could not be parsed within the bounded ZIP/XML limits." }),
      doc(4, { kind: "image" }, { coverage: "metadata-only", reason: "No OCR is performed." }),
      doc(5, {}, { coverage: "truncated", indexedBytes: 524_288 }),
    ];
    const { client, catalog } = setup([docs]);
    catalog.status = libraryStatus({
      counts: { documents: 5, pending: 1, indexed: 3, failed: 1, metadataOnly: 1, truncated: 1 },
      storage: { bytes: 1, budgetBytes: 2, planningBytes: null, projectedBytes: 3, paused: true, reason: "index size budget" },
    });
    await ready(client);
    await type(client, "Document");
    await searched(client);

    expect(client.results().scope).toEqual({
      total: 5, searchable: 2, truncated: 1, nameOnly: 1, nameOnlyKinds: ["image"], unreadable: 0, pending: 1, failed: 1,
    });
    expect(client.libraryStatus()?.storage.paused).toBe(true);
    expect(client.selectAllGate()).toEqual({ ok: false, reason: "Unavailable: 1 document in these filters isn't indexed yet" });

    client.setFilters({ kinds: ["markdown"] }); // The pending PDF leaves the scope.
    expect(client.selectAllGate()).toEqual({ ok: false, reason: "Unavailable: 1 document couldn't be indexed — retry it first" });

    // Without a query every document in the filters matches whatever its index state, so pending
    // and failed rows don't block it (age cleanup must keep working under a paused size budget).
    client.setFilters({ text: "", kinds: [] });
    expect(client.selectAllGate()).toEqual({ ok: true, count: 5 });
    await type(client, "Document");
    await searched(client);
    client.setFilters({ kinds: ["markdown"] });

    await client.retryIndexing();
    const retry = catalog.requests("POST", "/all-docs/api/index/retry")[0];
    expect(retry.body).toEqual({ version: 1, refs: [{ id: "doc00003", version: "v1-doc00003" }] });
    expect(retry.headers["x-csrf-token"]).toBe("csrf-token-1");
    expect(client.retry).toEqual({ status: "done", message: "Retried 1 document: 1 indexed, 0 still failing. Refresh to update coverage." });
    expect(client.libraryChanged()).toBe(true); // The retry's newer generation asks for Refresh.

    // A known change makes the snapshot stale for the empty query too.
    await type(client, "");
    expect(client.selectAllGate()).toEqual({ ok: false, reason: "The library changed since it loaded — Refresh to select all matching" });
  });

  it("keeps page selection usable while a progressive search is still running", async () => {
    const { client, catalog } = setup([range(4)]);
    catalog.regexSlice = 2;
    await ready(client);
    catalog.hold = true;
    client.setFilters({ regex: true });
    await type(client, "Doc[a-z]+");
    catalog.release();
    await flush();

    client.selectPage();
    expect(ids(client.observed().filter((document) => client.isSelected(document.id)))).toEqual(["doc00001", "doc00002"]);
    expect(client.selectAllMatching()).toBe(false);
    expect(client.selection.scope).toBe("refs");
  });
});

describe("catalog client: filters", () => {
  it("freezes the age cutoff: strict before for older-than, inclusive for last N days", async () => {
    let clock = NOW;
    const older = doc(1, { uploadedAt: new Date(NOW - 90 * DAY - 60_000).toISOString() });
    const newer = doc(2, { uploadedAt: new Date(NOW - 90 * DAY + 60_000).toISOString() });
    const { client } = setup([[older, newer]], { now: () => clock });
    await ready(client);

    client.setFilters({ age: "gt90" });
    expect(ids(client.results().matching)).toEqual([older.id]);
    expect(client.results().olderThan90).toBe(1);
    expect(client.cutoffLine()).toBe("Uploaded before Jul 16, 2026, 9:16 PM PDT · cutoff fixed at 9:16 PM");

    // Time passes: the frozen cutoff does not drift until the user resets it.
    clock = NOW + 5 * 60_000;
    expect(ids(client.results().matching)).toEqual([older.id]);
    client.resetCutoff();
    expect(ids(client.results().matching)).toEqual([newer.id, older.id]);

    client.setFilters({ age: "lt90" });
    expect(client.window().after).toBe(clock - 90 * DAY);
    expect(client.results().matching).toEqual([]);
  });

  it("applies inclusive local date ranges and keeps the last valid range when inverted", () => {
    const window = ageWindow({ age: "range", from: "2026-01-01", to: "2026-03-31" }, NOW);
    expect(window.after).toBe(new Date(2026, 0, 1).getTime());
    expect(window.before).toBe(new Date(2026, 3, 1).getTime());

    const { client } = setup([[]]);
    expect(client.setRange("2026-01-01", "2026-03-31")).toBeNull();
    expect(client.setRange("2026-04-01", "2026-03-31")).toBe("End date is before start date");
    expect(client.filters).toMatchObject({ age: "range", from: "2026-01-01", to: "2026-03-31" });
  });

  it("round-trips URL state without the cutoff or the selection", () => {
    const params = new URLSearchParams("q=invoice&re=1&case=1&kind=pdf,markdown,bogus&age=gt90&sort=largest&cutoff=1");
    const filters = filtersFromParams(params);
    expect(filters).toEqual({
      text: "invoice", regex: true, matchCase: true, kinds: ["pdf", "markdown"], age: "gt90", from: "", to: "", sort: "largest",
    });
    expect(filtersToParams(filters).toString()).toBe("q=invoice&re=1&case=1&kind=pdf%2Cmarkdown&age=gt90&sort=largest");
    expect(filtersFromParams(new URLSearchParams("age=forever&sort=__proto__&from=2026-02-30")).age).toBe("any");
  });

  it("counts types over every other filter, including while searching, without another request", async () => {
    const docs = [
      doc(1, { kind: "pdf", sizeBytes: 50 }),
      doc(2, { kind: "pdf", sizeBytes: 900 }),
      doc(3, { kind: "image", sizeBytes: 900 }),
    ];
    const { client, catalog } = setup([docs]);
    await ready(client);

    client.setFilters({ kinds: ["pdf"], sort: "largest" });
    const results = client.results();
    expect(ids(results.matching)).toEqual(["doc00002", "doc00001"]);
    expect(Object.fromEntries(results.kindCounts)).toEqual({ pdf: 2, image: 1 });

    await type(client, "Document");
    await searched(client);
    client.setFilters({ kinds: ["image"] });
    expect(Object.fromEntries(client.results().kindCounts)).toEqual({ pdf: 2, image: 1 });
    expect(catalog.searches()).toHaveLength(1);
  });
});

describe("catalog client: selection", () => {
  it("keeps explicit refs across filter changes and reports how many are hidden", async () => {
    const { client } = setup([[doc(1, { kind: "pdf" }), doc(2), doc(3)]]);
    await ready(client);

    client.toggle("doc00001");
    client.toggle("doc00003", true); // Shift range over rendered order 1..3.
    expect([...client.selectedIds()].sort()).toEqual(["doc00001", "doc00002", "doc00003"]);

    client.setFilters({ kinds: ["pdf"] });
    expect(client.selection.scope).toBe("refs");
    expect(client.results().hiddenSelected).toBe(2);
    client.setSelectedOnly(true);
    expect(client.results().visible).toHaveLength(3);
  });

  it("clears an all-matching selection on any filter change and announces it", async () => {
    const { client, announcements } = setup([range(5)]);
    await ready(client);
    client.setFilters({ age: "gt90" });
    expect(client.selectAllGate()).toEqual({ ok: false, reason: "Nothing matches" });
    client.setFilters({ age: "any" });

    expect(client.selectAllMatching()).toBe(true);
    client.toggle("doc00002");
    expect(client.selection.excluded.has("doc00002")).toBe(true);
    expect(client.selectedIds().size).toBe(4);

    client.setFilters({ sort: "oldest" });
    expect(client.selection.scope).toBe("matching");
    client.setFilters({ text: "x" });
    expect(client.selection.scope).toBe("none");
    expect(announcements).toContain("Selection cleared because filters changed.");
  });

  it("refuses select-all while the listing is still loading", async () => {
    const { client, catalog } = setup([range(2), range(2, 3)]);
    let release!: () => void;
    catalog.pageHook = (index) => index === 1 ? new Promise<void>((resolve) => { release = resolve; }) : undefined;
    void client.start();
    await until(() => client.observed().length === 2);

    expect(client.selectAllGate()).toEqual({ ok: false, reason: "Available when the library finishes loading (2 found so far)" });
    expect(client.selectAllMatching()).toBe(false);
    release();
    await until(() => client.scan.status === "complete");
    expect(client.selectAllGate()).toEqual({ ok: true, count: 4 });
  });
});

describe("catalog client: delete review", () => {
  it("freezes refs oldest first, requires the typed count and commits batches of at most 100", async () => {
    const docs = range(205);
    const { client, catalog } = setup([docs.slice(0, 120), docs.slice(120)]);
    await ready(client);
    client.setFilters({ age: "gt30" });
    client.setFilters({ age: "any" });
    expect(client.selectAllMatching()).toBe(true);

    const review = client.openReview();
    expect(review?.items).toHaveLength(205);
    expect(review?.items[0].ref.id).toBe("doc00205"); // Oldest upload first.
    expect(review?.totalBytes).toBe(docs.reduce((sum, document) => sum + document.sizeBytes, 0));
    expect(client.canConfirm("204")).toBe(false);
    expect(client.canConfirm("")).toBe(false);
    expect(client.canConfirm(" 205 ")).toBe(true);

    await client.confirmReview("204");
    expect(catalog.requests("POST", "/all-docs/api/delete")).toHaveLength(0);

    await client.confirmReview("205");
    const batches = catalog.requests("POST", "/all-docs/api/delete");
    expect(batches.map((request) => (request.body as DeleteBatchRequest).items.length)).toEqual([100, 100, 5]);
    for (const request of batches) {
      const body = request.body as DeleteBatchRequest;
      expect(body).toMatchObject({ version: 1, confirmCount: body.items.length, confirmation: `DELETE ${body.items.length} documents` });
      expect(Object.keys(body).sort()).toEqual(["confirmCount", "confirmation", "items", "version"]); // Never a predicate.
      expect(request.headers["x-csrf-token"]).toBe("csrf-token-1");
      expect(request.headers["x-docs-catalog"]).toBe("1");
    }
    const sent = batches.flatMap((request) => (request.body as DeleteBatchRequest).items);
    expect(sent).toEqual([...docs].reverse().map((document) => ({ id: document.id, version: document.version })));
    expect(client.review?.phase).toBe("complete");

    client.closeReview();
    expect(client.observed()).toEqual([]);
    expect(client.selection.scope).toBe("none");
  });

  it("freezes exactly the searched set: deletion sends refs, never the query, after a complete search", async () => {
    const docs = range(4);
    const { client, catalog } = setup([docs]);
    catalog.bodies.set("doc00002", "invoice");
    catalog.bodies.set("doc00004", "invoice");
    await ready(client);
    await type(client, "invoice");
    await searched(client);
    expect(client.selectAllMatching()).toBe(true);
    client.openReview();

    catalog.bodies.set("doc00001", "invoice"); // A later match must not join the frozen review.
    await client.confirmReview("2");
    const sent = catalog.requests("POST", "/all-docs/api/delete").flatMap((request) => (request.body as DeleteBatchRequest).items);
    expect(sent).toEqual([{ id: "doc00004", version: "v1-doc00004" }, { id: "doc00002", version: "v1-doc00002" }]);
  });

  it("never recomputes the age predicate after review, even if new documents now match", async () => {
    let clock = NOW;
    const old = doc(1, { uploadedAt: new Date(NOW - 100 * DAY).toISOString() });
    const borderline = doc(2, { uploadedAt: new Date(NOW - 89 * DAY).toISOString() });
    const { client, catalog } = setup([[old, borderline]], { now: () => clock });
    await ready(client);
    client.setFilters({ age: "gt90" });
    expect(client.selectAllMatching()).toBe(true);
    const review = client.openReview();
    expect(review?.window?.before).toBe(NOW - 90 * DAY);
    expect(describeWindow(review?.window ?? { after: null, before: null }, "America/Los_Angeles"))
      .toBe("Uploaded before Jul 16, 2026, 9:16 PM PDT");

    clock = NOW + 2 * DAY; // borderline would now be older than 90 days
    client.resetCutoff();
    await client.confirmReview("");
    const sent = catalog.requests("POST", "/all-docs/api/delete").flatMap((request) => (request.body as DeleteBatchRequest).items);
    expect(sent).toEqual([{ id: old.id, version: old.version }]);
  });

  it("keeps changed, failed and unprocessed refs selected after a partial run", async () => {
    const docs = range(150);
    const { client, catalog } = setup([docs]);
    await ready(client);
    for (const document of docs) client.toggle(document.id);
    catalog.deleteReply = (request, call) => {
      if (call === 2) return error(500);
      return Response.json({
        version: 1,
        outcomes: request.items.map((item, index) => ({
          id: item.id,
          status: (index === 0 ? "changed" : index === 1 ? "failed" : index === 2 ? "not-found" : "deleted") as DeleteProgress["outcomes"][number]["status"],
        })).slice(0, -1), // The last ref has no outcome at all.
      } satisfies DeleteProgress);
    };

    client.openReview();
    await client.confirmReview("150");
    expect(client.review?.phase).toBe("partial");
    const outcomes = [...(client.review?.outcomes.values() ?? [])];
    expect(outcomes.filter((outcome) => outcome === "deleted")).toHaveLength(96);
    expect(outcomes.filter((outcome) => outcome === "failed")).toHaveLength(2 + 50);

    client.closeReview();
    // 100 in batch one: 96 deleted + 1 missing leave; changed, failed and no-outcome stay.
    expect(client.observed()).toHaveLength(150 - 97);
    expect(client.selection.scope).toBe("refs");
    expect(client.selectedIds().size).toBe(3 + 50);
  });

  it("stops after the current batch and keeps unprocessed refs selected", async () => {
    const docs = range(250);
    const { client, catalog } = setup([docs]);
    await ready(client);
    expect(client.selectAllMatching()).toBe(true);
    let releaseFirst!: () => void;
    const first = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const original = catalog.deleteReply;
    catalog.deleteReply = async (request, call) => {
      if (call === 1) await first;
      return original(request, call);
    };

    client.openReview();
    const run = client.confirmReview("250");
    await until(() => catalog.requests("POST", "/all-docs/api/delete").length === 1);
    client.stopReview();
    releaseFirst();
    await run;

    expect(client.review?.phase).toBe("stopped");
    expect(catalog.requests("POST", "/all-docs/api/delete")).toHaveLength(1);
    client.closeReview();
    expect(client.selection.scope).toBe("refs");
    expect(client.selectedIds().size).toBe(150);
    expect(client.observed()).toHaveLength(150);
  });

  it("ends the session on a 401 mid-run without sending the remaining batches", async () => {
    const docs = range(120);
    const { client, catalog } = setup([docs]);
    await ready(client);
    expect(client.selectAllMatching()).toBe(true);
    catalog.deleteReply = () => error(401);

    client.openReview();
    await client.confirmReview("120");
    expect(client.review?.phase).toBe("session-ended");
    expect(catalog.requests("POST", "/all-docs/api/delete")).toHaveLength(1);

    client.closeReview();
    expect(client.view).toBe("login");
    expect(client.login.problem).toBe("expired");
    expect(client.observed()).toEqual([]);
  });

  it("keeps a failed single-card delete selected alongside the existing selection", async () => {
    const { client, catalog } = setup([range(3)]);
    await ready(client);
    client.toggle("doc00001");
    catalog.deleteReply = (request) => Response.json({
      version: 1, outcomes: request.items.map((item) => ({ id: item.id, status: "failed" as const })),
    } satisfies DeleteProgress);

    client.openReview("doc00003");
    await client.confirmReview("");
    expect(client.review?.phase).toBe("partial");
    client.closeReview();

    expect([...client.selectedIds()].sort()).toEqual(["doc00001", "doc00003"]);
    expect(client.observed()).toHaveLength(3);
  });

  it("shows the age cutoff for page selections made under one age window, not for mixed ones", async () => {
    const docs = [100, 120, 140].map((days, index) => doc(index + 1, { uploadedAt: new Date(NOW - days * DAY).toISOString() }));
    const { client } = setup([[...docs, doc(4)]]);
    await ready(client);
    client.setFilters({ age: "gt90" });
    client.selectPage();
    expect(client.openReview()?.window).toEqual({ after: null, before: NOW - 90 * DAY });
    client.closeReview();

    client.setFilters({ age: "any" });
    client.toggle("doc00004");
    expect(client.openReview()?.window).toBeNull();
  });

  it("deletes a single card without a typed count and leaves other selections intact", async () => {
    const { client, catalog } = setup([range(3)]);
    await ready(client);
    client.toggle("doc00001");
    client.toggle("doc00002");

    client.openReview("doc00002");
    expect(client.canConfirm("")).toBe(true);
    await client.confirmReview("");
    expect((catalog.requests("POST", "/all-docs/api/delete")[0].body as DeleteBatchRequest))
      .toEqual({ version: 1, items: [{ id: "doc00002", version: "v1-doc00002" }], confirmCount: 1, confirmation: "DELETE 1 documents" });
    client.closeReview();
    expect([...client.selectedIds()]).toEqual(["doc00001"]);
  });
});

describe("catalog client: formatting", () => {
  it("formats sizes and relative ages with the designed copy", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(12 * 1024)).toBe("12 KB");
    expect(formatBytes(2.4 * 1024 * 1024)).toBe("2.4 MB");
    expect(formatRelative(NOW - 20_000, NOW)).toBe("just now");
    expect(formatRelative(NOW - 5 * 60_000, NOW)).toBe("5 min ago");
    expect(formatRelative(NOW - 3 * HOUR, NOW)).toBe("3 h ago");
    expect(formatRelative(NOW - 30 * HOUR, NOW)).toBe("yesterday");
    expect(formatRelative(NOW - 12 * DAY, NOW)).toBe("12 days ago");
    expect(formatRelative(NOW - 95 * DAY, NOW)).toBe("3 mo ago");
    expect(formatRelative(NOW - 800 * DAY, NOW)).toBe("2 yr ago");
  });
});
