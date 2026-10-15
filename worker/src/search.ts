import type { DocumentFilter, DocumentSummary, TextRecord, UploadId } from "./contracts";

export interface SearchQuery { text: string; mode: "literal" | "regex"; ignoreCase: boolean }
export interface SearchHit {
  id: UploadId;
  version: string;
  matchCount: number;
  snippet: string;
  ranges: [number, number][]; // UTF-16 snippet offsets; render with text nodes, never HTML.
}

/** In-process browser-worker index, without R2 or session access. Later implementation bounds memory
 * and pattern cost, filters before matching, ranks count/date/ID, and clears all private text on logout.
 * Unimplemented queries throw rather than reporting a successful empty corpus.
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

export function createSearchIndex(): SearchIndex {
  const unavailable = (): never => { throw new Error("Content search is unavailable in this skeleton"); };
  return { add: unavailable, query: unavailable, clear() {} };
}
