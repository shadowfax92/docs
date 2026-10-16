/**
 * Query plane of the private catalog: turns the user's latest search input into authenticated
 * POSTs against the persistent (D1) library index and holds the compact results for rendering.
 * catalog-client.ts owns one instance per signed-in session and supplies the transport; app.ts
 * never sees this module directly.
 *
 *   setQuery ─ debounce 200 ms ─► lane: at most ONE request in flight, search before snippets
 *     POST /all-docs/api/search   {query, filter, cursor?} ─► (id, version, count) deltas, accumulated
 *                                                              until complete (progressive scans)
 *     POST /all-docs/api/snippets {generation, query, ≤48 visible refs} ─► snippet | unavailable,
 *                                                              `remaining` refs are asked again
 *
 * Why one lane: aborting a browser fetch does not cancel the D1 statement behind it, so a newer
 * keystroke never starts a second request while one is still running on the server. It waits, the
 * older reply is discarded, and only the latest input is sent (intermediate inputs never are).
 *
 * Ownership of replies: each input gets a fresh `Run`. A reply is applied only while its run is
 * still the current one, so obsolete hits, continuations and snippets can never overwrite newer
 * input. A run's first reply fixes its generation; continuations and snippets must match it, and
 * a stale generation discards the run's partial slices and restarts it a bounded number of times
 * (never an endless loop). dispose() (lock, expiry) aborts the owned request and makes the
 * instance inert, so a late reply cannot bring private hits or snippets back.
 */
import {
  LIBRARY_ENDPOINTS, LIBRARY_LIMITS,
  type DocumentFilter, type LibraryErrorResponse, type LibraryHit, type LibrarySearchRequest, type LibrarySearchResponse,
  type LibrarySnippetsRequest, type LibraryStatus, type SearchQuery, type SelectionRef,
} from "../library-contracts";

/** Quiet period after the last edit before a query is sent. */
export const SEARCH_DEBOUNCE_MS = 200;
/**
 * A request still unanswered after this long is abandoned so the lane cannot hang forever on a dead
 * connection. Server slices stop after about one second, so this only fires on a broken network;
 * it does not cancel server work, which is why a timed-out run waits for an explicit retry.
 */
export const REQUEST_TIMEOUT_MS = 20_000;
/** Fresh restarts allowed after a stale generation, per input. Past this the failure is shown. */
export const MAX_STALE_RESTARTS = 2;
const TOO_BROAD = "This search matches too many documents to finish. Make it more specific.";
/** Snippet replies in a row that process nothing before the lane stops asking for this run. */
const MAX_SNIPPET_STALLS = 2;
const ID_PATTERN = /^[A-Za-z0-9]{8}$/;
const encoder = new TextEncoder();

/**
 * Search requests always cover every kind and upload date. Type and age filtering happens in the
 * client over the metadata snapshot, so filter toggles never cost a D1 query and the type rail and
 * age chip can keep counting the alternatives. Matching more than LIBRARY_LIMITS.hits documents
 * is reported as a budget error rather than truncated.
 */
function allDocuments(): DocumentFilter {
  return { kinds: [], uploadedBefore: null, uploadedAfter: null };
}

export interface LibrarySearchDeps {
  /** POSTs JSON on the catalog origin with the session's headers; rejects on network failure/abort. */
  post(path: string, body: unknown, signal: AbortSignal): Promise<{ status: number; body: unknown }>;
  /** Refs of rendered result cards in display order, or [] while snippets should wait. */
  visible(): SelectionRef[];
  /** A 401 reply: the owner ends the session, which disposes this instance. */
  unauthorized(): void;
  changed(): void;
}

export type SearchFailure =
  | { kind: "pattern"; message: string }     // Invalid pattern or request: edit the query.
  | { kind: "budget"; message: string }      // Too broad to finish: narrow the query.
  | { kind: "unavailable"; message: string } // Retryable backend or network failure.
  | { kind: "changing"; message: string };   // Stale generation after every allowed restart.

