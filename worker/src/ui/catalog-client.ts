/**
 * Catalog client: the browser-side model of the private library at /all-docs.
 *
 * It owns everything between the catalog's inert JSON routes and the DOM: the in-memory session
 * token, full cursor discovery, bounded text extraction into the search Web Worker, query
 * generations, filters/sort/URL state, the global selection and the frozen delete review.
 * app.ts renders `CatalogClient` state and forwards intent; it never speaks HTTP or postMessage.
 *
 *   catalog origin (same-origin fetch)                    search Web Worker (postMessage)
 *   GET  /all-docs/session ─ csrfToken, expiresAt
 *   GET  /all-docs/api/documents?cursor ─ every page ─► observed set
 *   GET  /all-docs/api/documents/:id/text?version (≤3) ───────► add(gen) ─► ready(gen)
 *   filters / query ──────────────────────────────────────────► query(gen) ─► results(gen)
 *   review ─► POST /all-docs/api/delete  (≤100 frozen refs per batch, sequential, oldest first)
 *
 * Safety invariants: a delete only ever sends ID/version refs frozen when the review opened; no
 * filter is re-evaluated after that. "Select all matching" is refused until discovery, indexing
 * and the current search are complete. Extracted text lives only in transit to the worker and in
 * the worker; nothing is persisted. lock()/expiry abort requests, terminate the worker and drop
 * every document, so obsolete async replies are discarded by epoch and generation checks.
 */
import { MAX_DELETE_BATCH_ITEMS } from "../contracts";
import type {
  CatalogError, CatalogPage, Coverage, DeleteBatchRequest, DeleteProgress, DocumentFilter,
  DocumentSummary, FileKind, SelectionRef, SessionResponse, TextRecord, UploadId,
} from "../contracts";
import type { SearchHit, SearchQuery, SearchWorkerRequest, SearchWorkerResponse } from "../search";

export const FILE_KINDS: readonly FileKind[] = [
  "html", "markdown", "text", "data", "pdf", "image", "audio", "video", "archive", "office", "binary",
];
export const KIND_LABEL: Record<FileKind, string> = {
  html: "HTML", markdown: "Markdown", text: "Text", data: "Data", pdf: "PDF", image: "Image",
  audio: "Audio", video: "Video", archive: "Archive", office: "Office", binary: "File",
};

/** Cards are revealed 48 at a time: it divides evenly into 2, 3, 4 and 6 columns. */
export const RENDER_STEP = 48;
/** At most three text extractions per tab, matching the catalog's per-tab body-read budget. */
export const TEXT_CONCURRENCY = 3;
/** In-tab text budget. Reaching it stops indexing visibly; it never silently drops documents. */
export const TEXT_BUDGET_BYTES = 32 * 1024 * 1024;
/** A query the worker has not answered in this time is abandoned and the worker restarted. */
export const QUERY_BUDGET_MS = 2_000;
const REQUERY_DELAY_MS = 150;
const DAY_MS = 86_400_000;

export type AgePreset = "any" | "lt7" | "lt30" | "lt90" | "gt30" | "gt90" | "gt365" | "range";
export const AGE_PRESETS: readonly { value: AgePreset; label: string; days?: number; older?: boolean }[] = [
  { value: "any", label: "Any time" },
  { value: "lt7", label: "Last 7 days", days: 7 },
  { value: "lt30", label: "Last 30 days", days: 30 },
  { value: "lt90", label: "Last 90 days", days: 90 },
  { value: "gt30", label: "Older than 30 days", days: 30, older: true },
  { value: "gt90", label: "Older than 90 days", days: 90, older: true },
  { value: "gt365", label: "Older than 1 year", days: 365, older: true },
  { value: "range", label: "Date range…" },
];

export type SortKey = "newest" | "oldest" | "largest" | "name" | "matches";
export const SORT_LABEL: Record<SortKey, string> = {
  newest: "Newest", oldest: "Oldest", largest: "Largest", name: "Name A–Z", matches: "Most matches",
};

/** Everything that defines the matching set. Mirrors the URL query; never holds the cutoff instant. */
export interface Filters {
  text: string;
  regex: boolean;
  matchCase: boolean;
  kinds: FileKind[];
  age: AgePreset;
  from: string; // Local calendar date (YYYY-MM-DD) for "range", inclusive.
  to: string;   // Local calendar date (YYYY-MM-DD) for "range", inclusive through local midnight next day.
  sort: SortKey | null; // null: "matches" while searching, otherwise "newest".
}
export const DEFAULT_FILTERS: Filters = {
  text: "", regex: false, matchCase: false, kinds: [], age: "any", from: "", to: "", sort: null,
};

// ---------------------------------------------------------------------------------------------
// Pure helpers: URL state, age windows and the copy shared by the toolbar and the review.

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Parses `/all-docs?q=&re=1&case=1&kind=pdf,markdown&age=gt90&from=&to=&sort=` defensively. */
export function filtersFromParams(params: URLSearchParams): Filters {
  const kinds = (params.get("kind") ?? "").split(",").filter((kind): kind is FileKind =>
    (FILE_KINDS as readonly string[]).includes(kind));
  const age = params.get("age");
  const sort = params.get("sort");
  const from = params.get("from") ?? "";
  const to = params.get("to") ?? "";
  return {
    text: params.get("q") ?? "",
    regex: params.get("re") === "1",
    matchCase: params.get("case") === "1",
    kinds: [...new Set(kinds)],
    age: AGE_PRESETS.some((preset) => preset.value === age) ? age as AgePreset : "any",
    from: localMidnight(from) === null ? "" : from,
    to: localMidnight(to) === null ? "" : to,
    sort: sort && Object.hasOwn(SORT_LABEL, sort) ? sort as SortKey : null,
  };
}

/** Inverse of filtersFromParams. The frozen cutoff and the selection are deliberately absent. */
export function filtersToParams(filters: Filters): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.text) params.set("q", filters.text);
  if (filters.regex) params.set("re", "1");
  if (filters.matchCase) params.set("case", "1");
  if (filters.kinds.length) params.set("kind", filters.kinds.join(","));
  if (filters.age !== "any") params.set("age", filters.age);
  if (filters.age === "range" && filters.from) params.set("from", filters.from);
  if (filters.age === "range" && filters.to) params.set("to", filters.to);
  if (filters.sort) params.set("sort", filters.sort);
  return params;
}

/** Upload-time window in epoch ms: `after` is inclusive, `before` is strict (DocumentFilter). */
export interface AgeWindow { after: number | null; before: number | null }

export function ageWindow(filters: Pick<Filters, "age" | "from" | "to">, frozenNow: number): AgeWindow {
  if (filters.age === "range") {
    const after = localMidnight(filters.from);
    const to = localMidnight(filters.to);
    return { after, before: to === null ? null : nextLocalMidnight(filters.to) };
  }
  const preset = AGE_PRESETS.find((candidate) => candidate.value === filters.age);
  if (!preset?.days) return { after: null, before: null };
  const bound = frozenNow - preset.days * DAY_MS;
  return preset.older ? { after: null, before: bound } : { after: bound, before: null };
}

export function inWindow(uploadedAt: number, window: AgeWindow): boolean {
  return (window.after === null || uploadedAt >= window.after)
    && (window.before === null || uploadedAt < window.before);
}

