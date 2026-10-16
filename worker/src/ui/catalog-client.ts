/**
 * Catalog client: the browser-side model of the private library at /all-docs.
 *
 * It owns everything between the catalog's inert JSON routes and the DOM: the in-memory session
 * token, the metadata snapshot read from the persistent library index, filters/sort/URL state, the
 * global selection and the frozen delete review. Query text goes to the index through
 * persistent-search.ts. app.ts renders `CatalogClient` state and forwards intent; it never speaks HTTP.
 *
 *   catalog origin (same-origin fetch; session cookie, X-Docs-Catalog, CSRF on every POST)
 *   GET  /all-docs/session ─ csrfToken, expiresAt
 *   GET  /all-docs/api/documents?cursor ─ ≤500-row pages at one generation ─► metadata snapshot
 *   POST /all-docs/api/search, /snippets ─ LibrarySearch: one request in flight, latest input wins
 *   POST /all-docs/api/index/retry ─ ≤48 failed refs, only when asked
 *   review ─► POST /all-docs/api/delete  (one frozen ref per request, sequential, oldest first)
 *
 * Safety invariants: a delete only ever sends ID/version refs frozen when the review opened; no
 * filter or query is re-evaluated after that. "Select all matching" is refused until the snapshot
 * is complete, the current search is complete at the snapshot's generation, and nothing in the
 * filtered scope is still pending or failed. The tab holds metadata, compact hits and bounded
 * snippets, never document bodies, and persists none of it. lock()/expiry abort owned requests and
 * drop everything; obsolete replies are discarded by session epoch and snapshot-run checks.
 */
import type {
  CatalogError, DeleteBatchRequest, DeleteProgress, DocumentFilter, DocumentSummary, FileKind,
  SelectionRef, SessionResponse, UploadId,
} from "../contracts";
import {
  LIBRARY_ENDPOINTS, LIBRARY_LIMITS,
  type LibraryDocument, type LibraryHit, type LibraryMetadata, type LibraryRetryRequest, type LibraryStatus,
  type MaintenanceReport, type SearchQuery,
} from "../library-contracts";
import {
  LibrarySearch, isCount, isLibraryStatus, libraryError, scopeKey, searchKey,
  type SearchFailure, type SearchPhase, type Snippet,
} from "./persistent-search";

export const FILE_KINDS: readonly FileKind[] = [
  "html", "markdown", "text", "data", "pdf", "image", "audio", "video", "archive", "office", "binary",
];
export const KIND_LABEL: Record<FileKind, string> = {
  html: "HTML", markdown: "Markdown", text: "Text", data: "Data", pdf: "PDF", image: "Image",
  audio: "Audio", video: "Video", archive: "Archive", office: "Office", binary: "File",
};

/** Cards are revealed 48 at a time: it divides evenly into 2, 3, 4 and 6 columns. */
export const RENDER_STEP = 48;
/**
 * Fresh snapshot restarts after the library changed mid-listing (stale generation). A busy library
 * must not keep a tab re-listing forever; past this the banner asks for Refresh instead.
 */
export const MAX_SNAPSHOT_RESTARTS = 2;
/** Manual indexing retry accepts at most 48 exact refs per request (frozen retry contract). */
export const RETRY_REFS = 48;
/**
 * One frozen ref gives each deletion an independent invocation allowance. Server admission of
 * 100 refs is distinct from the normal 40 combined SQL/R2 operation budget (10 more for cleanup).
 * Individual storage or budget failures remain per-document; the user confirms the set once.
 */
export const DELETE_REFS_PER_REQUEST = 1;
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

