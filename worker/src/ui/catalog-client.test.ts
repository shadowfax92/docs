import { afterEach, describe, expect, it, vi } from "vitest";
import type { DeleteBatchRequest, DeleteProgress, DocumentSummary, TextRecord } from "../contracts";
import type { SearchHit, SearchWorkerRequest, SearchWorkerResponse } from "../search";
import {
  CatalogClient, QUERY_BUDGET_MS, TEXT_CONCURRENCY, ageWindow, describeWindow, filtersFromParams, filtersToParams,
  formatBytes, formatRelative, type SearchPort,
} from "./catalog-client";

// The catalog HTTP routes and the search worker are the client's two seams. These tests replace
// both with in-memory adapters and drive the client only through the interface app.ts uses.

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

interface Recorded { method: string; path: string; headers: Record<string, string>; body: unknown; init: RequestInit }

class FakeCatalog {
  pages: DocumentSummary[][] = [[]];
  recorded: Recorded[] = [];
  sessionStatus = 200;
  loginStatus = 200;
  retryAfter: string | null = null;
  texts = new Map<string, Partial<TextRecord>>();
  textGate: (() => Promise<void>) | null = null;
  textInFlight = 0;
  maxTextInFlight = 0;
  deleteReply: (request: DeleteBatchRequest, call: number) => Response | Promise<Response> = (request) =>
    Response.json({ version: 1, outcomes: request.items.map((item) => ({ id: item.id, status: "deleted" })) } satisfies DeleteProgress);
  private deleteCalls = 0;

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
    if (url.pathname === "/all-docs/api/documents" && method === "GET") {
      const index = Number(url.searchParams.get("cursor") ?? 0);
      const last = index >= this.pages.length - 1;
      return Response.json({
        version: 1, items: this.pages[index] ?? [], nextCursor: last ? null : String(index + 1),
        scanComplete: last, observedAt: new Date(NOW).toISOString(),
      });
    }
    const text = /^\/all-docs\/api\/documents\/([A-Za-z0-9]{8})\/text$/.exec(url.pathname);
    if (text && method === "GET") {
      this.textInFlight++;
      this.maxTextInFlight = Math.max(this.maxTextInFlight, this.textInFlight);
      try {
        if (this.textGate) await this.textGate();
      } finally {
        this.textInFlight--;
      }
      const id = text[1];
      const override = this.texts.get(id) ?? {};
      const content = override.text ?? `Body of ${id}: invoice paid`;
      return Response.json({
        version: 1, id, documentVersion: url.searchParams.get("version") ?? "", coverage: "full", reason: null,
        text: content, sourceBytes: content.length, indexedBytes: content.length, extractorVersion: 1, ...override,
      } satisfies TextRecord);
    }
    if (url.pathname === "/all-docs/api/delete" && method === "POST") {
      return this.deleteReply(body as DeleteBatchRequest, ++this.deleteCalls);
    }
    return error(404);
  };

  requests(method: string, prefix: string): Recorded[] {
    return this.recorded.filter((request) => request.method === method && request.path.startsWith(prefix));
  }
}

function error(status: number, retryAfter: string | null = null): Response {
  return Response.json(
    { version: 1, error: { code: `http_${status}`, message: `Failure ${status}`, retryable: false } },
    { status, headers: retryAfter ? { "Retry-After": retryAfter } : {} },
  );
}

interface FakePort extends SearchPort {
  posted: SearchWorkerRequest[];
  terminated: boolean;
  handlers: { message(reply: SearchWorkerResponse): void; failure(reason: string): void };
}

/** In-memory search worker. In auto mode it acknowledges adds and answers literal queries. */
class FakeSearch {
  ports: FakePort[] = [];
  auto = true;
  private readonly corpus = new Map<FakePort, Map<string, { summary: DocumentSummary; text: string }>>();