export function toDocumentFilter(window: AgeWindow, kinds: FileKind[]): DocumentFilter {
  return {
    kinds: [...kinds],
    uploadedAfter: window.after === null ? null : new Date(window.after).toISOString(),
    uploadedBefore: window.before === null ? null : new Date(window.before).toISOString(),
  };
}

function localMidnight(value: string): number | null {
  const match = DATE_PATTERN.exec(value);
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day
    ? date.getTime() : null;
}

function nextLocalMidnight(value: string): number | null {
  const match = DATE_PATTERN.exec(value);
  if (!match || localMidnight(value) === null) return null;
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + 1).getTime();
}

/** Binary units, identical to the public download card: "12 KB", "2.4 MB". */
export function formatBytes(size: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = size;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  if (unit === 0) return `${value} ${units[unit]}`;
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

/** Short relative age: "just now", "5 min ago", "3 h ago", "yesterday", "12 days ago", "3 mo ago". */
export function formatRelative(then: number, now: number): string {
  const minutes = Math.floor((now - then) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
  if (days < 365) return `${Math.max(1, Math.floor(days / 30.4375))} mo ago`;
  return `${Math.max(1, Math.floor(days / 365.25))} yr ago`;
}

export function formatDate(at: number, timeZone?: string): string {
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone }).format(at);
}

export function formatDateTime(at: number, timeZone?: string): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit",
    timeZoneName: "short", timeZone,
  }).format(at);
}

export function formatTime(at: number, timeZone?: string): string {
  return new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone }).format(at);
}

/** The single description of an age window, shown under the toolbar and repeated in the review. */
export function describeWindow(window: AgeWindow, timeZone?: string): string | null {
  if (window.after !== null && window.before !== null) {
    const zone = formatDateTime(window.after, timeZone).split(" ").pop();
    return `Uploaded from ${formatDate(window.after, timeZone)} through ${
      formatDate(window.before - 1, timeZone)} (${zone})`;
  }
  if (window.before !== null) return `Uploaded before ${formatDateTime(window.before, timeZone)}`;
  if (window.after !== null) return `Uploaded on or after ${formatDateTime(window.after, timeZone)}`;
  return null;
}

// ---------------------------------------------------------------------------------------------
// Client state.

export interface SearchPort {
  post(message: SearchWorkerRequest): void;
  terminate(): void;
}
export interface CatalogClientDeps {
  /** Same-origin catalog transport; browsers attach the exact Origin on POST/DELETE themselves. */
  fetch(input: string, init: RequestInit): Promise<Response>;
  /** Starts a fresh search worker. Replies and crashes arrive through the handlers. */
  openSearch(handlers: { message(reply: SearchWorkerResponse): void; failure(reason: string): void }): SearchPort;
  now(): number;
  timeZone?: string;
}

export type View = "booting" | "login" | "library";
export type LoginProblem = "wrong-password" | "rate-limited" | "expired" | "unconfigured" | "network" | "rejected";
export interface LoginState {
  problem: LoginProblem | null;
  message: string | null;
  retryAfterSeconds: number | null;
  busy: boolean;
}

/** Per-document extraction state. Text itself is never retained here. */
export type ContentState =
  | { status: "pending" | "fetching" | "indexing" }
  | { status: "indexed"; coverage: Coverage; indexedBytes: number; reason: string | null }
  | { status: "failed"; reason: string }
  | { status: "skipped"; reason: string };

export interface ScanState {
  status: "idle" | "running" | "complete" | "incomplete" | "error";
  pages: number;
  error: string | null;
  finishedAt: number | null;
}

export interface SearchState {
  status: "idle" | "pending" | "ready" | "error" | "timeout" | "unavailable";
  message: string | null;
  /** Latest answered hits; kept while a new pattern is pending or invalid ("last valid pattern"). */
  hits: Map<UploadId, SearchHit> | null;
  hitsKey: string | null;
}

export interface ContentProgress {
  total: number;
  settled: number;
  searched: number;  // full or truncated text in the index
  truncated: number;
  nameOnly: number;  // metadata-only: matched by name/title only
  failed: number;
  skipped: number;
  nameOnlyKinds: FileKind[];
  complete: boolean; // scan complete and every observed document settled
  budgetExceeded: boolean;
}

export interface SelectionState {
  scope: "none" | "refs" | "matching";
  refs: Map<UploadId, SelectionRef>;
  /** Only in "matching" scope: cards the user unticked after selecting all matching. */
  excluded: Set<UploadId>;
  label: string | null;
  window: AgeWindow | null;
  anchor: UploadId | null;
}

export type DeleteOutcome = DeleteProgress["outcomes"][number]["status"] | "unprocessed";
export interface ReviewItem { ref: SelectionRef; summary: DocumentSummary }
export interface ReviewState {
  source: "selection" | "single";
  items: ReviewItem[]; // Frozen when opened, oldest first. Never recomputed from filters.
  totalBytes: number;
  label: string | null;
  window: AgeWindow | null;
  phase: "review" | "running" | "stopped" | "complete" | "partial" | "session-ended";
  outcomes: Map<UploadId, DeleteOutcome>;
  reasons: Map<UploadId, string>;
  stopRequested: boolean;
}

export interface Results {
  /** Every observed document passing the active filters, in display order. */
  matching: DocumentSummary[];
  /** What the grid shows: `matching`, or the selection while "Show selected" is on. */
  visible: DocumentSummary[];
  kindCounts: Map<FileKind, number>; // Every filter except type.
  olderThan90: number;               // Every filter except age.
  hiddenSelected: number;
  sort: SortKey;
}

export type SelectAllGate = { ok: true; count: number } | { ok: false; reason: string };

interface Entry {
  summary: DocumentSummary;
  content: ContentState;
  /** Coverage of the record posted to the worker, held only until the worker acknowledges it. */
  indexMeta?: { coverage: Coverage; indexedBytes: number; reason: string | null };
}
interface QueryFlight { generation: number; key: string; corpus: number; timer: ReturnType<typeof setTimeout> }

const NO_WINDOW: AgeWindow = { after: null, before: null };

function queryKey(query: SearchQuery): string {
  return JSON.stringify([query.mode, query.ignoreCase, query.text]);
}

function emptySelection(): SelectionState {
  return { scope: "none", refs: new Map(), excluded: new Set(), label: null, window: null, anchor: null };
}

export class CatalogClient {
  view: View = "booting";
  login: LoginState = { problem: null, message: null, retryAfterSeconds: null, busy: false };
  /** Shown on the login view after a lock whose server-side logout failed. */
  lockNotice: string | null = null;
  scan: ScanState = { status: "idle", pages: 0, error: null, finishedAt: null };
  search: SearchState = { status: "idle", message: null, hits: null, hitsKey: null };
  filters: Filters = { ...DEFAULT_FILTERS };
  /** Instant the age cutoff was frozen: on page load, on activating an age filter, or on reset. */
  frozenNow: number;
  selectedOnly = false;
  renderLimit = RENDER_STEP;
  selection: SelectionState = emptySelection();
  review: ReviewState | null = null;
  /** Monotonic change counter for render memoization. */
  revision = 0;