export interface CatalogClientDeps {
  /** Same-origin catalog transport; browsers attach the exact Origin on POST/DELETE themselves. */
  fetch(input: string, init: RequestInit): Promise<Response>;
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

/** The metadata snapshot: every library page read since open or Refresh. */
export interface ScanState {
  status: "idle" | "running" | "complete" | "incomplete" | "error";
  pages: number;
  error: string | null;
  /** The library kept changing while listing, so only a fresh Refresh can help (not Retry). */
  stale: boolean;
  finishedAt: number | null;
  /** Generation every page of this snapshot was read at; null before the first page. */
  generation: number | null;
}

/** What the toolbar, grid and gate need to know about the search for the current query. */
export interface SearchState {
  phase: SearchPhase;
  failure: SearchFailure | null;
  snippetFailure: string | null;
  /** Results are on screen, possibly still those of an earlier input. */
  held: boolean;
  /** The results on screen belong to the current input (false while a newer input is pending). */
  current: boolean;
  /** The results on screen are final for the current input. */
  complete: boolean;
  /** The query was too broad for the whole library, so it is searched within the active filter. */
  scoped: boolean;
  /** Identity of the results on screen (input, scope and generation), for render memoization. */
  resultsKey: string | null;
}

/**
 * Index coverage of every snapshot document inside the type and age filters, whatever the query
 * matches. Pending and failed rows are searched by title and filename only.
 */
export interface ScopeCoverage {
  total: number;
  searchable: number; // Indexed text, full or truncated.
  truncated: number;
  nameOnly: number;   // Metadata-only: no extractable text, matched by name only.
  nameOnlyKinds: FileKind[];
  unreadable: number; // Extraction error: matched by name only.
  pending: number;    // Not indexed yet.
  failed: number;     // Indexing failed; retryable.
}

export interface RetryState { status: "idle" | "running" | "done" | "error"; message: string | null }

export interface SelectionState {
  scope: "none" | "refs" | "matching";
  refs: Map<UploadId, SelectionRef>;
  /** Only in "matching" scope: cards the user unticked after selecting all matching. */
  excluded: Set<UploadId>;
  label: string | null;
  /** Age window active when refs were chosen, shown again in the review; null when none applied. */
  window: AgeWindow | null;
  /** Refs were added under different age windows, so no single cutoff describes them. */
  windowMixed: boolean;
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
  /** Kinds in the snapshot whose match count a scoped search can't know (outside its type scope). */
  unknownKinds: FileKind[];
  olderThan90: number | null;        // Every filter except age; null when a scoped search can't know.
  hiddenSelected: number;
  sort: SortKey;
  /** "Most matches" waits for a complete search; until then cards stay newest first. */
  provisional: boolean;
  scope: ScopeCoverage;
}

export type SelectAllGate = { ok: true; count: number } | { ok: false; reason: string };

function emptySelection(): SelectionState {
  return { scope: "none", refs: new Map(), excluded: new Set(), label: null, window: null, windowMixed: false, anchor: null };
}

function emptyScan(): ScanState {
  return { status: "idle", pages: 0, error: null, stale: false, finishedAt: null, generation: null };
}

function noun(count: number, one: string, many: string): string {
  return `${count.toLocaleString("en-US")} ${count === 1 ? one : many}`;
}

export class CatalogClient {
  view: View = "booting";
  login: LoginState = { problem: null, message: null, retryAfterSeconds: null, busy: false };
  /** Shown on the login view after a lock whose server-side logout failed. */
  lockNotice: string | null = null;
  scan: ScanState = emptyScan();
  /** Index status from the latest snapshot page; see libraryStatus() for the freshest view. */
  library: LibraryStatus | null = null;
  retry: RetryState = { status: "idle", message: null };
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
  private readonly docs = new Map<UploadId, LibraryDocument>();
  private session: SessionResponse | null = null;
  private expiryTimer: ReturnType<typeof setTimeout> | null = null;
  // Epoch: bumped by lock and expiry. Every await re-checks it before touching state.
  private epoch = 0;
  // Snapshot run: bumped by every Refresh, so pages of an abandoned listing are dropped.
  private scanRun = 0;
  private snapshotRestarts = 0;
  private abort = new AbortController();
  /** One per signed-in session; disposed on lock/expiry so its late replies are inert. */
  private search: LibrarySearch | null = null;
  private resumeCursor: string | null = null; // Next unread library page after a load error.
  private retryGeneration: number | null = null; // Generation reported by the last indexing retry.
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
    this.search = new LibrarySearch({
      post: (path, body, signal) => this.post(path, body, signal),
      visible: () => this.snippetDemand(),
      filter: () => this.activeFilter(),
      unauthorized: () => this.expire(),
      changed: () => this.changed(),
    });
    // A query restored from the URL is searched right away, alongside the metadata listing.
    this.search.setQuery(this.currentQuery(), true);
    this.startSnapshot();
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
    this.search?.dispose();
    this.search = null;
    this.session = null;
    this.docs.clear();
    this.scan = emptyScan();
    this.library = null;
    this.retry = { status: "idle", message: null };
    this.retryGeneration = null;
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
  // Metadata snapshot and the search seam.

