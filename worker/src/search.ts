import type { DocumentFilter, DocumentSummary, TextRecord, UploadId } from "./contracts";
import { RE2JS } from "re2js";

export interface SearchQuery { text: string; mode: "literal" | "regex"; ignoreCase: boolean }
export interface SearchHit {
  id: UploadId;
  version: string;
  matchCount: number;
  snippet: string;
  ranges: [number, number][]; // UTF-16 snippet offsets; render with text nodes, never HTML.
}

/** Private, in-process browser index: no storage, credentials or persistence. Retention is bounded
 * to 32 MiB estimated UTF-16 strings/record overhead and 10,000 documents; failed budget admission
 * invalidates queries until clear. Matching filters first, then ranks exact counts/date/ID.
 * Patterns, compiled programs and aggregate matching work have separate explicit error budgets.
 */
export interface SearchIndex {
  add(summary: DocumentSummary, text: TextRecord): void;
  query(query: SearchQuery, filter: DocumentFilter): SearchHit[];
  clear(): void;
}

/** Generation correlates async replies; UI ignores obsolete replies and terminates work on logout. */
export type SearchWorkerRequest = { version: 1; generation: number } & (
  | { operation: "add"; summary: DocumentSummary; text: TextRecord }
  | { operation: "query"; query: SearchQuery; filter: DocumentFilter }
  | { operation: "clear" }
);
export type SearchWorkerResponse = { version: 1; generation: number } & (
  | { status: "ready" }
  | { status: "results"; hits: SearchHit[] }
  | { status: "error"; code: string; message: string }
);

/** Safe, caller-visible failures. No partial corpus/ranking is returned after a budget failure. */
export class SearchError extends Error {
  constructor(readonly code: "invalid_search_request" | "invalid_pattern" | "search_budget_exceeded", message: string) {
    super(message);
    this.name = "SearchError";
  }
}

const INDEX_BYTES = 32 * 1024 * 1024;
const MAX_RECORDS = 10000;
const MAX_TEXT_BYTES = 512 * 1024;
const MAX_PATTERN_BYTES = 256;
const MAX_PROGRAM = 4096;
const MAX_QUERY_WORK = 128 * 1024 * 1024;
const MAX_FINDS = 1000000;
const SNIPPET_LENGTH = 240;
const MAX_RANGES = 20;
const kinds = new Set(["html", "markdown", "text", "data", "pdf", "image", "audio", "video", "archive", "office", "binary"]);
const encoder = new TextEncoder();

/** Only immutable search fields are retained; callers may mutate/discard their wire records. */
interface IndexedDocument {
  id: UploadId;
  version: string;
  title: string;
  filename: string;
  body: string;
  kind: string;
  uploadedAt: number;
  bytes: number;
}