  readonly open = (handlers: FakePort["handlers"]): SearchPort => {
    const port: FakePort = {
      posted: [], terminated: false, handlers,
      post: (message) => {
        port.posted.push(message);
        if (this.auto) queueMicrotask(() => this.respond(port, message));
      },
      terminate: () => {
        port.terminated = true;
      },
    };
    this.ports.push(port);
    this.corpus.set(port, new Map());
    return port;
  };

  get port(): FakePort {
    return this.ports[this.ports.length - 1];
  }

  respond(port: FakePort, message: SearchWorkerRequest): void {
    if (port.terminated) return;
    const docs = this.corpus.get(port) as Map<string, { summary: DocumentSummary; text: string }>;
    if (message.operation === "add") docs.set(message.summary.id, { summary: message.summary, text: message.text.text });
    if (message.operation === "clear") docs.clear();
    if (message.operation !== "query") {
      port.handlers.message({ version: 1, generation: message.generation, status: "ready" });
      return;
    }
    const needle = message.query.ignoreCase ? message.query.text.toLowerCase() : message.query.text;
    const hits: SearchHit[] = [];
    for (const { summary, text } of docs.values()) {
      const haystack = `${summary.title}\n${text}`;
      const subject = message.query.ignoreCase ? haystack.toLowerCase() : haystack;
      const count = subject.split(needle).length - 1;
      if (count) hits.push({ id: summary.id, version: summary.version, matchCount: count, snippet: haystack.slice(0, 40), ranges: [] });
    }
    port.handlers.message({ version: 1, generation: message.generation, status: "results", hits });
  }

  queries(port = this.port): Extract<SearchWorkerRequest, { operation: "query" }>[] {
    return port.posted.filter((message): message is Extract<SearchWorkerRequest, { operation: "query" }> => message.operation === "query");
  }
}

function setup(pages: DocumentSummary[][], options: { params?: string; now?: () => number } = {}) {
  const catalog = new FakeCatalog();
  catalog.pages = pages;
  const search = new FakeSearch();
  const announcements: string[] = [];
  const client = new CatalogClient(
    { fetch: catalog.fetch, openSearch: search.open, now: options.now ?? (() => NOW), timeZone: "America/Los_Angeles" },
    new URLSearchParams(options.params ?? ""),
  );
  client.onAnnounce((text) => announcements.push(text));
  return { catalog, search, client, announcements };
}

async function until(predicate: () => boolean, label = "condition"): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function ready(client: CatalogClient): Promise<void> {
  await client.start();
  await until(() => client.contentProgress().complete, "scan and indexing");
}

function range(count: number, start = 1): DocumentSummary[] {
  return Array.from({ length: count }, (_, index) => summary(start + index));
}

afterEach(() => {
  vi.useRealTimers();
});

