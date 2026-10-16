import type { DocumentSummary, SelectionRef } from "../contracts";
import type { LibraryCounts, LibraryDocument, LibraryHit, LibrarySearchRequest,
  LibrarySnippetsRequest, LibraryStatus } from "../library-contracts";
import { LIBRARY_LIMITS as LIMIT } from "../library-contracts";
import { compileSearchMatcher, SearchError } from "../search";
import type { CompiledSearchMatcher, SearchQuery, SearchHit } from "../search";
import type { LibraryDependencies, LibraryQueries } from "./contracts";
import { LibraryIndexError } from "./contracts";

const encoder = new TextEncoder();
const kinds = new Set(["html", "markdown", "text", "data", "pdf", "image", "audio", "video", "archive", "office", "binary"]);
// A tombstone hides even a still-indexed row: deletion and delayed cleanup need not coincide.
const visible = "d.state <> 'deleting' AND NOT EXISTS (SELECT 1 FROM deleted_ids x WHERE x.id=d.id)";
const countColumns = `count(*) AS documents,
  coalesce(sum(d.state='pending'),0) AS pending, coalesce(sum(d.state='indexed'),0) AS indexed,
  coalesce(sum(d.state='failed'),0) AS failed, coalesce(sum(d.coverage='metadata-only'),0) AS metadataOnly,
  coalesce(sum(d.coverage='truncated'),0) AS truncated`;
const metadataColumns = `d.doc,d.id,d.version,d.title,d.filename,d.kind,d.mime,d.size_bytes,
  d.uploaded_at_iso,d.time_source,d.created_at,d.object_count,d.warnings_json,
  d.state,d.coverage,d.reason,d.indexed_bytes,d.extractor`;

/** Internal continuation, separately authenticated by HTTP. Rowids are never reused; the exact
 * validated request and visible generation prevent cross-query replay or mixed snapshots.
 */
interface Cursor { v: 1; op: "page" | "search"; g: number; after: number; hits: number; identity: string }
interface Predicate { sql: string; args: (string | number)[] }
interface Snapshot { generation: number; status: LibraryStatus }
interface MetadataRow {
  doc: number; id: string; version: string; title: string; filename: string;
  kind: DocumentSummary["kind"]; mime: string; size_bytes: number; uploaded_at_iso: string;
  time_source: "r2"; created_at: string | null; object_count: number; warnings_json: string;
  state: LibraryDocument["index"]["state"]; coverage: LibraryDocument["index"]["coverage"];
  reason: string | null; indexed_bytes: number; extractor: number;
}

/** Read-only implementation of the LibraryIndex query seam. SQL/layout, matcher ownership,
 * generation checks and bounded body lifetimes stay here; no read reaches R2 or extraction.
 */