export type Snippet =
  | { version: string; status: "ready"; snippet: string; ranges: [number, number][] }
  | { version: string; status: "unavailable" };

/** Results of one input as rendered: partial while `complete` is false. */
export interface HeldResults {
  readonly key: string;
  readonly query: SearchQuery;
  readonly hits: ReadonlyMap<string, LibraryHit>;
  readonly complete: boolean;
  readonly generation: number;
}

/**
 * - idle: no query text.
 * - pending: the latest input has no reply yet (debouncing, queued behind an older request, or sent).
 * - scanning: a progressive scan has returned partial results and continues automatically.
 * - complete / error: final for the latest input.
 */
export type SearchPhase = "idle" | "pending" | "scanning" | "complete" | "error";

interface Run {
  readonly key: string;
  readonly query: SearchQuery;
  readonly hits: Map<string, LibraryHit>;
  readonly snippets: Map<string, Snippet>;
  restarts: number;
  started: boolean;
  complete: boolean;
  cursor: string | null;
  generation: number;
  failure: SearchFailure | null;
  snippetFailure: string | null;
  snippetStalls: number;
}

interface Flight { run: Run; controller: AbortController }
type Reply = { status: number; body: unknown } | null;

export function searchKey(query: SearchQuery): string {
  return JSON.stringify([query.mode, query.ignoreCase, query.text]);
}

export class LibrarySearch {
  /** Key of the latest input, or null without query text. */
  wanted: string | null = null;
  /** Freshest index status any reply reported. */
  status: LibraryStatus | null = null;
  /** Highest generation any reply reported, compared with the metadata snapshot by the owner. */
  latestGeneration: number | null = null;

  private run: Run | null = null;
  private held: Run | null = null;
  private inflight: Flight | null = null;
  private debounce: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(private readonly deps: LibrarySearchDeps) {}

  get phase(): SearchPhase {
    const run = this.run;
    if (this.wanted === null || !run) return "idle";
    if (run.failure) return "error";
    if (!run.started) return "pending";
    return run.complete ? "complete" : "scanning";
  }

  /** Failure of the latest input, if any. Held results of an earlier input may still be shown. */
  get failure(): SearchFailure | null {
    return this.run?.failure ?? null;
  }

  get snippetFailure(): string | null {
    return this.held === this.run ? this.run?.snippetFailure ?? null : null;
  }

  /** What the grid shows: the latest input's results, or an earlier input's until they arrive. */
  get results(): HeldResults | null {
    return this.held;
  }

  snippet(id: string, version: string): Snippet | null {
    const snippet = this.held?.snippets.get(id);
    return snippet && snippet.version === version ? snippet : null;
  }

  /**
   * Declares the latest input. Edits are debounced; `immediate` (opening a session with a query in
   * the URL) sends at once when the lane is free. An unchanged key keeps the current run.
   */
  setQuery(query: SearchQuery | null, immediate = false): void {
    if (this.disposed) return;
    const key = query && query.text ? searchKey(query) : null;
    if (key === this.wanted) return;
    this.wanted = key;
    this.clearDebounce();
    if (!query || key === null) {
      this.run = null;
      this.held = null; // Nothing to show without a query; drop hits and snippets.
      return this.deps.changed();
    }
    this.run = newRun(key, { text: query.text, mode: query.mode, ignoreCase: query.ignoreCase });
    if (encoder.encode(query.text).length > LIBRARY_LIMITS.queryBytes) {
      this.run.failure = { kind: "pattern", message: `Search text is limited to ${LIBRARY_LIMITS.queryBytes} bytes.` };
      return this.deps.changed();
    }
    if (immediate) this.pump();
    else this.debounce = setTimeout(() => {
      this.debounce = null;
      this.pump();
      this.deps.changed();
    }, SEARCH_DEBOUNCE_MS);
    this.deps.changed();
  }

  /** Refresh: forget held results and generations, then search the latest input again. */
  restart(): void {
    if (this.disposed) return;
    this.held = null;
    this.latestGeneration = null;
    this.status = null;
    if (this.run) this.run = newRun(this.run.key, this.run.query);
    this.pump();
    this.deps.changed();
  }