describe("catalog client: session and discovery", () => {
  it("enumerates every cursor page, including empty ones, with read headers and no CSRF token", async () => {
    const { client, catalog } = setup([range(3), [], range(2, 4)]);
    await ready(client);

    expect(client.view).toBe("library");
    expect(client.scan.status).toBe("complete");
    expect(client.observed().map((doc) => doc.id)).toEqual(range(5).map((doc) => doc.id));
    expect(catalog.requests("GET", "/all-docs/api/documents?cursor").map((request) => request.path))
      .toEqual(["/all-docs/api/documents?cursor=1", "/all-docs/api/documents?cursor=2"]);
    for (const request of catalog.recorded.filter((entry) => entry.method === "GET")) {
      expect(request.headers["x-docs-catalog"]).toBe("1");
      expect(request.headers["x-csrf-token"]).toBeUndefined();
      expect(request.init.credentials).toBe("same-origin");
      expect(request.init.cache).toBe("no-store");
    }
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

  it("marks the scan incomplete instead of silently skipping an unreadable entry", async () => {
    const broken = { ...summary(2), uploadedAt: "not a date" };
    const { client } = setup([[summary(1), broken], range(1, 3)]);
    await client.start();
    await until(() => client.scan.status !== "running");

    expect(client.scan.status).toBe("incomplete");
    expect(client.selectAllGate()).toEqual({ ok: false, reason: "Unavailable because the storage scan is incomplete" });
  });

  it("lock clears every document, terminates the worker and ends the session with the CSRF token", async () => {
    const { client, catalog, search } = setup([range(4)]);
    await ready(client);
    client.setFilters({ text: "invoice" });
    const worker = search.port;

    await client.lock();

    expect(client.view).toBe("login");
    expect(client.observed()).toEqual([]);
    expect(client.results().visible).toEqual([]);
    expect(client.filters.text).toBe("");
    expect(worker.terminated).toBe(true);
    expect(worker.posted.at(-1)?.operation).toBe("clear");
    const logout = catalog.requests("DELETE", "/all-docs/session")[0];
    expect(logout.headers["x-csrf-token"]).toBe("csrf-token-1");
    expect(logout.headers["x-docs-catalog"]).toBe("1");
  });

  it("drops text that arrives after lock instead of indexing it", async () => {
    const { client, catalog, search } = setup([range(2)]);
    let release!: () => void;
    catalog.textGate = () => new Promise<void>((resolve) => { release = resolve; });
    await client.start();
    await until(() => catalog.textInFlight > 0, "text request");
    const worker = search.port;

    await client.lock();
    release();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(worker.posted.filter((message) => message.operation === "add")).toEqual([]);
    expect(client.observed()).toEqual([]);
  });

  it("returns to login with the query kept when the session expires during a read", async () => {
    const catalog = new FakeCatalog();
    catalog.pages = [range(1), range(1, 2)];
    const expiring = async (input: string, init?: RequestInit) =>
      input.includes("cursor=1") ? error(401) : catalog.fetch(input, init);
    const client = new CatalogClient(
      { fetch: expiring, openSearch: new FakeSearch().open, now: () => NOW },
      new URLSearchParams("q=invoice"),
    );
    await client.start();
    await until(() => client.view === "login");
    expect(client.login.problem).toBe("expired");
    expect(client.filters.text).toBe("invoice");
    expect(client.observed()).toEqual([]);
  });
});

describe("catalog client: extraction and search generations", () => {
  it("extracts with at most three concurrent requests and posts each record once", async () => {
    const { client, catalog, search } = setup([range(10)]);
    catalog.textGate = () => new Promise((resolve) => setTimeout(resolve, 5));
    await ready(client);

    expect(catalog.maxTextInFlight).toBe(TEXT_CONCURRENCY);
    const adds = search.port.posted.filter((message) => message.operation === "add");
    expect(adds).toHaveLength(10);
    expect(new Set(adds.map((message) => message.generation)).size).toBe(10);
    for (const request of catalog.requests("GET", "/all-docs/api/documents/doc")) {
      const id = /documents\/(\w+)\/text/.exec(request.path)?.[1];
      expect(request.path).toBe(`/all-docs/api/documents/${id}/text?version=v1-${id}`);
    }
    expect(client.contentProgress()).toMatchObject({ total: 10, searched: 10, complete: true });
  });

  it("keeps one query in flight, ignores obsolete generations and applies only the latest pattern", async () => {
    const { client, search } = setup([range(3)]);
    await ready(client);
    search.auto = false;

    client.setFilters({ text: "in" });
    client.setFilters({ text: "inv" });
    client.setFilters({ text: "invoice" });
    const port = search.port;
    let queries = search.queries(port);
    expect(queries.map((query) => query.query.text)).toEqual(["in"]);
    expect(queries[0].filter.uploadedBefore).toBeNull();

    // An unrelated generation is ignored outright.
    port.handlers.message({ version: 1, generation: 999_999, status: "results", hits: [] });
    expect(client.search.status).toBe("pending");

    // The reply to the superseded "in" is discarded; the latest pattern goes out next.
    const hit = (id: string): SearchHit => ({ id, version: `v1-${id}`, matchCount: 2, snippet: "invoice", ranges: [[0, 7]] });
    port.handlers.message({ version: 1, generation: queries[0].generation, status: "results", hits: [hit("doc00001")] });
    expect(client.search.hits).toBeNull();
    queries = search.queries(port);
    expect(queries.map((query) => query.query.text)).toEqual(["in", "invoice"]);

    port.handlers.message({ version: 1, generation: queries[1].generation, status: "results", hits: [hit("doc00002")] });
    expect(client.results().matching.map((doc) => doc.id)).toEqual(["doc00002"]);
    expect(client.selectAllGate()).toEqual({ ok: true, count: 1 });
  });

  it("shows a worker error for the current pattern and keeps the last valid results", async () => {
    const { client, search } = setup([range(3)]);
    await ready(client);
    client.setFilters({ text: "invoice" });
    await until(() => client.search.status === "ready");
    search.auto = false;

    client.setFilters({ text: "(?=x)", regex: true });
    const query = search.queries().at(-1) as Extract<SearchWorkerRequest, { operation: "query" }>;
    expect(query.query).toEqual({ text: "(?=x)", mode: "regex", ignoreCase: true });
    search.port.handlers.message({ version: 1, generation: query.generation, status: "error", code: "invalid_pattern", message: "Lookaround is not supported." });

    expect(client.search).toMatchObject({ status: "error", message: "Lookaround is not supported." });
    expect(client.search.hits?.size).toBe(3);
    expect(client.selectAllGate()).toEqual({ ok: false, reason: "Unavailable while the search reports an error" });
  });

  it("abandons a query after the budget, restarts the worker and refuses select-all for it", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { client, search } = setup([range(2)]);
    await client.start();
    await vi.advanceTimersByTimeAsync(50);
    expect(client.contentProgress().complete).toBe(true);
    const first = search.port;
    search.auto = false;

    client.setFilters({ text: "invoice" });
    await vi.advanceTimersByTimeAsync(QUERY_BUDGET_MS + 1);

    expect(first.terminated).toBe(true);
    expect(search.ports).toHaveLength(2);
    expect(client.search.status).toBe("timeout");
    expect(client.selectAllGate()).toMatchObject({ ok: false });
    // The rebuilt worker re-indexes from the catalog; the abandoned pattern is not retried.
    search.auto = true;
    await vi.advanceTimersByTimeAsync(500);
    expect(search.port.posted.filter((message) => message.operation === "add")).toHaveLength(2);
    expect(search.queries(search.port)).toEqual([]);
    expect(client.selectAllGate()).toEqual({ ok: false, reason: "Unavailable because this search stopped early" });
  });

  it("stops indexing visibly at the in-tab text budget and settles the queue as skipped", async () => {
    const { client, catalog } = setup([range(6)]);
    catalog.texts.set("doc00001", { indexedBytes: 40 * 1024 * 1024 });
    await client.start();
    await until(() => client.contentProgress().settled === 6, "every document settled");
    client.setFilters({ text: "invoice" });

    // doc00001 trips the budget; 2 and 3 were already in flight; 4–6 never leave the queue.
    expect(client.contentProgress()).toMatchObject({ searched: 2, skipped: 4, complete: true, budgetExceeded: true });
    expect(catalog.requests("GET", "/all-docs/api/documents/doc").length).toBe(3);
    expect(client.selectAllGate()).toEqual({ ok: false, reason: "Unavailable: the library exceeds this tab's search budget" });
  });

  it("settles queued documents as failed when the worker crashes instead of leaving them pending", async () => {
    const { client, catalog, search } = setup([range(6)]);
    const held: (() => void)[] = [];
    catalog.textGate = () => new Promise<void>((resolve) => { held.push(resolve); });
    await client.start();
    await until(() => catalog.textInFlight === 3, "three text requests");
    search.port.handlers.failure("Content search stopped working in this tab.");
    for (const release of held) release();
    await until(() => client.contentProgress().settled === 6, "every document settled");

    expect(client.contentProgress()).toMatchObject({ failed: 6, complete: true });
    client.setFilters({ text: "invoice" });
    expect(client.search).toMatchObject({ status: "unavailable", message: "Content search stopped working in this tab." });
    expect(client.selectAllGate()).toEqual({ ok: false, reason: "Unavailable while content search is down" });
  });
});

describe("catalog client: filters", () => {
  it("freezes the age cutoff: strict before for older-than, inclusive for last N days", async () => {
    let clock = NOW;
    const older = summary(1, { uploadedAt: new Date(NOW - 90 * DAY - 60_000).toISOString() });
    const newer = summary(2, { uploadedAt: new Date(NOW - 90 * DAY + 60_000).toISOString() });
    const { client } = setup([[older, newer]], { now: () => clock });
    await ready(client);

    client.setFilters({ age: "gt90" });
    expect(client.results().matching.map((doc) => doc.id)).toEqual([older.id]);
    expect(client.results().olderThan90).toBe(1);
    expect(client.cutoffLine()).toBe("Uploaded before Jul 16, 2026, 9:16 PM PDT · cutoff fixed at 9:16 PM");

    // Time passes: the frozen cutoff does not drift until the user resets it.
    clock = NOW + 5 * 60_000;
    expect(client.results().matching.map((doc) => doc.id)).toEqual([older.id]);
    client.resetCutoff();
    expect(client.results().matching.map((doc) => doc.id)).toEqual([newer.id, older.id]);

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

  it("counts types over every other filter and sorts with newest-then-ID tie breaks", async () => {
    const docs = [
      summary(1, { kind: "pdf", sizeBytes: 50 }),
      summary(2, { kind: "pdf", sizeBytes: 900 }),
      summary(3, { kind: "image", sizeBytes: 900 }),
    ];
    const { client } = setup([docs]);
    await ready(client);

    client.setFilters({ kinds: ["pdf"], sort: "largest" });
    const results = client.results();
    expect(results.matching.map((doc) => doc.id)).toEqual(["doc00002", "doc00001"]);
    expect(Object.fromEntries(results.kindCounts)).toEqual({ pdf: 2, image: 1 });
  });
});

describe("catalog client: selection", () => {
  it("keeps explicit refs across filter changes and reports how many are hidden", async () => {
    const { client } = setup([[summary(1, { kind: "pdf" }), summary(2), summary(3)]]);
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

  it("refuses select-all while the scan is still running", async () => {
    const catalog = new FakeCatalog();
    catalog.pages = [range(2), range(2, 3)];
    let release!: () => void;
    const gated = new Promise<void>((resolve) => { release = resolve; });
    const slowSecondPage = async (input: string, init?: RequestInit) => {
      if (input.includes("cursor=1")) await gated;
      return catalog.fetch(input, init);
    };
    const client = new CatalogClient({ fetch: slowSecondPage, openSearch: new FakeSearch().open, now: () => NOW });
    void client.start();
    await until(() => client.observed().length === 2);

    expect(client.selectAllGate()).toEqual({ ok: false, reason: "Available when the scan finishes (2 found so far)" });
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
    expect(review?.totalBytes).toBe(docs.reduce((sum, doc) => sum + doc.sizeBytes, 0));
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
      expect(request.headers["x-csrf-token"]).toBe("csrf-token-1");
      expect(request.headers["x-docs-catalog"]).toBe("1");
    }
    const sent = batches.flatMap((request) => (request.body as DeleteBatchRequest).items);
    expect(sent).toEqual([...docs].reverse().map((doc) => ({ id: doc.id, version: doc.version })));
    expect(client.review?.phase).toBe("complete");

    client.closeReview();
    expect(client.observed()).toEqual([]);
    expect(client.selection.scope).toBe("none");
  });

  it("never recomputes the age predicate after review, even if new documents now match", async () => {
    let clock = NOW;
    const old = summary(1, { uploadedAt: new Date(NOW - 100 * DAY).toISOString() });
    const borderline = summary(2, { uploadedAt: new Date(NOW - 89 * DAY).toISOString() });
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
    for (const doc of docs) client.toggle(doc.id);
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
    const { client, catalog, search } = setup([docs]);
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
    expect(search.port.terminated).toBe(true);
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