  /** Re-lists the library from the first page. The current query is searched again alongside. */
  refresh(): void {
    if (this.view !== "library" || this.scan.status === "running" || this.review?.phase === "running") return;
    if (this.selection.scope === "matching") this.clearSelection("Selection cleared because the library was refreshed.");
    this.retry = { status: "idle", message: null };
    this.retryGeneration = null;
    this.search?.restart();
    this.startSnapshot();
  }

  /** Continues listing after a network or server error, keeping the pages already read. */
  retryScan(): void {
    if (this.view !== "library" || this.scan.status !== "error") return;
    // A stale generation can't be resumed: its cursor is bound to the old generation.
    if (this.scan.stale) return this.refresh();
    void this.discover(this.epoch, this.scanRun, this.resumeCursor);
  }

  /** Retries a failed search or its match previews for the current query. */
  retrySearch(): void {
    this.search?.retry();
  }

  /**
   * Asks the index to re-extract up to RETRY_REFS failed documents in the current type/age scope.
   * Rows change on the server only; the snapshot learns about it on Refresh (the reply's newer
   * generation raises the "library changed" notice).
   */
  async retryIndexing(): Promise<void> {
    const session = this.session;
    if (this.view !== "library" || !session || this.retry.status === "running") return;
    const window = this.window();
    const kinds = this.filters.kinds;
    const refs = [...this.docs.values()]
      .filter((doc) => doc.index.state === "failed" && inWindow(Date.parse(doc.uploadedAt), window)
        && (kinds.length === 0 || kinds.includes(doc.kind)))
      .slice(0, RETRY_REFS)
      .map((doc) => ({ id: doc.id, version: doc.version }));
    if (!refs.length) return;
    const epoch = this.epoch;
    this.retry = { status: "running", message: null };
    this.changed();
    let response: Response;
    let body: unknown;
    try {
      const request: LibraryRetryRequest = { version: 1, refs };
      response = await this.request(LIBRARY_ENDPOINTS.retry, { method: "POST", body: request, csrf: session.csrfToken });
      if (epoch !== this.epoch) return;
      if (response.status === 401) return this.expire();
      body = await readJson<unknown>(response);
    } catch {
      if (epoch !== this.epoch) return;
      this.retry = { status: "error", message: "Couldn't reach the library to retry indexing." };
      return this.changed();
    }
    if (epoch !== this.epoch) return;
    const report = response.ok ? parseReport(body) : null;
    if (!report) {
      this.retry = { status: "error", message: libraryError(body)?.message ?? `Retrying indexing failed (HTTP ${response.status}).` };
      return this.changed();
    }
    this.retryGeneration = Math.max(this.retryGeneration ?? 0, report.generation);
    const message = report.outcome === "busy" ? "Indexing is busy right now. Try again in a minute."
      : report.outcome === "paused" ? "Content indexing is paused by the index size budget. Names stay searchable."
      : `Retried ${noun(refs.length, "document", "documents")}: ${report.indexed.toLocaleString("en-US")} indexed, ${
        report.failed.toLocaleString("en-US")} still failing. Refresh to update coverage.`;
    this.retry = { status: report.outcome === "busy" ? "error" : "done", message };
    this.announcer(message);
    this.changed();
  }

  private startSnapshot(): void {
    this.scanRun++;
    this.snapshotRestarts = 0;
    this.docs.clear();
    this.library = null;
    this.scan = { ...emptyScan(), status: "running" };
    this.changed();
    void this.discover(this.epoch, this.scanRun, null);
  }