export function createLibraryQueries(deps: LibraryDependencies): LibraryQueries {
  return {
    page: (raw) => safely(async () => {
      const cursor = decodeCursor(raw, "page", ""); // Admission must precede any D1 I/O.
      const snapshot = await readLibraryState(deps);
      checkGeneration(cursor?.g, snapshot.generation);
      const rows = (await deps.db.prepare(`SELECT ${metadataColumns} FROM documents d
        WHERE ${visible} AND d.doc>? ORDER BY d.doc LIMIT ?`)
        .bind(cursor?.after ?? 0, LIMIT.metadataRows).all<MetadataRow>()).results;
      const last = rows.at(-1)?.doc ?? cursor?.after ?? 0;
      const more = rows.length === LIMIT.metadataRows && await hasMore(deps, last);
      await recheckGeneration(deps, snapshot.generation);
      return {
        version: 1, generation: snapshot.generation, items: rows.map((row) => toMetadata(deps, row)),
        nextCursor: more ? encodeCursor({ v: 1, op: "page", g: snapshot.generation, after: last, hits: 0, identity: "" }) : null,
        scanComplete: !more, observedAt: new Date(deps.now()).toISOString(), status: snapshot.status,
      };
    }),
    search: (request) => safely(async () => {
      const admitted = admitSearch(request);
      const clock = sliceClock(deps);
      const raw = request.cursor;
      // Hash the exact identity, rather than embedding potentially long valid date strings
      // in continuations. The HTTP envelope authenticates the raw cursor separately.
      const identity = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(admitted.identity))),
        (b) => b.toString(16).padStart(2, "0")).join("");
      const cursor = decodeCursor(raw, "search", identity);
      const matcher = compileSearchMatcher(admitted.query, { maxElapsedMs: LIMIT.sliceMs });
      try {
        const snapshot = await readLibraryState(deps);
        checkGeneration(cursor?.g, snapshot.generation);
        const scope = await deps.db.prepare(`SELECT ${countColumns} FROM documents d
          WHERE ${visible} AND ${admitted.filter.sql}`).bind(...admitted.filter.args).first<LibraryCounts>();
        if (!scope) throw new Error("Missing scope");
        if (!admitted.query.text && scope.documents > LIMIT.hits) hitBudget();
        const strategy = sqlLiteral(admitted.query);
        const candidates = candidatePredicate(admitted.query, admitted.filter);
        const hits: LibraryHit[] = [];
        let after = cursor?.after ?? 0;
        let bytes = 0;
        let pages = 0;
        let complete = false;
        // SQL counts stay inside D1. Charge a conservative needle-comparison factor in
        // addition to byte/time limits; long repetitive literals cannot hide unbounded SQL.
        const byteBudget = strategy && admitted.query.text
          ? Math.min(LIMIT.sliceBytes, Math.floor(128 * 1024 * 1024 / admitted.query.text.length)) : LIMIT.sliceBytes;
        // The local page cap also bounds host/test consumers without an invocation ledger.
        // HTTP's wrapper owns charging; leave room for lookahead and the generation recheck.
        while (!clock.expired() && bytes < byteBudget && pages < 32 && statementsRemaining(deps) >= 3) {
          const limit = !admitted.query.text || strategy ? LIMIT.metadataRows
            : Math.min(LIMIT.bodyRows, Math.floor((byteBudget - bytes) / LIMIT.bodyBytes));
          if (limit < 1) break;
          const page = await searchPage(deps, admitted.query, strategy, candidates, matcher, after, limit, clock, byteBudget - bytes);
          pages++;
          after = page.after;
          bytes += page.bytes;
          hits.push(...page.hits);
          if ((cursor?.hits ?? 0) + hits.length > LIMIT.hits) hitBudget();
          if (page.exhausted) { complete = true; break; }
          if (page.stopped) break;
        }
        if (!complete) complete = !await hasMore(deps, after, candidates);
        if (!complete && after === (cursor?.after ?? 0)) {
          // A slow DB wait or an indivisible oversized work item must not yield the same
          // cursor forever. Compact counts already computed are consumed even after a wait.
          if (!clock.expired() && strategy && pages > 0) {
            throw new LibraryIndexError("search_budget_exceeded", "A document exceeds the SQL counting work budget. Narrow the query.", false);
          }
          throw new LibraryIndexError("library_unavailable", "The query slice made no progress. Retry the request.", true);
        }
        await recheckGeneration(deps, snapshot.generation);
        return {
          version: 1, generation: snapshot.generation, hits, complete,
          nextCursor: complete ? null : encodeCursor({ v: 1, op: "search", g: snapshot.generation,
            after, hits: (cursor?.hits ?? 0) + hits.length, identity }),
          scope: { documents: scope.documents, pending: scope.pending, failed: scope.failed }, status: snapshot.status,
        };
      } finally { matcher.dispose(); }
    }),
    snippets: (request) => safely(async () => {
      const admitted = admitSnippets(request);
      const clock = sliceClock(deps);
      const matcher = compileSearchMatcher(admitted.query, { maxElapsedMs: LIMIT.sliceMs });
      try {
        checkGeneration(admitted.generation, generation(await deps.db.prepare("SELECT value FROM index_meta WHERE key='generation'").first("value")));
        const hits: SearchHit[] = [];
        const unavailable: SelectionRef[] = [];
        let processed = 0;
        let bytes = 0;
        while (processed < admitted.refs.length && !clock.expired() && bytes < LIMIT.sliceBytes
          && statementsRemaining(deps) >= 2) {
          const limit = admitted.query.text ? Math.min(LIMIT.bodyRows, Math.floor((LIMIT.sliceBytes - bytes) / LIMIT.bodyBytes)) : LIMIT.bodyRows;
          if (limit < 1) break;
          const page = await snippetPage(deps, admitted.query, admitted.refs.slice(processed, processed + limit), matcher, clock);
          processed += page.processed;
          bytes += page.bytes;
          hits.push(...page.hits);
          unavailable.push(...page.unavailable);
          if (page.stopped) break;
        }
        await recheckGeneration(deps, admitted.generation);
        return { version: 1, generation: admitted.generation, hits, unavailable, remaining: admitted.refs.slice(processed) };
      } finally { matcher.dispose(); }
    }),
  };
}