  /** Retries a failed latest input (resuming a progressive scan from its cursor) or its snippets. */
  retry(): void {
    const run = this.run;
    if (this.disposed || !run) return;
    if (run.failure?.kind === "changing") {
      if (this.held === run) this.held = null;
      this.run = newRun(run.key, run.query);
    } else if (run.failure?.kind === "unavailable") {
      run.failure = null;
    }
    run.snippetFailure = null;
    run.snippetStalls = 0;
    this.pump();
    this.deps.changed();
  }

  /** The rendered result cards changed (scan finished, show more, sort or filter change). */
  demandChanged(): void {
    this.pump();
  }

  /** Lock or expiry: abort the owned request, drop every hit and snippet, and ignore late replies. */
  dispose(): void {
    this.disposed = true;
    this.clearDebounce();
    this.inflight?.controller.abort();
    this.inflight = null;
    this.run = null;
    this.held = null;
    this.status = null;
    this.latestGeneration = null;
  }

  // ------------------------------------------------------------------------------------------

  /** Starts the next request when the lane is free: search work first, then missing snippets. */
  private pump(): void {
    if (this.disposed || this.inflight || this.debounce !== null) return;
    const run = this.run;
    if (!run || run.failure) return;
    if (!run.complete) {
      const cursor = run.started ? run.cursor ?? undefined : undefined;
      const body: LibrarySearchRequest = { version: 1, query: run.query, filter: allDocuments(), cursor };
      return this.send(run, LIBRARY_ENDPOINTS.search, body, (reply) => this.onSearch(run, cursor ?? null, reply));
    }
    if (this.held !== run || run.snippetFailure) return;
    const refs: SelectionRef[] = [];
    for (const ref of this.deps.visible()) {
      if (refs.length === LIBRARY_LIMITS.snippetRefs) break;
      if (run.hits.get(ref.id)?.version !== ref.version || run.snippets.has(ref.id)) continue;
      if (!refs.some((other) => other.id === ref.id)) refs.push({ id: ref.id, version: ref.version });
    }
    if (!refs.length) return;
    const body: LibrarySnippetsRequest = { version: 1, generation: run.generation, query: run.query, refs };
    this.send(run, LIBRARY_ENDPOINTS.snippets, body, (reply) => this.onSnippets(run, refs, reply));
  }

  private send(run: Run, path: string, body: unknown, apply: (reply: Reply) => void): void {
    const flight: Flight = { run, controller: new AbortController() };
    this.inflight = flight;
    const timer = setTimeout(() => flight.controller.abort(), REQUEST_TIMEOUT_MS);
    const settle = (reply: Reply) => {
      clearTimeout(timer);
      if (this.disposed || this.inflight !== flight) return;
      this.inflight = null;
      // Superseded runs (newer input, refresh, stale restart) drop their reply unread.
      if (this.run === run) apply(reply);
      // Render first, so snippet demand is read from the grid this reply produced.
      this.deps.changed();
      this.pump();
    };
    this.deps.post(path, body, flight.controller.signal).then(settle, () => settle(null));
  }