  /**
   * Reads ≤500-row metadata pages until the last one. Every page of a snapshot carries the first
   * page's generation: the server refuses a continuation whose generation moved (409), and a
   * mismatching page is treated the same, so a snapshot never mixes two library states.
   */
  private async discover(epoch: number, run: number, startCursor: string | null): Promise<void> {
    const live = () => epoch === this.epoch && run === this.scanRun;
    let cursor = startCursor;
    this.scan = { ...this.scan, status: "running", error: null, stale: false };
    this.changed();
    for (;;) {
      this.resumeCursor = cursor;
      const path = cursor === null ? LIBRARY_ENDPOINTS.documents
        : `${LIBRARY_ENDPOINTS.documents}?cursor=${encodeURIComponent(cursor)}`;
      let response: Response;
      let body: unknown;
      try {
        response = await this.request(path, { method: "GET" });
        if (!live()) return;
        if (response.status === 401) return this.expire();
        body = await readJson<unknown>(response);
      } catch {
        if (!live()) return;
        return this.scanFailed("Couldn't reach the library.");
      }
      if (!live()) return;
      if (!response.ok) {
        const error = libraryError(body);
        if (response.status === 409 || error?.code === "stale_generation" || (cursor !== null && error?.code === "invalid_cursor")) {
          return this.restartSnapshot(epoch, run);
        }
        return this.scanFailed(error?.message ?? `Loading the library failed (HTTP ${response.status}).`);
      }
      const page = parseLibraryPage(body);
      if (!page) return this.scanFailed("The library returned an unreadable page.");
      if (this.scan.generation !== null && page.generation !== this.scan.generation) return this.restartSnapshot(epoch, run);
      let unreadable = 0;
      for (const item of page.items) {
        if (isLibraryDocument(item)) this.docs.set(item.id, item);
        else unreadable++;
      }
      this.library = page.status;
      this.scan = { ...this.scan, generation: page.generation, pages: this.scan.pages + 1 };
      if (unreadable) {
        // Skipping an entry would make "all matching" a lie, so the whole snapshot becomes incomplete.
        this.scan = { ...this.scan, status: "incomplete", error: `${unreadable} library entries were unreadable.`, finishedAt: this.deps.now() };
        return this.changed();
      }
      if (page.nextCursor === null) {
        this.scan = { ...this.scan, status: "complete", error: null, finishedAt: this.deps.now() };
        this.resumeCursor = null;
        this.pruneSelection();
        return this.changed();
      }
      this.changed();
      cursor = page.nextCursor;
    }
  }

  /** The library changed mid-listing: start a clean snapshot, a bounded number of times. */
  private restartSnapshot(epoch: number, run: number): Promise<void> | void {
    if (this.snapshotRestarts >= MAX_SNAPSHOT_RESTARTS) {
      this.scan = { ...this.scan, status: "error", stale: true, error: "The library kept changing while it loaded." };
      return this.changed();
    }
    this.snapshotRestarts++;
    this.docs.clear();
    this.scan = { ...this.scan, pages: 0, generation: null };
    return this.discover(epoch, run, null);
  }

  private scanFailed(message: string): void {
    this.scan = { ...this.scan, status: "error", error: message };
    this.changed();
  }

  /** Rendered cards that matched, for the snippet lane. Snippets wait until the listing settles. */
  private snippetDemand(): SelectionRef[] {
    if (this.view !== "library" || this.scan.status === "running" || this.scan.status === "idle") return [];
    return this.rendered().filter((doc) => this.hitFor(doc)).map((doc) => ({ id: doc.id, version: doc.version }));
  }

  private currentQuery(): SearchQuery | null {
    if (!this.filters.text) return null;
    return { text: this.filters.text, mode: this.filters.regex ? "regex" : "literal", ignoreCase: !this.filters.matchCase };
  }

  private currentKey(): string | null {
    const query = this.currentQuery();
    return query ? searchKey(query) : null;
  }

  /** The type/age filter as a DocumentFilter, with the frozen cutoff instant. */
  private activeFilter(): DocumentFilter {
    return toDocumentFilter(this.window(), this.filters.kinds);
  }

  /** Held results answer the current query, and a scoped search's scope is the active filter. */
  private heldIsCurrent(): boolean {
    const held = this.search?.results;
    const key = this.currentKey();
    return key !== null && !!held && held.queryKey === key
      && (held.scope === null || scopeKey(held.scope) === scopeKey(this.activeFilter()));
  }