export function createSearchIndex(): SearchIndex {
  const records = new Map<UploadId, IndexedDocument>();
  let bytes = 0;
  let incomplete = false;
  return {
    add(summary, text) {
      if (!summary || !text || typeof summary.id !== "string" || !/^[A-Za-z0-9]{8}$/.test(summary.id)
        || typeof summary.version !== "string" || !summary.version.length || summary.version.length > 128
        || summary.id !== text.id || summary.version !== text.documentVersion
        || text.version !== 1 || text.extractorVersion !== 1
        || typeof summary.title !== "string" || typeof summary.filename !== "string"
        || typeof text.text !== "string" || !kinds.has(summary.kind)
        || !["full", "truncated", "metadata-only", "error"].includes(text.coverage)
        || typeof summary.uploadedAt !== "string" || !Number.isFinite(Date.parse(summary.uploadedAt))) {
        throw new SearchError("invalid_search_request", "Search records must have matching document IDs/versions and valid metadata.");
      }
      const body = text.coverage === "full" || text.coverage === "truncated" ? text.text : "";
      if (summary.title.length > 16384 || summary.filename.length > 4096 || body.length > MAX_TEXT_BYTES
        || encoder.encode(body).length > MAX_TEXT_BYTES) {
        incomplete = true;
        throw new SearchError("search_budget_exceeded", "A document exceeds the text/metadata search budget. Clear and reload the index.");
      }
      const retained = 512 + 2 * (summary.id.length + summary.version.length + summary.title.length + summary.filename.length + body.length);
      const previous = records.get(summary.id);
      const nextBytes = bytes - (previous?.bytes ?? 0) + retained;
      if (nextBytes > INDEX_BYTES || (!previous && records.size === MAX_RECORDS)) {
        incomplete = true;
        throw new SearchError("search_budget_exceeded", "The library exceeds the 32 MiB / 10,000 document search budget. Clear and reload a smaller corpus.");
      }
      records.set(summary.id, {
        id: summary.id, version: summary.version, title: summary.title, filename: summary.filename,
        body, kind: summary.kind, uploadedAt: Date.parse(summary.uploadedAt), bytes: retained,
      });
      bytes = nextBytes;
    },
    query(query, filter) {
      if (incomplete) throw new SearchError("search_budget_exceeded", "Search is incomplete after an index budget failure. Clear and reload the index.");
      if (!query || typeof query.text !== "string" || !["literal", "regex"].includes(query.mode ?? "literal")
        || typeof query.ignoreCase !== "boolean" || !filter || !Array.isArray(filter.kinds)
        || filter.kinds.length > kinds.size || filter.kinds.some((kind) => !kinds.has(kind))) {
        throw new SearchError("invalid_search_request", "Search requires literal/regex mode, an explicit case flag and valid filters.");
      }
      const before = cutoff(filter.uploadedBefore);
      const after = cutoff(filter.uploadedAfter);
      const pattern = compile(query);
      const regex = query.mode === "regex";
      const instructions = pattern?.programSize() ?? 0;
      const hits: SearchHit[] = [];
      let work = 0;
      let finds = 0;
      const deadline = performance.now() + 1500;
      try {
        for (const record of records.values()) {
          // Cutoffs refer to the authoritative uploaded timestamp. Upper is strict (<), lower is
          // inclusive (>=), allowing a whole calendar day to be expressed without millisecond gaps.
          if ((filter.kinds.length && !filter.kinds.includes(record.kind as DocumentSummary["kind"]))
            || (before !== null && record.uploadedAt >= before) || (after !== null && record.uploadedAt < after)) continue;
          let matchCount = 0;
          let snippet: Pick<SearchHit, "snippet" | "ranges"> = { snippet: record.title.slice(0, SNIPPET_LENGTH), ranges: [] };
          for (const field of [record.filename, record.title, record.body]) {
            // A quoted literal's nonoverlapping finds consume one field, rather than restarting
            // a regex search over each remaining suffix. Charge that text once, independent of
            // literal length; multiplying by program size rejected ordinary terms on admitted
            // libraries. RE2 still owns Unicode simple folding and UTF-16 offsets. Its constant
            // costs (including shared literal prefixes) remain bounded by the pattern-size,
            // find-count and wall-clock guards; this is a scan budget, not an instruction count.
            if (!regex) work += field.length;
            if (work > MAX_QUERY_WORK || performance.now() > deadline) queryBudget();
            if (!pattern) continue; // Empty query lists every filtered document, with zero matches.
            const matcher = pattern.matcher(field);
            let window: SnippetWindow | undefined;
            let searchedThrough = 0;
            while (true) {
              // Each regex find can rescan the entire remaining suffix (a.*b|a). Charge that
              // conservative upper bound before entering RE2, including the final failing find.
              // Quoted literal finds only advance, so their aggregate field scan is charged once.
              if (regex) work += (field.length - searchedThrough + 1) * instructions;
              if (work > MAX_QUERY_WORK || ++finds > MAX_FINDS || performance.now() > deadline) queryBudget();
              const found = matcher.find();
              if (performance.now() > deadline) queryBudget();
              if (!found) break;
              const start = matcher.start();
              const end = matcher.end();
              // RE2JS advances zero-width finds by a code point; do not add phantom counts/ranges.
              searchedThrough = end;
              if (start === end) {
                if (end < field.length) searchedThrough += field.codePointAt(end)! > 0xffff ? 2 : 1;
                continue;
              }
              matchCount++;
              if (!window) window = snippetWindow(field, start);
              if (window.ranges.length < MAX_RANGES && start < window.end) {
                window.ranges.push([start - window.start + window.prefix, Math.min(end, window.end) - window.start + window.prefix]);
              }
            }
            // Prefer a body match; otherwise retain the last matching title/filename window.
            if (window) snippet = { snippet: window.snippet, ranges: window.ranges };
          }
          if (!pattern || matchCount) hits.push({ id: record.id, version: record.version, matchCount, ...snippet });
        }
        hits.sort((a, b) => b.matchCount - a.matchCount
          || records.get(b.id)!.uploadedAt - records.get(a.id)!.uploadedAt
          || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
        if (performance.now() > deadline) queryBudget();
        return hits;
      } finally {
        // RE2's per-pattern automata/cache have no purpose after this synchronous query finishes.
        pattern?.reset();
      }
    },
    clear() { records.clear(); bytes = 0; incomplete = false; },
  };
}

function cutoff(value: string | null): number | null {
  if (value === null) return null;
  const parsed = typeof value === "string" ? Date.parse(value) : NaN;
  if (!Number.isFinite(parsed)) throw new SearchError("invalid_search_request", "Upload date filters must be valid timestamps or null.");
  return parsed;
}

function queryBudget(): never {
  throw new SearchError("search_budget_exceeded", "The query exceeds its matching work/time budget. Narrow the filters or simplify the pattern.");
}

function compile(query: SearchQuery): RE2JS | null {
  if (query.text.length > MAX_PATTERN_BYTES || encoder.encode(query.text).length > MAX_PATTERN_BYTES) {
    throw new SearchError("search_budget_exceeded", "Search patterns are limited to 256 UTF-8 bytes.");
  }
  if (!query.text) return null;
  if (query.mode === "regex") checkExpansion(query.text);
  let pattern: RE2JS;
  try {
    // All untrusted patterns, including literal case folding, use RE2JS. Never native backtracking.
    pattern = RE2JS.compile(query.mode === "regex" ? query.text : RE2JS.quote(query.text), query.ignoreCase ? RE2JS.CASE_INSENSITIVE : 0);
  } catch (error) {
    throw new SearchError("invalid_pattern", `Invalid or unsupported RE2 pattern: ${error instanceof Error ? error.message.slice(0, 256) : "compilation failed"}`);
  }
  if (pattern.programSize() > MAX_PROGRAM) {
    pattern.reset();
    throw new SearchError("search_budget_exceeded", "The compiled search pattern exceeds 4,096 instructions.");
  }
  return pattern;
}

/** A conservative preflight bounds counted expansion before RE2 allocates its compiled program.
 * Escapes, quoted literals and character classes are skipped. Independent repetition counts also
 * multiply, deliberately rejecting some valid expensive patterns rather than risking huge compile.
 */
function checkExpansion(source: string): void {
  let expansion = 1;
  let quoted = false;
  for (let index = 0; index < source.length; index++) {
    if (source[index] === "\\") {
      const next = source[++index];
      if (next === "Q") quoted = true;
      if (next === "E") quoted = false;
      continue;
    }
    if (quoted) continue;
    if (source[index] === "[") {
      index++;
      if (source[index] === "^") index++;
      if (source[index] === "]") index++;
      for (; index < source.length && source[index] !== "]"; index++) if (source[index] === "\\") index++;
      continue;
    }
    if (source[index] !== "{") continue;
    const repetition = /^\{([0-9]+)(?:,([0-9]*))?\}/.exec(source.slice(index));
    if (!repetition) continue;
    const count = Math.max(Number(repetition[1]), Number(repetition[2] || 0));
    if (count > 1000) throw new SearchError("invalid_pattern", "RE2 counted repetitions must not exceed 1,000.");
    expansion *= Math.max(1, count);
    if (expansion > MAX_PROGRAM) throw new SearchError("search_budget_exceeded", "Counted repetition expansion exceeds the pattern compilation budget.");
    index += repetition[0].length - 1;
  }
}

interface SnippetWindow {
  start: number;
  end: number;
  prefix: number;
  snippet: string;
  ranges: [number, number][];
}
function snippetWindow(text: string, firstMatch: number): SnippetWindow {
  let start = Math.max(0, firstMatch - 64);
  let end = Math.min(text.length, start + SNIPPET_LENGTH);
  // JS/DOM ranges are UTF-16; crop only between complete scalar values, including astral matches.
  if (start > 0 && /[\uDC00-\uDFFF]/u.test(text[start])) start--;
  if (end < text.length && /[\uDC00-\uDFFF]/u.test(text[end])) end++;
  const prefix = start ? 1 : 0;
  return { start, end, prefix, snippet: `${start ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`, ranges: [] };
}