  private onSearch(run: Run, sent: string | null, reply: Reply): void {
    if (!reply) return this.fail(run, unreachable(run));
    if (reply.status === 401) return this.deps.unauthorized();
    if (reply.status !== 200) {
      const error = libraryError(reply.body);
      if (reply.status === 409 || error?.code === "stale_generation" || error?.code === "invalid_cursor") return this.stale(run);
      if (reply.status === 400 || error?.code === "invalid_pattern" || error?.code === "invalid_search_request") {
        return this.fail(run, { kind: "pattern", message: error?.message ?? "This pattern can't be searched." });
      }
      if (reply.status === 422 || error?.code === "search_budget_exceeded") {
        // Own copy: the server may suggest narrowing filters, but type and age never reach it here.
        return this.fail(run, { kind: "budget", message: TOO_BROAD });
      }
      return this.fail(run, { kind: "unavailable", message: error?.message ?? `Search is unavailable right now (HTTP ${reply.status}).` });
    }
    const page = parseSearchResponse(reply.body);
    if (!page) return this.fail(run, { kind: "unavailable", message: "The library returned an unreadable search response." });
    // A continuation answered under another generation would mix two library states.
    if (run.started && page.generation !== run.generation) return this.stale(run);
    if (!page.complete && page.nextCursor === sent) {
      return this.fail(run, { kind: "unavailable", message: "The search stopped making progress. Try again." });
    }
    for (const hit of page.hits) run.hits.set(hit.id, { id: hit.id, version: hit.version, matchCount: hit.matchCount });
    if (run.hits.size > LIBRARY_LIMITS.hits) {
      run.hits.clear();
      return this.fail(run, { kind: "budget", message: TOO_BROAD });
    }
    run.started = true;
    run.generation = page.generation;
    run.complete = page.complete;
    run.cursor = page.nextCursor;
    this.observe(page.generation, page.status);
    this.held = run;
  }

  private onSnippets(run: Run, refs: SelectionRef[], reply: Reply): void {
    if (!reply) {
      run.snippetFailure = "Couldn't reach the library for match previews.";
      return;
    }
    if (reply.status === 401) return this.deps.unauthorized();
    if (reply.status !== 200) {
      const error = libraryError(reply.body);
      if (reply.status === 409 || error?.code === "stale_generation") return this.stale(run);
      run.snippetFailure = error?.message ?? `Match previews are unavailable right now (HTTP ${reply.status}).`;
      return;
    }
    const page = parseSnippetsResponse(reply.body);
    if (!page) {
      run.snippetFailure = "The library returned unreadable match previews.";
      return;
    }
    if (page.generation !== run.generation) return this.stale(run);
    this.observe(page.generation, null);
    const asked = new Map(refs.map((ref) => [ref.id, ref.version]));
    let processed = 0;
    const take = (id: string, version: string, snippet: Snippet) => {
      if (asked.get(id) !== version || run.snippets.has(id)) return;
      run.snippets.set(id, snippet);
      processed++;
    };
    for (const hit of page.hits) {
      take(hit.id, hit.version, { version: hit.version, status: "ready", snippet: hit.snippet, ranges: validRanges(hit.ranges, hit.snippet) });
    }
    for (const ref of page.unavailable) take(ref.id, ref.version, { version: ref.version, status: "unavailable" });
    // `remaining` refs stay unfetched and are asked again on the next pump: they are not misses.
    run.snippetStalls = processed ? 0 : run.snippetStalls + 1;
    if (run.snippetStalls >= MAX_SNIPPET_STALLS) run.snippetFailure = "Some match previews couldn't be loaded.";
  }

  /** The library moved under this run: drop partial slices and start over, a bounded number of times. */
  private stale(run: Run): void {
    if (run.restarts >= MAX_STALE_RESTARTS) {
      return this.fail(run, { kind: "changing", message: "The library kept changing during this search. Refresh, then try again." });
    }
    const next = newRun(run.key, run.query);
    next.restarts = run.restarts + 1;
    // Complete results stay visible until replaced: they are consistent for their generation.
    if (this.held === run && !run.complete) this.held = null;
    this.run = next;
  }

  private fail(run: Run, failure: SearchFailure): void {
    run.failure = failure;
  }

  private observe(generation: number, status: LibraryStatus | null): void {
    if (this.latestGeneration === null || generation > this.latestGeneration) this.latestGeneration = generation;
    if (status) this.status = status;
  }

  private clearDebounce(): void {
    if (this.debounce !== null) clearTimeout(this.debounce);
    this.debounce = null;
  }
}

function newRun(key: string, query: SearchQuery): Run {
  return {
    key, query, hits: new Map(), snippets: new Map(), restarts: 0, started: false, complete: false, cursor: null,
    generation: -1, failure: null, snippetFailure: null, snippetStalls: 0,
  };
}