/** Maintenance shares the exact visibility/status interpretation without exposing SQL to its
 * caller. Cost: two small statements in one transactional batch, then one generation recheck
 * (three total). No bodies or metadata pages. Housekeeping never changes visible generation.
 */
export function readLibraryState(deps: LibraryDependencies): Promise<Snapshot> {
  return safely(async () => {
    const snapshot = await readSnapshot(deps);
    await recheckGeneration(deps, snapshot.generation);
    return snapshot;
  });
}

async function safely<T>(work: () => Promise<T>): Promise<T> {
  try { return await work(); }
  catch (error) {
    if (error instanceof LibraryIndexError) throw error;
    if (error instanceof SearchError) throw new LibraryIndexError(error.code, error.message, false);
    throw new LibraryIndexError("library_unavailable", "The library index could not be read. Retry the request.", true);
  }
}

function invalidCursor(): never {
  throw new LibraryIndexError("invalid_cursor", "Invalid library continuation.", false);
}
function nonnegative(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function decodeCursor(raw: unknown, op: Cursor["op"], identity: string): Cursor | null {
  if (raw === undefined) return null;
  if (typeof raw !== "string" || !raw.length || raw.length > 8192 || !/^[A-Za-z0-9_-]+$/.test(raw)) invalidCursor();
  try {
    const bytes = Uint8Array.from(atob(raw.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
    if (!value || Object.keys(value).sort().join() !== "after,g,hits,identity,op,v"
      || value.v !== 1 || value.op !== op || value.identity !== identity
      || !nonnegative(value.g) || !nonnegative(value.after) || !nonnegative(value.hits)
      || value.hits > LIMIT.hits || (op === "page" && value.hits !== 0)) invalidCursor();
    return value as Cursor;
  } catch { return invalidCursor(); }
}
function encodeCursor(cursor: Cursor): string {
  return btoa(String.fromCharCode(...encoder.encode(JSON.stringify(cursor))))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function checkGeneration(expected: number | undefined, actual: number): void {
  if (expected !== undefined && expected !== actual) {
    throw new LibraryIndexError("stale_generation", "The library changed. Refresh and restart the query.", true);
  }
}
function generation(value: unknown): number {
  const parsed = typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value) ? Number(value) : NaN;
  if (!nonnegative(parsed)) throw new Error("Invalid stored generation");
  return parsed;
}
async function recheckGeneration(deps: LibraryDependencies, expected: number): Promise<void> {
  checkGeneration(expected, generation(await deps.db.prepare("SELECT value FROM index_meta WHERE key='generation'").first("value")));
}

async function readSnapshot(deps: LibraryDependencies): Promise<Snapshot> {
  // D1 batch is transactional. The trailing generation read covers every later asynchronous
  // page/snippet read; no caller may merge output after an intervening visible mutation.
  const [meta, counts] = await deps.db.batch<Record<string, string | number>>([
    deps.db.prepare("SELECT key,value FROM index_meta WHERE key IN ('generation','storage','last-reconciled-at','anomalies')"),
    deps.db.prepare(`SELECT ${countColumns}, coalesce(sum(CASE WHEN d.state='pending'
      AND d.kind IN ('html','markdown','text','data','pdf','office') THEN min(d.size_bytes,524288) ELSE 0 END),0) AS planning
      FROM documents d WHERE ${visible}`),
  ]);
  const values = new Map(meta.results.map((r) => [r.key as string, r.value as string]));
  const global = counts.results[0] as unknown as LibraryCounts & { planning: number };
  const bytes = counts.meta.size_after;
  const stored: LibraryStatus["storage"] | null = values.has("storage") ? JSON.parse(values.get("storage")!) : null;
  if (stored && (!nonnegative(stored.bytes) || !nonnegative(stored.budgetBytes)
    || (stored.planningBytes !== null && !nonnegative(stored.planningBytes))
    || (stored.projectedBytes !== null && !nonnegative(stored.projectedBytes))
    || typeof stored.paused !== "boolean" || (stored.reason !== null && typeof stored.reason !== "string"))) {
    throw new Error("Invalid stored status");
  }
  const last = values.has("last-reconciled-at") ? JSON.parse(values.get("last-reconciled-at")!) : null;
  if (last !== null && (typeof last !== "string" || !Number.isFinite(Date.parse(last)))) throw new Error("Invalid reconcile status");
  const { planning: _, ...visibleCounts } = global;
  return {
    generation: generation(values.get("generation")),
    status: {
      counts: visibleCounts, lastReconciledAt: last,
      anomalies: values.has("anomalies") ? generation(values.get("anomalies")) : 0,
      storage: { bytes, budgetBytes: deps.config.sizeBudgetBytes,
        planningBytes: bytes + Math.ceil(3.2 * global.planning), projectedBytes: stored?.projectedBytes ?? null,
        paused: stored?.paused ?? false, reason: stored?.reason ?? null },
    },
  };
}

function toMetadata(deps: LibraryDependencies, row: MetadataRow): LibraryDocument {
  const origin = deps.publicOrigin.replace(/\/$/, "");
  return {
    id: row.id, version: row.version, title: row.title, filename: row.filename, kind: row.kind,
    mime: row.mime, sizeBytes: row.size_bytes, uploadedAt: row.uploaded_at_iso, timeSource: row.time_source,
    createdAt: row.created_at, objectCount: row.object_count, warnings: JSON.parse(row.warnings_json),
    publicUrl: `${origin}/${row.id}`, rawUrl: `${origin}/${row.id}/raw`, downloadUrl: `${origin}/${row.id}/download`,
    index: { state: row.state, coverage: row.coverage, reason: row.reason, indexedBytes: row.indexed_bytes, extractorVersion: row.extractor },
  };
}
async function hasMore(deps: LibraryDependencies, after: number, filter: Predicate = { sql: "1", args: [] }): Promise<boolean> {
  return (await deps.db.prepare(`SELECT 1 FROM documents d WHERE ${visible} AND d.doc>? AND ${filter.sql} LIMIT 1`)
    .bind(after, ...filter.args).first()) !== null;
}

function invalidRequest(message: string): never {
  throw new LibraryIndexError("invalid_search_request", message, false);
}
function hitBudget(): never {
  throw new LibraryIndexError("search_budget_exceeded", "Search exceeds 10,000 hits. Narrow the filters.", false);
}
function admitQuery(query: SearchQuery): SearchQuery {
  if (!query || typeof query.text !== "string" || !["literal", "regex"].includes(query.mode)
    || typeof query.ignoreCase !== "boolean") invalidRequest("Search requires an explicit literal/regex mode and case flag.");
  if (encoder.encode(query.text).length > LIMIT.queryBytes) {
    throw new LibraryIndexError("search_budget_exceeded", "Search queries are limited to 256 UTF-8 bytes.", false);
  }
  return { text: query.text, mode: query.mode, ignoreCase: query.ignoreCase };
}
function admitSearch(request: LibrarySearchRequest): { query: SearchQuery; filter: Predicate; identity: string } {
  if (!request || request.version !== 1) invalidRequest("Search requires protocol version 1.");
  const query = admitQuery(request.query);
  const filter = request.filter;
  if (!filter || !Array.isArray(filter.kinds) || filter.kinds.length > kinds.size
    || filter.kinds.some((kind) => !kinds.has(kind))) invalidRequest("Invalid document kind filters.");
  const parts: string[] = [];
  const args: (string | number)[] = [];
  if (filter.kinds.length) {
    parts.push(`d.kind IN (${filter.kinds.map(() => "?").join(",")})`);
    args.push(...filter.kinds);
  }
  for (const [key, operator] of [["uploadedBefore", "<"], ["uploadedAfter", ">="]] as const) {
    const value = filter[key];
    if (value === null) continue;
    const date = typeof value === "string" ? Date.parse(value) : NaN;
    if (!Number.isFinite(date)) invalidRequest("Upload date filters must be timestamps or null.");
    parts.push(`d.uploaded_at ${operator} ?`);
    args.push(date);
  }
  return { query, filter: { sql: parts.join(" AND ") || "1", args },
    identity: JSON.stringify([query.text, query.mode, query.ignoreCase, [...filter.kinds], filter.uploadedBefore, filter.uploadedAfter]) };
}

function sliceClock(deps: LibraryDependencies) {
  const start = performance.now();
  const epoch = deps.now();
  return { expired: () => performance.now() - start >= LIMIT.sliceMs || deps.now() - epoch >= LIMIT.sliceMs };
}
type SliceClock = ReturnType<typeof sliceClock>;

function statementsRemaining(deps: LibraryDependencies): number {
  // The optional ledger is supplied by HTTP after wrapping the actual D1/R2 resources.
  // Inspecting it never charges; SQL execution is charged exactly once by that wrapper.
  return deps.budget?.remaining ?? Infinity;
}

/** Exact SQL admission is intentionally narrower than FTS folding. ASCII patterns use only
 * RE2JS's audited simple-fold orbits: ASCII capitals, Kelvin sign and long s. SQLite lower()
 * folds ASCII only; never substitute JavaScript/Unicode lowercasing here. Other literals use RE2.
 */
function sqlLiteral(query: SearchQuery): boolean {
  return query.mode === "literal" && /^[\x01-\x7f]*$/.test(query.text);
}
function candidatePredicate(query: SearchQuery, filter: Predicate): Predicate {
  if (!sqlLiteral(query) || query.text.length < 3 || /[^\x20-\x7e]/.test(query.text)) return filter;
  // Binding prevents SQL injection; double-quoted FTS phrases additionally make every FTS
  // operator inert. Trigram folds are a candidate superset, never the exact count authority.
  const quoted = `"${query.text.replace(/"/g, '""')}"`;
  return { sql: `(${filter.sql}) AND (d.doc IN (SELECT rowid FROM document_fts WHERE document_fts MATCH ?)
    OR instr(d.title,char(0))>0 OR instr(d.filename,char(0))>0)`, args: [...filter.args, quoted] };
}
function foldedSQL(field: string, ignoreCase: boolean): string {
  return ignoreCase ? `replace(replace(lower(${field}),char(8490),'k'),char(383),'s')` : field;
}

interface SearchRow { doc: number; id: string; version: string; filename: string; title: string; body: string; bytes: number; matchCount: number }
interface SearchPage { after: number; bytes: number; hits: LibraryHit[]; exhausted: boolean; stopped: boolean }
async function searchPage(deps: LibraryDependencies, query: SearchQuery, sql: boolean, filter: Predicate,
  matcher: CompiledSearchMatcher, after: number, limit: number, clock: SliceClock, byteBudget: number): Promise<SearchPage> {
  const body = "CASE WHEN d.state='indexed' AND d.coverage IN ('full','truncated') THEN coalesce(t.body,'') ELSE '' END";
  let statement: D1PreparedStatement;
  if (!query.text) {
    statement = deps.db.prepare(`SELECT d.doc,d.id,d.version,0 AS bytes,0 AS matchCount
      FROM documents d WHERE ${visible} AND d.doc>? AND ${filter.sql} ORDER BY d.doc LIMIT ?`)
      .bind(after, ...filter.args, limit);
  } else if (sql) {
    // First materialize small candidate keys and their prefix byte totals. Only that bounded
    // prefix joins text: at most 4 MiB per SQL count statement, up to 500 compact result rows.
    // records owns indexed_bytes == stored UTF8 body bytes. Unlike RE2/snippets, no bodies
    // cross the D1 boundary, so applying the eight-returned-body cap here wastes SQL calls.
    const counts = ["filename", "title", "body"].map((field) =>
      `(length(CAST(${field} AS BLOB))-length(CAST(replace(${field},q.term,'') AS BLOB)))/length(q.term)`).join("+");
    const term = query.ignoreCase ? query.text.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32)) : query.text;
    statement = deps.db.prepare(`WITH candidates AS MATERIALIZED (
      SELECT d.doc,1+length(CAST(d.filename AS BLOB))+length(CAST(d.title AS BLOB))+
        CASE WHEN d.state='indexed' AND d.coverage IN ('full','truncated') THEN d.indexed_bytes ELSE 0 END AS bytes FROM documents d
      WHERE ${visible} AND d.doc>? AND ${filter.sql} ORDER BY d.doc LIMIT ?
    ), bounded AS MATERIALIZED (
      SELECT doc,bytes,sum(bytes) OVER (ORDER BY doc ROWS UNBOUNDED PRECEDING) AS total FROM candidates
    ), selected AS MATERIALIZED (SELECT doc,bytes FROM bounded WHERE total<=?),
    fields AS MATERIALIZED (SELECT d.doc,d.id,d.version,s.bytes,
      ${foldedSQL("d.filename", query.ignoreCase)} AS filename,${foldedSQL("d.title", query.ignoreCase)} AS title,
      ${foldedSQL(body, query.ignoreCase)} AS body FROM selected s JOIN documents d ON d.doc=s.doc
      LEFT JOIN document_text t ON t.doc=d.doc), q AS (SELECT ? AS term)
      SELECT doc,id,version,bytes,${counts} AS matchCount,(SELECT count(*) FROM candidates) AS candidates FROM fields,q ORDER BY doc`)
      .bind(after, ...filter.args, limit, Math.min(byteBudget, 4 * 1024 * 1024), term);
  } else {
    statement = deps.db.prepare(`SELECT d.doc,d.id,d.version,d.filename,d.title,${body} AS body,
      length(CAST(${body} AS BLOB)) AS bytes FROM documents d LEFT JOIN document_text t ON t.doc=d.doc
      WHERE ${visible} AND d.doc>? AND ${filter.sql} ORDER BY d.doc LIMIT ?`)
      .bind(after, ...filter.args, limit);
  }
  // This function owns the only page reference. It returns compact values, releasing D1's
  // body strings/results before the caller awaits its next read. One matcher spans all pages.
  const rows = (await statement.all<SearchRow & { candidates?: number }>()).results;
  const exhausted = sql && query.text ? rows.length > 0 && rows[0].candidates === rows.length && rows.length < limit : rows.length < limit;
  const result: SearchPage = { after, bytes: 0, hits: [], exhausted, stopped: rows.length === 0 };
  for (const row of rows) {
    if (!sql && query.text && clock.expired()) { result.stopped = true; result.exhausted = false; break; }
    const matchCount = sql || !query.text ? row.matchCount : matcher.match(row)?.matchCount;
    if (matchCount !== undefined && (matchCount > 0 || !query.text)) {
      result.hits.push({ id: row.id, version: row.version, matchCount });
    }
    result.after = row.doc;
    result.bytes += row.bytes;
  }
  return result;
}

function admitSnippets(request: LibrarySnippetsRequest): LibrarySnippetsRequest {
  if (!request || request.version !== 1 || !nonnegative(request.generation)
    || !Array.isArray(request.refs) || request.refs.length > LIMIT.snippetRefs) invalidRequest("Invalid snippet request.");
  const query = admitQuery(request.query);
  const seen = new Set<string>();
  const refs = request.refs.map((ref) => {
    if (!ref || typeof ref.id !== "string" || !/^[A-Za-z0-9]{8}$/.test(ref.id)
      || typeof ref.version !== "string" || !ref.version.length || ref.version.length > 128) invalidRequest("Invalid snippet reference.");
    const key = JSON.stringify([ref.id, ref.version]);
    if (seen.has(key)) invalidRequest("Duplicate snippet references are not allowed.");
    seen.add(key);
    return { id: ref.id, version: ref.version };
  });
  return { version: 1, generation: request.generation, query, refs };
}

async function snippetPage(deps: LibraryDependencies, query: SearchQuery, refs: SelectionRef[],
  matcher: CompiledSearchMatcher, clock: SliceClock) {
  const body = query.text ? "CASE WHEN d.state='indexed' AND d.coverage IN ('full','truncated') THEN coalesce(t.body,'') ELSE '' END" : "''";
  const rows = (await deps.db.prepare(`WITH requested(pos,id,version) AS (VALUES ${refs.map(() => "(?,?,?)").join(",")})
    SELECT r.pos,d.id,d.version,d.filename,d.title,${body} AS body FROM requested r
    JOIN documents d ON d.id=r.id AND d.version=r.version LEFT JOIN document_text t ON t.doc=d.doc
    WHERE ${visible} ORDER BY r.pos`)
    .bind(...refs.flatMap((ref, pos) => [pos, ref.id, ref.version])).all<SearchRow & { pos: number }>()).results;
  const byPosition = new Map(rows.map((row) => [row.pos, row]));
  const result = { processed: 0, bytes: 0, stopped: false, hits: [] as SearchHit[], unavailable: [] as SelectionRef[] };
  // Missing rows still consume their input position. Only an unprocessed suffix is remaining;
  // zero-match/empty/changed/deleted refs cannot be silently retried or classified twice.
  for (let pos = 0; pos < refs.length; pos++) {
    if (clock.expired()) { result.stopped = true; break; }
    const row = byPosition.get(pos);
    const match = row ? matcher.match(row) : null;
    if (row && match) result.hits.push({ id: row.id, version: row.version, ...match });
    else result.unavailable.push(refs[pos]);
    result.processed++;
    if (row) result.bytes += encoder.encode(row.body).length;
  }
  // Neither rows nor byPosition survives this return, before the next body statement.
  return result;
}