  searchState(): SearchState {
    const search = this.search;
    const held = search?.results ?? null;
    const key = this.currentKey();
    const current = this.heldIsCurrent();
    return {
      phase: search?.phase ?? "idle",
      failure: search?.failure ?? null,
      snippetFailure: search?.snippetFailure ?? null,
      held: key !== null && held !== null,
      current,
      complete: current && !!held?.complete,
      scoped: key !== null && !!held?.scope,
      resultsKey: key !== null && held ? `${held.queryKey}|${scopeKey(held.scope)}@${held.generation}` : null,
    };
  }

  /** A search or retry reported a generation other than the snapshot's: the library changed. */
  libraryChanged(): boolean {
    const snapshot = this.scan.generation;
    if (snapshot === null) return false;
    const seen = [this.search?.latestGeneration ?? null, this.retryGeneration].filter((value): value is number => value !== null);
    return seen.some((generation) => generation !== snapshot);
  }

  /** The freshest index status: a search reply's when one arrived after the snapshot page. */
  libraryStatus(): LibraryStatus | null {
    return this.search?.status ?? this.library;
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
    if (next.text !== before.text || next.regex !== before.regex || next.matchCase !== before.matchCase) {
      this.search?.setQuery(this.currentQuery());
    }
    if (next.age !== before.age || next.from !== before.from || next.to !== before.to || next.kinds.join() !== before.kinds.join()) {
      this.search?.filtersChanged();
    }
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
    this.search?.filtersChanged();
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
    // Held hits may still belong to an earlier input while a newer one is pending; the grid shows
    // them dimmed, and the gate below only trusts complete results for the current input.
    const held = key === null ? null : this.search?.results ?? null;
    const hits = held?.hits ?? null;
    const kinds = this.filters.kinds;
    const matchesQuery = (doc: DocumentSummary) => key === null || hits?.get(doc.id)?.version === doc.version;
    const ofKind = (doc: DocumentSummary) => kinds.length === 0 || kinds.includes(doc.kind);
    const olderBound = this.frozenNow - 90 * DAY_MS;
    const kindCounts = new Map<FileKind, number>();
    const scope: ScopeCoverage = {
      total: 0, searchable: 0, truncated: 0, nameOnly: 0, nameOnlyKinds: [], unreadable: 0, pending: 0, failed: 0,
    };
    const nameOnlyKinds = new Set<FileKind>();
    const presentKinds = new Set<FileKind>();
    let olderThan90 = 0;
    const matching: DocumentSummary[] = [];
    for (const doc of this.docs.values()) {
      const uploaded = Date.parse(doc.uploadedAt);
      const inAge = inWindow(uploaded, window);
      if (inAge) presentKinds.add(doc.kind);
      if (inAge && ofKind(doc)) {
        scope.total++;
        const index = doc.index;
        if (index.state === "pending") scope.pending++;
        else if (index.state === "failed") scope.failed++;
        else if (index.coverage === "metadata-only") {
          scope.nameOnly++;
          nameOnlyKinds.add(doc.kind);
        } else if (index.coverage === "error") scope.unreadable++;
        else {
          scope.searchable++;
          if (index.coverage === "truncated") scope.truncated++;
        }
      }
      if (!matchesQuery(doc)) continue;
      if (inAge) kindCounts.set(doc.kind, (kindCounts.get(doc.kind) ?? 0) + 1);
      if (ofKind(doc) && uploaded < olderBound) olderThan90++;
      if (inAge && ofKind(doc)) matching.push(doc);
    }
    scope.nameOnlyKinds = FILE_KINDS.filter((kind) => nameOnlyKinds.has(kind));
    // A scoped search has no hits outside its scope, so those alternatives' counts are unknown.
    const searched = held?.scope ?? null;
    const unknownKinds = searched?.kinds.length
      ? FILE_KINDS.filter((kind) => presentKinds.has(kind) && !searched.kinds.includes(kind)) : [];
    const olderKnown = !searched || (searched.uploadedAfter === null
      && (searched.uploadedBefore === null || Date.parse(searched.uploadedBefore) >= olderBound));
    const sort = this.effectiveSort();
    // Counts of a partial scan still grow, so "Most matches" order would reshuffle under the user.
    const provisional = sort === "matches" && !(this.heldIsCurrent() && held?.complete);
    const compare = comparator(provisional ? "newest" : sort, hits);
    matching.sort(compare);
    const selected = this.selectedIds();
    const visible = this.selectedOnly
      ? [...selected].map((id) => this.docs.get(id)).filter((doc): doc is LibraryDocument => !!doc).sort(compare)
      : matching;
    let hiddenSelected = 0;
    if (!this.selectedOnly && selected.size) {
      const shown = new Set(matching.map((doc) => doc.id));
      for (const id of selected) if (!shown.has(id)) hiddenSelected++;
    }
    const value: Results = {
      matching, visible, kindCounts, unknownKinds, olderThan90: olderKnown ? olderThan90 : null, hiddenSelected, sort, provisional, scope,
    };
    this.resultsCache = { revision: this.revision, value };
    return value;
  }