function unreachable(run: Run): SearchFailure {
  return { kind: "unavailable", message: run.started ? "Couldn't reach the library to continue this search." : "Couldn't reach the library to search." };
}

// ---------------------------------------------------------------------------------------------
// Wire validation. Replies are untrusted JSON: a malformed hit fails the whole reply rather than
// being skipped, because silently dropping one would make a "complete" result a lie.

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export const isGeneration = isCount;

function isRef(value: unknown): value is SelectionRef {
  return isRecord(value) && typeof value.id === "string" && ID_PATTERN.test(value.id)
    && typeof value.version === "string" && value.version.length > 0;
}

export function isLibraryStatus(value: unknown): value is LibraryStatus {
  if (!isRecord(value) || !isRecord(value.counts) || !isRecord(value.storage)) return false;
  const counts = value.counts;
  const storage = value.storage;
  return ["documents", "pending", "indexed", "failed", "metadataOnly", "truncated"].every((name) => isCount(counts[name]))
    && (value.lastReconciledAt === null || typeof value.lastReconciledAt === "string") && isCount(value.anomalies)
    && isCount(storage.bytes) && isCount(storage.budgetBytes) && typeof storage.paused === "boolean"
    && (storage.planningBytes === null || isCount(storage.planningBytes))
    && (storage.projectedBytes === null || isCount(storage.projectedBytes))
    && (storage.reason === null || typeof storage.reason === "string");
}

function parseSearchResponse(value: unknown): LibrarySearchResponse | null {
  if (!isRecord(value) || value.version !== 1 || !isGeneration(value.generation) || typeof value.complete !== "boolean"
    || !Array.isArray(value.hits) || !isRecord(value.scope) || !isLibraryStatus(value.status)) return null;
  // complete:false requires a continuation and complete:true forbids one (frozen contract).
  if (value.complete ? value.nextCursor !== null : typeof value.nextCursor !== "string" || value.nextCursor === "") return null;
  if (!value.hits.every((hit) => isRef(hit) && isCount((hit as LibraryHit).matchCount))) return null;
  return value as unknown as LibrarySearchResponse;
}

interface SnippetsReply { generation: number; hits: { id: string; version: string; snippet: string; ranges: unknown }[]; unavailable: SelectionRef[] }

function parseSnippetsResponse(value: unknown): SnippetsReply | null {
  if (!isRecord(value) || value.version !== 1 || !isGeneration(value.generation) || !Array.isArray(value.hits)
    || !Array.isArray(value.unavailable) || !Array.isArray(value.remaining)) return null;
  if (!value.hits.every((hit) => isRef(hit) && typeof (hit as { snippet?: unknown }).snippet === "string")) return null;
  if (!value.unavailable.every(isRef) || !value.remaining.every(isRef)) return null;
  return value as unknown as SnippetsReply;
}

/** Keeps ordered, non-overlapping integer UTF-16 ranges inside the snippet; drops anything else. */
function validRanges(ranges: unknown, text: string): [number, number][] {
  if (!Array.isArray(ranges)) return [];
  const valid: [number, number][] = [];
  for (const range of ranges) {
    if (!Array.isArray(range) || range.length !== 2) continue;
    const [start, end] = range as unknown[];
    if (!Number.isInteger(start) || !Number.isInteger(end)) continue;
    if ((start as number) < 0 || (end as number) <= (start as number) || (end as number) > text.length) continue;
    valid.push([start as number, end as number]);
  }
  valid.sort((a, b) => a[0] - b[0]);
  const kept: [number, number][] = [];
  for (const range of valid) if (!kept.length || range[0] >= kept[kept.length - 1][1]) kept.push(range);
  return kept;
}

export function libraryError(value: unknown): LibraryErrorResponse["error"] | null {
  if (!isRecord(value) || !isRecord(value.error)) return null;
  const { code, message, retryable } = value.error;
  return typeof code === "string" && typeof message === "string"
    ? { code: code as LibraryErrorResponse["error"]["code"], message, retryable: retryable === true }
    : null;
}