  private readonly listeners = new Set<() => void>();
  private announcer: (text: string) => void = () => {};
  private readonly docs = new Map<UploadId, Entry>();
  private session: SessionResponse | null = null;
  private expiryTimer: ReturnType<typeof setTimeout> | null = null;
  // Epoch: bumped by lock, expiry and refresh. Every await re-checks it before touching state.
  private epoch = 0;
  private abort = new AbortController();
  private worker: SearchPort | null = null;
  // Generation: one counter for every worker message, so replies correlate unambiguously.
  private generation = 0;
  private readonly pendingAdds = new Map<number, UploadId>();
  private queue: UploadId[] = [];
  private resumeCursor: string | null = null; // Next unread listing page after a scan error.
  private textInFlight = 0;
  private indexedBytes = 0;
  private budgetExceeded = false;
  private searchBroken: string | null = null;
  private corpusRevision = 0; // Bumped whenever the index gains a document.
  private flight: QueryFlight | null = null;
  private queued = false;
  private requeryTimer: ReturnType<typeof setTimeout> | null = null;
  private hitsCorpus = -1;
  private readonly timedOut = new Set<string>();
  private resultsCache: { revision: number; value: Results } | null = null;

  constructor(private readonly deps: CatalogClientDeps, params = new URLSearchParams()) {
    this.filters = filtersFromParams(params);
    this.frozenNow = deps.now();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onAnnounce(announcer: (text: string) => void): void {
    this.announcer = announcer;
  }

  get timeZone(): string | undefined {
    return this.deps.timeZone;
  }

  // ------------------------------------------------------------------------------------------
  // Session lifecycle.

  /** Bootstraps from the HttpOnly cookie: 200 opens the library, 401 shows login. */
  async start(): Promise<void> {
    const epoch = this.epoch;
    let response: Response;
    try {
      response = await this.request("/all-docs/session", { method: "GET" });
    } catch {
      if (epoch === this.epoch) this.showLogin("network");
      return;
    }
    if (epoch !== this.epoch) return;
    if (response.ok) {
      const session = await readJson<SessionResponse>(response);
      if (epoch !== this.epoch) return;
      if (isSession(session)) return this.open(session);
      return this.showLogin("rejected", "The library returned an unreadable session.");
    }
    const problem = await this.loginProblem(response, "start");
    if (epoch === this.epoch) this.showLogin(problem.problem, problem.message, problem.retryAfterSeconds);
  }

  async signIn(password: string): Promise<void> {
    if (this.login.busy) return;
    this.login = { ...this.login, busy: true };
    this.lockNotice = null;
    this.changed();
    const epoch = this.epoch;
    let response: Response;
    try {
      response = await this.request("/all-docs/session", { method: "POST", body: { password } });
    } catch {
      if (epoch === this.epoch) this.showLogin("network");
      return;
    }
    if (epoch !== this.epoch) return;
    if (response.ok) {
      const session = await readJson<SessionResponse>(response);
      if (epoch !== this.epoch) return;
      if (isSession(session)) return this.open(session);
      return this.showLogin("rejected", "The library returned an unreadable session.");
    }
    const problem = await this.loginProblem(response, "login");
    if (epoch === this.epoch) this.showLogin(problem.problem, problem.message, problem.retryAfterSeconds);
  }

  /** "Lock": drops every private byte locally first, then ends the server session. */
  async lock(): Promise<void> {
    const session = this.session;
    this.teardown();
    this.filters = { ...DEFAULT_FILTERS }; // A deliberate lock forgets the query; expiry keeps it.
    this.showLogin(null);
    if (!session) return;
    try {
      const response = await this.request("/all-docs/session", { method: "DELETE", csrf: session.csrfToken });
      if (!response.ok && response.status !== 401) {
        this.lockNotice = "Locked on this device, but the server session could not be ended. Close the tab to be safe.";
        this.changed();
      }
    } catch {
      this.lockNotice = "Locked on this device, but the server could not be reached to end the session.";
      this.changed();
    }
  }

  private open(session: SessionResponse): void {
    this.session = session;
    this.view = "library";
    this.login = { problem: null, message: null, retryAfterSeconds: null, busy: false };
    this.lockNotice = null;
    const remaining = Date.parse(session.expiresAt) - this.deps.now();
    // Expiry is enforced locally too, so private content never outlives the cookie on screen.
    this.expiryTimer = setTimeout(() => this.expire(), Math.min(Math.max(remaining, 0), 2_147_483_647));
    this.startCorpus();
  }

  /** The server or the clock ended the session: same teardown as lock, without a DELETE. */
  private expire(): void {
    if (this.view !== "library") return;
    this.teardown();
    this.showLogin("expired");
  }

  private teardown(): void {
    this.epoch++;
    this.abort.abort();
    this.abort = new AbortController();
    if (this.expiryTimer !== null) clearTimeout(this.expiryTimer);
    this.expiryTimer = null;
    this.stopWorker();
    this.session = null;
    this.docs.clear();
    this.queue = [];
    this.textInFlight = 0;
    this.indexedBytes = 0;
    this.budgetExceeded = false;
    this.scan = { status: "idle", pages: 0, error: null, finishedAt: null };
    this.search = { status: "idle", message: null, hits: null, hitsKey: null };
    this.selection = emptySelection();
    this.selectedOnly = false;
    this.review = null;
    this.renderLimit = RENDER_STEP;
  }

  private showLogin(problem: LoginProblem | null, message: string | null = null, retryAfterSeconds: number | null = null): void {
    this.view = "login";
    this.login = { problem, message, retryAfterSeconds, busy: false };
    this.changed();
  }

  private async loginProblem(response: Response, phase: "start" | "login"): Promise<Omit<LoginState, "busy">> {
    const view = { problem: null as LoginProblem | null, message: null as string | null, retryAfterSeconds: null as number | null };
    if (response.status === 401) return { ...view, problem: phase === "login" ? "wrong-password" : null };
    if (response.status === 429) {
      const seconds = Number(response.headers.get("Retry-After"));
      return { ...view, problem: "rate-limited", retryAfterSeconds: Number.isFinite(seconds) && seconds > 0 ? seconds : null };
    }
    if (response.status === 503) return { ...view, problem: "unconfigured" };
    const error = await readError(response);
    return { ...view, problem: "rejected", message: error?.message ?? `The library refused the request (HTTP ${response.status}).` };
  }

  // ------------------------------------------------------------------------------------------
  // Discovery and extraction.

  /** Rescans storage from the first cursor and rebuilds the content index from scratch. */
  refresh(): void {
    if (this.view !== "library" || this.scan.status === "running" || this.review?.phase === "running") return;
    this.epoch++;
    this.abort.abort();
    this.abort = new AbortController();
    if (this.selection.scope === "matching") this.clearSelection("Selection cleared because the library was refreshed.");
    this.stopWorker();
    this.docs.clear();
    this.queue = [];
    this.textInFlight = 0;
    this.indexedBytes = 0;
    this.budgetExceeded = false;
    this.search = { status: this.filters.text ? "pending" : "idle", message: null, hits: null, hitsKey: null };
    this.startCorpus();
  }

  /** Continues discovery after a network or server error, keeping the observed set. */
  retryScan(cursor: string | null = this.resumeCursor): void {
    if (this.view !== "library" || this.scan.status !== "error") return;
    void this.discover(this.epoch, cursor);
  }

  private startCorpus(): void {
    this.searchBroken = null;
    this.timedOut.clear();
    this.startWorker();
    this.scan = { status: "running", pages: 0, error: null, finishedAt: null };
    this.changed();
    void this.discover(this.epoch, null);
  }

  private async discover(epoch: number, startCursor: string | null): Promise<void> {
    let cursor = startCursor;
    this.scan = { ...this.scan, status: "running", error: null };
    this.changed();
    for (;;) {
      this.resumeCursor = cursor;
      const path = cursor === null ? "/all-docs/api/documents"
        : `/all-docs/api/documents?cursor=${encodeURIComponent(cursor)}`;
      let page: CatalogPage | null = null;
      try {
        const response = await this.request(path, { method: "GET" });
        if (epoch !== this.epoch) return;
        if (response.status === 401) return this.expire();
        if (!response.ok) {
          const error = await readError(response);
          if (epoch !== this.epoch) return;
          return this.scanFailed(error?.message ?? `Storage listing failed (HTTP ${response.status}).`);
        }
        page = await readJson<CatalogPage>(response);
      } catch {
        if (epoch !== this.epoch) return;
        return this.scanFailed("Couldn't reach storage.");
      }
      if (epoch !== this.epoch) return;
      if (!isCatalogPage(page)) return this.scanFailed("Storage returned an unreadable page.");
      let unreadable = 0;
      for (const summary of page.items) {
        if (!isSummary(summary)) {
          unreadable++;
          continue;
        }
        const previous = this.docs.get(summary.id);
        if (previous && previous.summary.version === summary.version) continue;
        this.docs.set(summary.id, { summary, content: { status: "pending" } });
        this.queue.push(summary.id);
      }
      this.scan = { ...this.scan, pages: this.scan.pages + 1 };
      this.pump();
      this.changed();
      if (unreadable) {
        // Skipping an entry would make "all matching" a lie, so the whole scan becomes incomplete.
        this.scan = { ...this.scan, status: "incomplete", error: `${unreadable} storage entries were unreadable.`, finishedAt: this.deps.now() };
        return this.changed();
      }
      if (page.nextCursor === null) {
        this.scan = {
          ...this.scan,
          status: page.scanComplete ? "complete" : "incomplete",
          error: page.scanComplete ? null : "Storage reported an incomplete listing.",
          finishedAt: this.deps.now(),
        };
        this.resumeCursor = null;
        this.pruneSelection();
        this.scheduleRequery();
        return this.changed();
      }
      cursor = page.nextCursor;
    }
  }

  private scanFailed(message: string): void {
    this.scan = { ...this.scan, status: "error", error: message };
    this.changed();
  }

  /** Starts queued text fetches up to TEXT_CONCURRENCY. Called after every arrival and settlement. */
  private pump(): void {
    if (this.budgetExceeded || this.searchBroken) {
      // Nothing more can be indexed. Settle the rest visibly rather than leaving them "pending",
      // which would keep coverage at "indexing…" forever.
      const content: ContentState = this.searchBroken
        ? { status: "failed", reason: this.searchBroken }
        : { status: "skipped", reason: "Over this tab's search budget." };
      for (const id of this.queue) {
        const entry = this.docs.get(id);
        if (entry?.content.status === "pending") entry.content = content;
      }
      this.queue = [];
      return;
    }
    while (this.textInFlight < TEXT_CONCURRENCY && this.queue.length) {
      const id = this.queue.shift() as UploadId;
      const entry = this.docs.get(id);
      if (!entry || entry.content.status !== "pending") continue;
      this.textInFlight++;
      entry.content = { status: "fetching" };
      const epoch = this.epoch;
      void this.extract(epoch, entry.summary).finally(() => {
        // Refresh and teardown bump the epoch and reset the counter; only live requests settle it.
        if (epoch !== this.epoch) return;
        this.textInFlight--;
        this.pump();
        this.changed();
      });
    }
  }

  private async extract(epoch: number, summary: DocumentSummary): Promise<void> {
    const settle = (content: ContentState) => {
      const entry = this.docs.get(summary.id);
      if (epoch === this.epoch && entry?.summary === summary) entry.content = content;
    };
    let record: TextRecord | null;
    try {
      const response = await this.request(
        `/all-docs/api/documents/${encodeURIComponent(summary.id)}/text?version=${encodeURIComponent(summary.version)}`,
        { method: "GET" },
      );
      if (epoch !== this.epoch) return;
      if (response.status === 401) return this.expire();
      if (response.status === 409) return settle({ status: "failed", reason: "Changed since the scan. Refresh to read it." });
      if (!response.ok) {
        const error = await readError(response);
        return settle({ status: "failed", reason: error?.message ?? `Content unavailable (HTTP ${response.status}).` });
      }
      record = await readJson<TextRecord>(response);
    } catch {
      return settle({ status: "failed", reason: "Couldn't reach storage for this document's content." });
    }
    if (epoch !== this.epoch || this.docs.get(summary.id)?.summary !== summary) return;
    if (!isTextRecord(record) || record.id !== summary.id || record.documentVersion !== summary.version) {
      return settle({ status: "failed", reason: "The content response did not match this document version." });
    }
    const cost = Math.max(record.indexedBytes, record.text.length);
    if (this.indexedBytes + cost > TEXT_BUDGET_BYTES) {
      this.budgetExceeded = true;
      return settle({ status: "skipped", reason: "Over this tab's search budget." });
    }
    if (!this.worker) return settle({ status: "failed", reason: this.searchBroken ?? "Content search is unavailable." });
    this.indexedBytes += cost;
    const generation = ++this.generation;
    this.pendingAdds.set(generation, summary.id);
    settle({ status: "indexing" });
    const entry = this.docs.get(summary.id);
    if (entry) entry.indexMeta = { coverage: record.coverage, indexedBytes: record.indexedBytes, reason: record.reason };
    // The record is handed to the worker by structured clone; no reference to its text survives here.
    this.worker.post({ version: 1, generation, operation: "add", summary, text: record });
  }

  // ------------------------------------------------------------------------------------------
  // Search worker: one message counter, one query in flight, latest query wins.

  private startWorker(): void {
    this.generation++;
    this.pendingAdds.clear();
    this.flight = null;
    this.queued = false;
    try {
      this.worker = this.deps.openSearch({
        message: (reply) => this.onReply(reply),
        failure: (reason) => this.onWorkerFailure(reason),
      });
    } catch {
      this.worker = null;
      this.searchBroken = "Content search could not start in this browser.";
    }
  }

  private stopWorker(): void {
    if (this.flight) clearTimeout(this.flight.timer);
    if (this.requeryTimer !== null) clearTimeout(this.requeryTimer);
    this.requeryTimer = null;
    this.flight = null;
    this.queued = false;
    this.pendingAdds.clear();
    if (this.worker) {
      // Clear first for implementations that release memory eagerly; terminate guarantees it.
      try {
        this.worker.post({ version: 1, generation: ++this.generation, operation: "clear" });
      } catch { /* A crashed worker cannot accept messages; terminate still applies. */ }
      this.worker.terminate();
    }
    this.worker = null;
  }

  private onWorkerFailure(reason: string): void {
    this.stopWorker();
    this.searchBroken = reason || "Content search stopped working.";
    for (const entry of this.docs.values()) {
      if (entry.content.status === "indexing" || entry.content.status === "pending") {
        entry.content = { status: "failed", reason: this.searchBroken };
      }
    }
    this.search = { ...this.search, status: "unavailable", message: this.searchBroken };
    this.changed();
  }

  private onReply(reply: SearchWorkerResponse): void {
    if (!reply || reply.version !== 1) return;
    const added = this.pendingAdds.get(reply.generation);
    if (added !== undefined) {
      this.pendingAdds.delete(reply.generation);
      const entry = this.docs.get(added);
      if (entry && entry.content.status === "indexing") {
        entry.content = reply.status === "error"
          ? { status: "failed", reason: reply.message || "The search index rejected this document." }
          : {
            status: "indexed", coverage: entry.indexMeta?.coverage ?? "metadata-only",
            indexedBytes: entry.indexMeta?.indexedBytes ?? 0, reason: entry.indexMeta?.reason ?? null,
          };
        entry.indexMeta = undefined;
        this.corpusRevision++;
        this.scheduleRequery();
      }
      return this.changed();
    }
    const flight = this.flight;
    if (!flight || reply.generation !== flight.generation) return; // Obsolete generation.
    clearTimeout(flight.timer);
    this.flight = null;
    if (flight.key === this.currentKey()) {
      if (reply.status === "results") {
        this.search = {
          status: "ready", message: null,
          hits: new Map((Array.isArray(reply.hits) ? reply.hits : []).map((hit) => [hit.id, hit])),
          hitsKey: flight.key,
        };
        this.hitsCorpus = flight.corpus;
      } else if (reply.status === "error") {
        this.search = { ...this.search, status: "error", message: reply.message || "This pattern can't be searched." };
        this.hitsCorpus = flight.corpus;
      }
      if (this.corpusRevision !== flight.corpus) this.scheduleRequery();
    }
    this.flushQuery();
    this.changed();
  }

  private currentQuery(): SearchQuery | null {
    if (!this.filters.text) return null;
    return { text: this.filters.text, mode: this.filters.regex ? "regex" : "literal", ignoreCase: !this.filters.matchCase };
  }

  private currentKey(): string | null {
    const query = this.currentQuery();
    return query ? queryKey(query) : null;
  }

  private requestQuery(): void {
    const key = this.currentKey();
    if (key === null) {
      this.search = { status: "idle", message: null, hits: null, hitsKey: null };
      return;
    }
    if (this.searchBroken) {
      this.search = { ...this.search, status: "unavailable", message: this.searchBroken };
      return;
    }
    if (this.timedOut.has(key)) {
      this.search = { ...this.search, status: "timeout", message: null };
      return;
    }
    this.search = { ...this.search, status: "pending", message: null };
    this.queued = true;
    this.flushQuery();
  }

  /** Sends the latest wanted query once nothing is in flight; superseded keystrokes never queue. */
  private flushQuery(): void {
    if (this.flight || !this.queued || !this.worker) return;
    this.queued = false;
    const query = this.currentQuery();
    if (!query) return;
    const key = queryKey(query);
    if (this.timedOut.has(key)) return;
    const generation = ++this.generation;
    const timer = setTimeout(() => this.onQueryTimeout(generation), QUERY_BUDGET_MS);
    this.flight = { generation, key, corpus: this.corpusRevision, timer };
    // Filtering by type and age happens here, over the full hit set, so the rail and the age chip
    // can count every alternative. The worker therefore always searches every kind and date.
    this.worker.post({
      version: 1, generation, operation: "query", query,
      filter: { kinds: [...FILE_KINDS], uploadedBefore: null, uploadedAfter: null },
    });
  }

  /** A stuck query can't be cancelled inside a worker: abandon it, restart, and re-index. */
  private onQueryTimeout(generation: number): void {
    if (!this.flight || this.flight.generation !== generation) return;
    const key = this.flight.key;
    this.timedOut.add(key);
    this.stopWorker();
    this.startWorker();
    this.indexedBytes = 0;
    this.budgetExceeded = false;
    this.queue = [];
    for (const [id, entry] of this.docs) {
      if (entry.content.status === "fetching") continue; // Its in-flight fetch settles into the new worker.
      entry.content = { status: "pending" };
      entry.indexMeta = undefined;
      this.queue.push(id);
    }
    if (key === this.currentKey()) this.search = { ...this.search, status: "timeout", message: null };
    this.pump();
    this.changed();
  }

  private scheduleRequery(): void {
    if (!this.filters.text || this.requeryTimer !== null) return;
    this.requeryTimer = setTimeout(() => {
      this.requeryTimer = null;
      const key = this.currentKey();
      if (!key || this.timedOut.has(key) || !this.worker) return;
      const fresh = this.flight
        ? this.flight.key === key && this.flight.corpus === this.corpusRevision
        : this.search.hitsKey === key && this.hitsCorpus === this.corpusRevision;
      if (fresh) return;
      this.queued = true;
      this.flushQuery();
      this.changed();
    }, REQUERY_DELAY_MS);
  }

  // ------------------------------------------------------------------------------------------
  // Filters and render pagination.

  /** Applies a filter change. Any change to the matching set clears an "all matching" selection. */
  setFilters(patch: Partial<Filters>): void {
    const before = this.filters;
    const next: Filters = { ...before, ...patch, kinds: patch.kinds ? [...new Set(patch.kinds)] : before.kinds };
    if (next.age !== "range") {
      next.from = "";
      next.to = "";
    }
    const setChanged = next.text !== before.text || next.regex !== before.regex || next.matchCase !== before.matchCase
      || next.age !== before.age || next.from !== before.from || next.to !== before.to
      || next.kinds.join() !== before.kinds.join();
    if (next.age !== before.age && next.age !== "any") this.frozenNow = this.deps.now();
    this.filters = next;
    if (setChanged) {
      this.renderLimit = RENDER_STEP;
      if (this.selection.scope === "matching") this.clearSelection("Selection cleared because filters changed.");
    }
    if (next.text !== before.text || next.regex !== before.regex || next.matchCase !== before.matchCase) this.requestQuery();
    this.changed();
  }

  /** Validates and applies an inclusive local date range; an inverted range keeps the last valid one. */
  setRange(from: string, to: string): string | null {
    const start = from ? localMidnight(from) : null;
    const end = to ? localMidnight(to) : null;
    if ((from && start === null) || (to && end === null)) return "Enter a valid date.";
    if (start !== null && end !== null && end < start) return "End date is before start date";
    this.setFilters({ age: "range", from, to });
    return null;
  }

  /** Re-freezes an age cutoff to now, from the "Reset cutoff" control. */
  resetCutoff(): void {
    this.frozenNow = this.deps.now();
    this.renderLimit = RENDER_STEP;
    if (this.selection.scope === "matching") this.clearSelection("Selection cleared because the cutoff changed.");
    this.changed();
  }

  clearFilters(): void {
    this.setFilters({ ...DEFAULT_FILTERS, sort: this.filters.sort === "matches" ? null : this.filters.sort });
  }

  setSelectedOnly(on: boolean): void {
    this.selectedOnly = on && this.selection.scope !== "none";
    this.renderLimit = RENDER_STEP;
    this.changed();
  }

  showMore(): void {
    this.renderLimit += RENDER_STEP;
    this.changed();
  }

  /** The active upload-time window, using the frozen cutoff instant. */
  window(): AgeWindow {
    return ageWindow(this.filters, this.frozenNow);
  }

  cutoffLine(): string | null {
    const description = describeWindow(this.window(), this.deps.timeZone);
    if (!description) return null;
    return this.filters.age === "range" ? description
      : `${description} · cutoff fixed at ${formatTime(this.frozenNow, this.deps.timeZone)}`;
  }

  effectiveSort(): SortKey {
    const sort = this.filters.sort;
    if (sort === "matches" && !this.filters.text) return "newest";
    return sort ?? (this.filters.text ? "matches" : "newest");
  }

  results(): Results {
    if (this.resultsCache?.revision === this.revision) return this.resultsCache.value;
    const window = this.window();
    const key = this.currentKey();
    const hits = key === null ? null : this.search.hits;
    const kinds = this.filters.kinds;
    const matchesQuery = (doc: DocumentSummary) => {
      if (key === null) return true;
      const hit = hits?.get(doc.id);
      return hit !== undefined && hit.version === doc.version;
    };
    const ofKind = (doc: DocumentSummary) => kinds.length === 0 || kinds.includes(doc.kind);
    const olderBound = this.frozenNow - 90 * DAY_MS;
    const kindCounts = new Map<FileKind, number>();
    let olderThan90 = 0;
    const matching: DocumentSummary[] = [];
    for (const { summary } of this.docs.values()) {
      if (!matchesQuery(summary)) continue;
      const uploaded = Date.parse(summary.uploadedAt);
      const inAge = inWindow(uploaded, window);
      if (inAge) kindCounts.set(summary.kind, (kindCounts.get(summary.kind) ?? 0) + 1);
      if (ofKind(summary) && uploaded < olderBound) olderThan90++;
      if (inAge && ofKind(summary)) matching.push(summary);
    }
    const sort = this.effectiveSort();
    const compare = comparator(sort, hits);
    matching.sort(compare);
    const selected = this.selectedIds();
    const visible = this.selectedOnly
      ? [...selected].map((id) => this.docs.get(id)?.summary).filter((doc): doc is DocumentSummary => !!doc).sort(compare)
      : matching;
    let hiddenSelected = 0;
    if (!this.selectedOnly && selected.size) {
      const shown = new Set(matching.map((doc) => doc.id));
      for (const id of selected) if (!shown.has(id)) hiddenSelected++;
    }
    const value: Results = { matching, visible, kindCounts, olderThan90, hiddenSelected, sort };
    this.resultsCache = { revision: this.revision, value };
    return value;
  }

  rendered(): DocumentSummary[] {
    return this.results().visible.slice(0, this.renderLimit);
  }

  summary(id: UploadId): DocumentSummary | null {
    return this.docs.get(id)?.summary ?? null;
  }

  contentOf(id: UploadId): ContentState | null {
    return this.docs.get(id)?.content ?? null;
  }

  hitFor(doc: DocumentSummary): SearchHit | null {
    if (this.currentKey() === null) return null;
    const hit = this.search.hits?.get(doc.id);
    return hit && hit.version === doc.version ? hit : null;
  }

  observed(): DocumentSummary[] {
    return [...this.docs.values()].map((entry) => entry.summary);
  }

  contentProgress(): ContentProgress {
    const progress: ContentProgress = {
      total: this.docs.size, settled: 0, searched: 0, truncated: 0, nameOnly: 0, failed: 0, skipped: 0,
      nameOnlyKinds: [], complete: false, budgetExceeded: this.budgetExceeded,
    };
    const nameOnlyKinds = new Set<FileKind>();
    for (const { summary, content } of this.docs.values()) {
      switch (content.status) {
        case "indexed":
          progress.settled++;
          if (content.coverage === "full" || content.coverage === "truncated") progress.searched++;
          if (content.coverage === "truncated") progress.truncated++;
          if (content.coverage === "metadata-only") {
            progress.nameOnly++;
            nameOnlyKinds.add(summary.kind);
          }
          if (content.coverage === "error") progress.failed++;
          break;
        case "failed": progress.settled++; progress.failed++; break;
        case "skipped": progress.settled++; progress.skipped++; break;
        default: break;
      }
    }
    progress.nameOnlyKinds = FILE_KINDS.filter((kind) => nameOnlyKinds.has(kind));
    progress.complete = this.scan.status === "complete" && progress.settled === progress.total;
    return progress;
  }

  /** Whether "Select all N matching" may freeze the current matching set, and why not. */
  selectAllGate(): SelectAllGate {
    const scan = this.scan;
    if (scan.status === "running") return { ok: false, reason: `Available when the scan finishes (${this.docs.size} found so far)` };
    if (scan.status !== "complete") return { ok: false, reason: "Unavailable because the storage scan is incomplete" };
    if (this.selectedOnly) return { ok: false, reason: "Turn off “Show selected” to select by filter" };
    const key = this.currentKey();
    if (key !== null) {
      const progress = this.contentProgress();
      if (progress.budgetExceeded) return { ok: false, reason: "Unavailable: the library exceeds this tab's search budget" };
      if (this.searchBroken) return { ok: false, reason: "Unavailable while content search is down" };
      if (this.timedOut.has(key)) return { ok: false, reason: "Unavailable because this search stopped early" };
      if (!progress.complete) return { ok: false, reason: `Available when content indexing finishes (${progress.settled} of ${progress.total})` };
      if (this.flight || this.queued || this.search.hitsKey !== key || this.hitsCorpus !== this.corpusRevision
        || this.search.status !== "ready") {
        return { ok: false, reason: this.search.status === "error" ? "Unavailable while the search reports an error" : "Available when the search finishes" };
      }
    }
    const count = this.results().matching.length;
    if (count === 0) return { ok: false, reason: "Nothing matches" };
    return { ok: true, count };
  }

  /** Human description of the current filters, e.g. "Older than 90 days · PDF · “invoice”". */
  filterLabel(): string {
    const parts: string[] = [];
    if (this.filters.age === "range") parts.push(describeWindow(this.window(), this.deps.timeZone) ?? "Date range");
    else if (this.filters.age !== "any") parts.push(AGE_PRESETS.find((preset) => preset.value === this.filters.age)?.label ?? "");
    if (this.filters.kinds.length) parts.push(this.filters.kinds.map((kind) => KIND_LABEL[kind]).join(" or "));
    if (this.filters.text) parts.push(`${this.filters.regex ? "/" : "“"}${this.filters.text}${this.filters.regex ? "/" : "”"}`);
    return parts.length ? parts.join(" · ") : "All documents";
  }

  // ------------------------------------------------------------------------------------------
  // Selection.

  selectedIds(): Set<UploadId> {
    const ids = new Set(this.selection.refs.keys());
    for (const id of this.selection.excluded) ids.delete(id);
    return ids;
  }

  isSelected(id: UploadId): boolean {
    return this.selection.refs.has(id) && !this.selection.excluded.has(id);
  }

  /** Toggles one card; with `range`, toggles every rendered card between the anchor and this one. */
  toggle(id: UploadId, range = false): void {
    const doc = this.docs.get(id)?.summary;
    if (!doc) return;
    const order = this.rendered().map((summary) => summary.id);
    const anchor = this.selection.anchor;
    const targets = range && anchor && order.includes(anchor) && order.includes(id)
      ? order.slice(Math.min(order.indexOf(anchor), order.indexOf(id)), Math.max(order.indexOf(anchor), order.indexOf(id)) + 1)
      : [id];
    const select = !this.isSelected(id);
    const selection = this.selection.scope === "none" ? { ...emptySelection(), scope: "refs" as const } : this.selection;
    for (const target of targets) {
      const summary = this.docs.get(target)?.summary;
      if (!summary) continue;
      if (selection.scope === "matching") {
        if (select) selection.excluded.delete(target);
        else if (selection.refs.has(target)) selection.excluded.add(target);
        else selection.refs.set(target, { id: target, version: summary.version });
      } else if (select) {
        selection.refs.set(target, { id: target, version: summary.version });
      } else {
        selection.refs.delete(target);
      }
    }
    selection.anchor = id;
    this.selection = selection;
    this.normalizeSelection();
    this.changed();
  }

  /** "Select page": every card rendered so far (all "Show more" steps), added as refs. */
  selectPage(): void {
    const rendered = this.rendered();
    if (!rendered.length) return;
    if (this.selection.scope === "matching") {
      for (const doc of rendered) this.selection.excluded.delete(doc.id);
    } else {
      const refs = new Map(this.selection.refs);
      for (const doc of rendered) refs.set(doc.id, { id: doc.id, version: doc.version });
      this.selection = { ...emptySelection(), scope: "refs", refs, anchor: this.selection.anchor };
    }
    this.changed();
  }

  /** Freezes the exact ID/version refs of the complete matching set, or refuses. */
  selectAllMatching(): boolean {
    const gate = this.selectAllGate();
    if (!gate.ok) return false;
    const refs = new Map<UploadId, SelectionRef>();
    for (const doc of this.results().matching) refs.set(doc.id, { id: doc.id, version: doc.version });
    const window = this.window();
    this.selection = {
      scope: "matching", refs, excluded: new Set(), label: this.filterLabel(),
      window: window.after === null && window.before === null ? null : window, anchor: null,
    };
    this.changed();
    return true;
  }

  clearSelection(announcement?: string): void {
    const had = this.selection.scope !== "none";
    this.selection = emptySelection();
    this.selectedOnly = false;
    if (had && announcement) this.announcer(announcement);
    this.changed();
  }

  private normalizeSelection(): void {
    if (this.selectedIds().size === 0) {
      this.selection = emptySelection();
      this.selectedOnly = false;
    }
  }

  /** After a rescan: keep refs whose ID and version are still observed; report the rest. */
  private pruneSelection(): void {
    if (this.selection.scope !== "refs") return;
    let dropped = 0;
    for (const [id, ref] of this.selection.refs) {
      if (this.docs.get(id)?.summary.version !== ref.version) {
        this.selection.refs.delete(id);
        dropped++;
      }
    }
    this.normalizeSelection();
    if (dropped) {
      this.announcer(`${dropped} selected ${dropped === 1 ? "document no longer exists or changed and was" : "documents no longer exist or changed and were"} deselected.`);
    }
  }

  // ------------------------------------------------------------------------------------------
  // Delete review: freeze, confirm, commit in bounded batches, keep failures selected.

  /** Freezes the selection (or one card) into explicit refs with the metadata observed now. */
  openReview(single?: UploadId): ReviewState | null {
    if (this.view !== "library" || this.review?.phase === "running") return null;
    const refs: SelectionRef[] = single
      ? (this.docs.has(single) ? [{ id: single, version: (this.docs.get(single) as Entry).summary.version }] : [])
      : [...this.selectedIds()].map((id) => this.selection.refs.get(id) as SelectionRef);
    const items: ReviewItem[] = [];
    for (const ref of refs) {
      const summary = this.docs.get(ref.id)?.summary;
      if (summary) items.push({ ref: { id: ref.id, version: ref.version }, summary });
    }
    if (!items.length) return null;
    items.sort((a, b) => Date.parse(a.summary.uploadedAt) - Date.parse(b.summary.uploadedAt) || compareText(a.ref.id, b.ref.id));
    const fromSelection = !single && this.selection.scope === "matching";
    this.review = {
      source: single ? "single" : "selection",
      items,
      totalBytes: items.reduce((sum, item) => sum + item.summary.sizeBytes, 0),
      label: fromSelection ? this.selection.label : null,
      window: fromSelection ? this.selection.window : null,
      phase: "review",
      outcomes: new Map(items.map((item) => [item.ref.id, "unprocessed" as DeleteOutcome])),
      reasons: new Map(),
      stopRequested: false,
    };
    this.changed();
    return this.review;
  }

  /** For two or more documents, the typed text must be exactly the frozen count. */
  canConfirm(typed: string): boolean {
    const review = this.review;
    if (!review || review.phase !== "review") return false;
    return review.items.length === 1 || typed.trim() === String(review.items.length);
  }

  async confirmReview(typed: string): Promise<void> {
    if (!this.canConfirm(typed)) return;
    await this.commit((this.review as ReviewState).items.map((item) => item.ref.id));
  }

  /** Re-sends only refs that failed or were never processed, with their originally frozen versions. */
  async retryReview(): Promise<void> {
    const review = this.review;
    if (!review || (review.phase !== "partial" && review.phase !== "stopped")) return;
    const ids = review.items.map((item) => item.ref.id).filter((id) => {
      const outcome = review.outcomes.get(id);
      return outcome === "failed" || outcome === "unprocessed";
    });
    if (ids.length) await this.commit(ids);
  }

  stopReview(): void {
    if (this.review?.phase === "running") {
      this.review.stopRequested = true;
      this.changed();
    }
  }

  private async commit(ids: UploadId[]): Promise<void> {
    const review = this.review as ReviewState;
    const session = this.session;
    if (!session) return;
    const epoch = this.epoch;
    review.phase = "running";
    review.stopRequested = false;
    for (const id of ids) {
      review.outcomes.set(id, "unprocessed");
      review.reasons.delete(id);
    }
    this.changed();
    const wanted = new Set(ids);
    const refs = review.items.filter((item) => wanted.has(item.ref.id)).map((item) => item.ref);
    for (let start = 0; start < refs.length; start += MAX_DELETE_BATCH_ITEMS) {
      if (review.stopRequested) {
        review.phase = "stopped";
        return this.changed();
      }
      const batch = refs.slice(start, start + MAX_DELETE_BATCH_ITEMS);
      // The frozen contract confirms each batch on its own; the typed global count was checked above.
      const body: DeleteBatchRequest = {
        version: 1, items: batch, confirmCount: batch.length, confirmation: `DELETE ${batch.length} documents`,
      };
      let response: Response;
      try {
        response = await this.request("/all-docs/api/delete", { method: "POST", body, csrf: session.csrfToken });
      } catch {
        if (epoch !== this.epoch || this.review !== review) return;
        this.failBatch(review, batch, "Couldn't reach storage; this batch's result is unknown, so it was kept.");
        review.phase = "partial";
        return this.changed();
      }
      if (epoch !== this.epoch || this.review !== review) return;
      if (response.status === 401) {
        review.phase = "session-ended";
        return this.changed();
      }
      const progress = response.ok ? await readJson<DeleteProgress>(response) : null;
      if (epoch !== this.epoch || this.review !== review) return;
      if (!response.ok || !isDeleteProgress(progress)) {
        const error = response.ok ? null : await readError(response);
        this.failBatch(review, batch, error?.message ?? `The delete request failed (HTTP ${response.status}).`);
        review.phase = "partial";
        return this.changed();
      }
      const inBatch = new Set(batch.map((ref) => ref.id));
      for (const outcome of progress.outcomes) {
        if (!inBatch.has(outcome.id)) continue;
        review.outcomes.set(outcome.id, outcome.status);
        if (outcome.status === "failed") review.reasons.set(outcome.id, "Storage could not delete it.");
      }
      for (const ref of batch) {
        if (review.outcomes.get(ref.id) === "unprocessed") {
          review.outcomes.set(ref.id, "failed");
          review.reasons.set(ref.id, "The server returned no result for it.");
        }
      }
      this.changed();
    }
    const outcomes = [...review.outcomes.values()];
    review.phase = outcomes.some((outcome) => outcome === "failed" || outcome === "unprocessed") ? "partial" : "complete";
    this.changed();
  }

  private failBatch(review: ReviewState, batch: SelectionRef[], reason: string): void {
    for (const ref of batch) {
      review.outcomes.set(ref.id, "failed");
      review.reasons.set(ref.id, reason);
    }
  }

  /** Closes the dialog and applies outcomes: deleted/missing leave the library, the rest stay selected. */
  closeReview(): void {
    const review = this.review;
    if (!review || review.phase === "running") return;
    this.review = null;
    if (review.phase === "session-ended") {
      this.teardown();
      this.showLogin("expired");
      return;
    }
    let removed = 0;
    let deleted = 0;
    const kept = new Map<UploadId, SelectionRef>();
    for (const item of review.items) {
      const outcome = review.outcomes.get(item.ref.id);
      if (outcome === "deleted" || outcome === "not-found") {
        removed++;
        if (outcome === "deleted") deleted++;
        this.docs.delete(item.ref.id);
        this.selection.refs.delete(item.ref.id);
        this.selection.excluded.delete(item.ref.id);
      } else {
        kept.set(item.ref.id, item.ref);
      }
    }
    if (review.source === "selection" && review.phase !== "review") {
      // Unprocessed, changed and failed refs stay selected as explicit refs, never as a predicate.
      this.selection = kept.size ? { ...emptySelection(), scope: "refs", refs: kept } : emptySelection();
      if (!kept.size) this.selectedOnly = false;
    } else {
      this.normalizeSelection();
    }
    if (removed) {
      this.renderLimit = Math.max(RENDER_STEP, this.renderLimit);
      this.announcer(`${deleted} ${deleted === 1 ? "document" : "documents"} deleted.`);
    }
    this.changed();
  }

  /** Tab-separated `id<TAB>filename` lines for the frozen review set. */
  reviewIdsText(): string {
    return (this.review?.items ?? []).map((item) => `${item.ref.id}\t${item.summary.filename}`).join("\n");
  }

  // ------------------------------------------------------------------------------------------
  // Transport and notification.

  private async request(path: string, init: { method: string; body?: unknown; csrf?: string }): Promise<Response> {
    const headers: Record<string, string> = { Accept: "application/json", "X-Docs-Catalog": "1" };
    if (init.body !== undefined) headers["Content-Type"] = "application/json";
    if (init.csrf) headers["X-CSRF-Token"] = init.csrf;
    // redirect: manual keeps JSON calls on this origin; a redirect is treated as an error response.
    return this.deps.fetch(path, {
      method: init.method, headers, credentials: "same-origin", cache: "no-store", redirect: "manual",
      body: init.body === undefined ? undefined : JSON.stringify(init.body), signal: this.abort.signal,
    });
  }

  private changed(): void {
    this.revision++;
    for (const listener of this.listeners) listener();
  }
}

function comparator(sort: SortKey, hits: Map<UploadId, SearchHit> | null) {
  const time = (doc: DocumentSummary) => Date.parse(doc.uploadedAt);
  const newest = (a: DocumentSummary, b: DocumentSummary) => time(b) - time(a) || compareText(a.id, b.id);
  switch (sort) {
    case "oldest": return (a: DocumentSummary, b: DocumentSummary) => time(a) - time(b) || compareText(a.id, b.id);
    case "largest": return (a: DocumentSummary, b: DocumentSummary) => b.sizeBytes - a.sizeBytes || newest(a, b);
    case "name": return (a: DocumentSummary, b: DocumentSummary) =>
      displayTitle(a).localeCompare(displayTitle(b), "en", { sensitivity: "base", numeric: true }) || newest(a, b);
    case "matches": return (a: DocumentSummary, b: DocumentSummary) =>
      (hits?.get(b.id)?.matchCount ?? 0) - (hits?.get(a.id)?.matchCount ?? 0) || newest(a, b);
    default: return newest;
  }
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function displayTitle(doc: DocumentSummary): string {
  return doc.title.trim() || doc.filename.trim() || doc.id;
}

async function readJson<T>(response: Response): Promise<T | null> {
  try {
    return await response.json() as T;
  } catch {
    return null;
  }
}

async function readError(response: Response): Promise<CatalogError["error"] | null> {
  const body = await readJson<CatalogError>(response);
  return body && typeof body.error?.message === "string" ? body.error : null;
}

function isSession(value: SessionResponse | null): value is SessionResponse {
  return !!value && value.version === 1 && typeof value.csrfToken === "string" && value.csrfToken.length > 0
    && !Number.isNaN(Date.parse(value.expiresAt));
}

function isCatalogPage(value: CatalogPage | null): value is CatalogPage {
  return !!value && value.version === 1 && Array.isArray(value.items)
    && (value.nextCursor === null || typeof value.nextCursor === "string") && typeof value.scanComplete === "boolean";
}

function isSummary(value: DocumentSummary): boolean {
  return !!value && typeof value.id === "string" && /^[A-Za-z0-9]{8}$/.test(value.id)
    && typeof value.version === "string" && typeof value.title === "string" && typeof value.filename === "string"
    && (FILE_KINDS as readonly string[]).includes(value.kind) && typeof value.sizeBytes === "number"
    && !Number.isNaN(Date.parse(value.uploadedAt)) && typeof value.publicUrl === "string"
    && typeof value.rawUrl === "string" && Array.isArray(value.warnings);
}

function isTextRecord(value: TextRecord | null): value is TextRecord {
  return !!value && value.version === 1 && typeof value.text === "string" && typeof value.indexedBytes === "number"
    && ["full", "truncated", "metadata-only", "error"].includes(value.coverage);
}

function isDeleteProgress(value: DeleteProgress | null): value is DeleteProgress {
  return !!value && value.version === 1 && Array.isArray(value.outcomes);
}