  rendered(): DocumentSummary[] {
    return this.results().visible.slice(0, this.renderLimit);
  }

  summary(id: UploadId): DocumentSummary | null {
    return this.docs.get(id) ?? null;
  }

  /** Index state of one snapshot document: pending, indexed (with coverage) or failed. */
  indexOf(id: UploadId): LibraryMetadata | null {
    return this.docs.get(id)?.index ?? null;
  }

  hitFor(doc: DocumentSummary): LibraryHit | null {
    if (this.currentKey() === null) return null;
    const hit = this.search?.results?.hits.get(doc.id);
    return hit && hit.version === doc.version ? hit : null;
  }

  /** The match preview for a hit card: ready, unavailable, or null while not fetched. */
  snippetFor(doc: DocumentSummary): Snippet | null {
    if (this.currentKey() === null || !this.hitFor(doc)) return null;
    return this.search?.snippet(doc.id, doc.version) ?? null;
  }

  observed(): DocumentSummary[] {
    return [...this.docs.values()];
  }

  /** Whether "Select all N matching" may freeze the current matching set, and why not. */
  selectAllGate(): SelectAllGate {
    const scan = this.scan;
    if (scan.status === "running") return { ok: false, reason: `Available when the library finishes loading (${this.docs.size} found so far)` };
    if (scan.status !== "complete") return { ok: false, reason: "Unavailable because the library listing is incomplete" };
    if (this.selectedOnly) return { ok: false, reason: "Turn off “Show selected” to select by filter" };
    // A known newer generation means the snapshot is stale, with or without query text.
    if (this.libraryChanged()) return { ok: false, reason: "The library changed since it loaded — Refresh to select all matching" };
    const key = this.currentKey();
    if (key !== null) {
      const search = this.search;
      const held = search?.results ?? null;
      if (search?.failure) return { ok: false, reason: "Unavailable while the search reports an error" };
      // phase covers a restart still running behind complete results that stay on screen.
      if (!held || !this.heldIsCurrent() || !held.complete || search?.phase !== "complete") {
        return { ok: false, reason: "Available when the search finishes" };
      }
      // Hits and snapshot must describe the same library state, or "all matching" could miss changes.
      if (held.generation !== scan.generation) return { ok: false, reason: "The library changed since it loaded — Refresh to select all matching" };
    }
    // Frozen contract: no pending or failed row inside the type/age filters, with or without query
    // text (a pending row may hold body matches the index can't see yet). Rows outside the filters
    // don't count, and explicit refs or page selection stay available meanwhile.
    const scope = this.results().scope;
    if (scope.pending) {
      return { ok: false, reason: `Unavailable: ${noun(scope.pending, "document in these filters isn't", "documents in these filters aren't")} indexed yet` };
    }
    if (scope.failed) {
      return { ok: false, reason: `Unavailable: ${noun(scope.failed, "document", "documents")} couldn't be indexed — retry ${scope.failed === 1 ? "it" : "them"} first` };
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
    const doc = this.docs.get(id);
    if (!doc) return;
    const order = this.rendered().map((summary) => summary.id);
    const anchor = this.selection.anchor;
    const targets = range && anchor && order.includes(anchor) && order.includes(id)
      ? order.slice(Math.min(order.indexOf(anchor), order.indexOf(id)), Math.max(order.indexOf(anchor), order.indexOf(id)) + 1)
      : [id];
    const select = !this.isSelected(id);
    const wasEmpty = this.selection.scope === "none";
    const selection = wasEmpty ? { ...emptySelection(), scope: "refs" as const } : this.selection;
    if (select && selection.scope === "refs") this.noteWindow(selection, wasEmpty);
    for (const target of targets) {
      const summary = this.docs.get(target);
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
      const wasEmpty = this.selection.scope === "none";
      const refs = new Map(this.selection.refs);
      for (const doc of rendered) refs.set(doc.id, { id: doc.id, version: doc.version });
      this.selection = { ...this.selection, scope: "refs", refs, excluded: new Set(), label: null };
      this.noteWindow(this.selection, wasEmpty);
    }
    this.changed();
  }

  /** Records the age window refs were chosen under; a second, different window makes it mixed. */
  private noteWindow(selection: SelectionState, wasEmpty: boolean): void {
    const window = this.window();
    const active = window.after === null && window.before === null ? null : window;
    if (wasEmpty) {
      selection.window = active;
      selection.windowMixed = false;
    } else if (selection.window?.after !== active?.after || selection.window?.before !== active?.before) {
      selection.windowMixed = true;
    }
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
      window: window.after === null && window.before === null ? null : window, windowMixed: false, anchor: null,
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
      if (this.docs.get(id)?.version !== ref.version) {
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
  // Delete review: freeze, confirm once, commit one ref per request, keep failures selected.

  /** Freezes the selection (or one card) into explicit refs with the metadata observed now. */
  openReview(single?: UploadId): ReviewState | null {
    if (this.view !== "library" || this.review?.phase === "running") return null;
    const refs: SelectionRef[] = single
      ? (this.docs.has(single) ? [{ id: single, version: (this.docs.get(single) as LibraryDocument).version }] : [])
      : [...this.selectedIds()].map((id) => this.selection.refs.get(id) as SelectionRef);
    const items: ReviewItem[] = [];
    for (const ref of refs) {
      const summary = this.docs.get(ref.id);
      if (summary) items.push({ ref: { id: ref.id, version: ref.version }, summary });
    }
    if (!items.length) return null;
    items.sort((a, b) => Date.parse(a.summary.uploadedAt) - Date.parse(b.summary.uploadedAt) || compareText(a.ref.id, b.ref.id));
    // The cutoff is display context for the frozen refs, never a predicate: it is shown only when
    // the refs were chosen under one age window and every frozen item still satisfies it.
    const chosen = single || this.selection.windowMixed ? null : this.selection.window;
    const window = chosen && items.every((item) => inWindow(Date.parse(item.summary.uploadedAt), chosen)) ? chosen : null;
    this.review = {
      source: single ? "single" : "selection",
      items,
      totalBytes: items.reduce((sum, item) => sum + item.summary.sizeBytes, 0),
      label: !single && this.selection.scope === "matching" ? this.selection.label : null,
      window,
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
    for (let start = 0; start < refs.length; start += DELETE_REFS_PER_REQUEST) {
      if (review.stopRequested) {
        review.phase = "stopped";
        return this.changed();
      }
      const batch = refs.slice(start, start + DELETE_REFS_PER_REQUEST);
      // The frozen contract confirms each request on its own; the typed global count was checked above.
      const body: DeleteBatchRequest = {
        version: 1, items: batch, confirmCount: batch.length, confirmation: `DELETE ${batch.length} documents`,
      };
      let response: Response;
      try {
        response = await this.request("/all-docs/api/delete", { method: "POST", body, csrf: session.csrfToken });
      } catch {
        if (epoch !== this.epoch || this.review !== review) return;
        this.failBatch(review, batch, "Couldn't reach storage; this request's result is unknown, so it was kept.");
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
    if (review.phase !== "review" && review.source === "selection") {
      // Unprocessed, changed and failed refs stay selected as explicit refs, never as a predicate.
      const { window, windowMixed } = this.selection;
      this.selection = { ...emptySelection(), scope: "refs", refs: kept, window, windowMixed };
    } else if (review.phase !== "review" && kept.size) {
      // A single-card delete that didn't succeed joins the existing selection, which is otherwise kept.
      const selection = this.selection.scope === "none" ? { ...emptySelection(), scope: "refs" as const } : this.selection;
      for (const [id, ref] of kept) {
        if (selection.scope === "matching" && selection.refs.has(id)) selection.excluded.delete(id);
        else selection.refs.set(id, ref);
      }
      this.selection = selection;
    }
    this.normalizeSelection();
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

  private async request(path: string, init: { method: string; body?: unknown; csrf?: string; signal?: AbortSignal }): Promise<Response> {
    const headers: Record<string, string> = { Accept: "application/json", "X-Docs-Catalog": "1" };
    if (init.body !== undefined) headers["Content-Type"] = "application/json";
    if (init.csrf) headers["X-CSRF-Token"] = init.csrf;
    // redirect: manual keeps JSON calls on this origin; a redirect is treated as an error response.
    return this.deps.fetch(path, {
      method: init.method, headers, credentials: "same-origin", cache: "no-store", redirect: "manual",
      body: init.body === undefined ? undefined : JSON.stringify(init.body), signal: init.signal ?? this.abort.signal,
    });
  }

  /**
   * LibrarySearch's transport. It passes its own per-request signal, which its dispose() aborts on
   * lock/expiry; query text travels only in the POST body, never in a URL.
   */
  private async post(path: string, body: unknown, signal: AbortSignal): Promise<{ status: number; body: unknown }> {
    const session = this.session;
    if (!session) throw new Error("The session has ended.");
    const response = await this.request(path, { method: "POST", body, csrf: session.csrfToken, signal });
    return { status: response.status, body: await readJson<unknown>(response) };
  }

  private changed(): void {
    this.revision++;
    for (const listener of this.listeners) listener();
    // Any change can alter which result cards are rendered; the lane fetches their snippets when free.
    this.search?.demandChanged();
  }
}

function comparator(sort: SortKey, hits: ReadonlyMap<UploadId, LibraryHit> | null) {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSummary(value: unknown): value is DocumentSummary {
  return isRecord(value) && typeof value.id === "string" && /^[A-Za-z0-9]{8}$/.test(value.id)
    && typeof value.version === "string" && value.version.length > 0 && typeof value.title === "string"
    && typeof value.filename === "string" && (FILE_KINDS as readonly unknown[]).includes(value.kind)
    && typeof value.mime === "string" && typeof value.sizeBytes === "number" && typeof value.uploadedAt === "string"
    && !Number.isNaN(Date.parse(value.uploadedAt)) && typeof value.publicUrl === "string"
    && typeof value.rawUrl === "string" && typeof value.objectCount === "number"
    && Array.isArray(value.warnings) && value.warnings.every((warning) => typeof warning === "string");
}

const COVERAGES: readonly unknown[] = ["full", "truncated", "metadata-only", "error"];

function isLibraryDocument(value: unknown): value is LibraryDocument {
  if (!isSummary(value)) return false;
  const index = (value as { index?: unknown }).index;
  return isRecord(index) && ["pending", "indexed", "failed"].includes(index.state as string)
    && (index.coverage === null || COVERAGES.includes(index.coverage))
    && (index.reason === null || typeof index.reason === "string")
    && isCount(index.indexedBytes) && isCount(index.extractorVersion);
}

interface PageReply { generation: number; items: unknown[]; nextCursor: string | null; status: LibraryStatus }

function parseLibraryPage(value: unknown): PageReply | null {
  if (!isRecord(value) || value.version !== 1 || !isCount(value.generation) || !Array.isArray(value.items)
    || value.items.length > LIBRARY_LIMITS.metadataRows || !isLibraryStatus(value.status)) return null;
  const { nextCursor } = value;
  if (nextCursor !== null && (typeof nextCursor !== "string" || nextCursor === "")) return null;
  // scanComplete is exactly nextCursor === null (frozen contract); anything else is unreadable.
  if (value.scanComplete !== (nextCursor === null)) return null;
  return { generation: value.generation, items: value.items, nextCursor, status: value.status };
}

function parseReport(value: unknown): MaintenanceReport | null {
  if (!isRecord(value) || value.version !== 1 || !isCount(value.generation)
    || !["complete", "partial", "busy", "paused"].includes(value.outcome as string)
    || !isCount(value.indexed) || !isCount(value.failed) || !isLibraryStatus(value.status)) return null;
  return value as unknown as MaintenanceReport;
}

function isDeleteProgress(value: DeleteProgress | null): value is DeleteProgress {
  return !!value && value.version === 1 && Array.isArray(value.outcomes);
}
