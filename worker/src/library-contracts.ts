import type { Coverage, DocumentFilter, DocumentSummary, SelectionRef, TextRecord } from "./contracts";
import type { SearchHit, SearchQuery } from "./search";

/** Browser-safe catalog protocol. No D1 bindings, storage keys, server imports or body corpus.
 * Refs and deletion retain the existing frozen ID/version wire shape. Cursors are opaque;
 * callers preserve them verbatim and discard accumulated slices on generation changes.
 */
export type { DocumentFilter, DocumentSummary, SelectionRef, TextRecord, SearchHit, SearchQuery };
export type { DeleteBatchRequest, DeleteProgress, CatalogError } from "./contracts";

export const LIBRARY_LIMITS = {
  metadataRows: 500, hits: 10_000, queryBytes: 256, snippetRefs: 48,
  bodyRows: 8, bodyBytes: 512 * 1024, sliceBytes: 16 * 1024 * 1024,
  sliceMs: 1000, drainBytes: 32 * 1024 * 1024, maintenanceMs: 20_000,
  sizeBudgetBytes: 400_000_000,
} as const;
export const LIBRARY_ENDPOINTS = {
  documents: "/all-docs/api/documents", search: "/all-docs/api/search",
  snippets: "/all-docs/api/snippets", maintain: "/all-docs/api/index/maintain",
  retry: "/all-docs/api/index/retry", delete: "/all-docs/api/delete",
} as const;

export type IndexState = "pending" | "indexed" | "failed" | "deleting";
export interface LibraryMetadata {
  state: Exclude<IndexState, "deleting">;
  coverage: Coverage | null;
  reason: TextRecord["reason"];
  indexedBytes: TextRecord["indexedBytes"];
  extractorVersion: number;
}
export type LibraryDocument = DocumentSummary & { index: LibraryMetadata };
export interface LibraryCounts {
  documents: number;
  pending: number;
  indexed: number;
  failed: number;
  metadataOnly: number;
  truncated: number;
}
export interface LibraryStatus {
  counts: LibraryCounts; // Visible rows only; tombstones/deleting rows never count.
  lastReconciledAt: string | null; // Last completed pass, not the latest page/tick.
  anomalies: number; // Out-of-band R2 objects with permanent deleted-ID markers.
  storage: {
    bytes: number;
    budgetBytes: number;
    planningBytes: number | null;
    projectedBytes: number | null;
    paused: boolean;
    reason: string | null;
  };
}

/** A generation is a nonnegative safe integer, bumped only for visible row/version/metadata/
 * state/coverage/text changes. Lease, claim, retry, reconcile and storage bookkeeping do not bump it.
 * Each continuation is bound to its initial generation; stale continuations fail explicitly.
 */
export interface LibraryPage {
  version: 1;
  generation: number;
  items: LibraryDocument[];
  nextCursor: string | null;
  scanComplete: boolean;
  observedAt: string;
  status: LibraryStatus;
}
export interface LibraryPageRequest { cursor?: string }
export type LibraryHit = Pick<SearchHit, "id" | "version" | "matchCount">;
export interface LibrarySearchRequest {
  version: 1;
  query: SearchQuery;
  filter: DocumentFilter;
  cursor?: string;
}
export interface LibrarySearchResponse {
  version: 1;
  generation: number;
  hits: LibraryHit[]; // This slice only; accumulate by frozen ID/version until complete.
  complete: boolean;
  nextCursor: string | null;
  scope: Pick<LibraryCounts, "documents" | "pending" | "failed">;
  status: LibraryStatus;
}
export interface LibrarySnippetsRequest {
  version: 1;
  generation: number;
  query: SearchQuery;
  refs: SelectionRef[];
}
export interface LibrarySnippetsResponse {
  version: 1;
  generation: number;
  hits: SearchHit[];
  remaining: SelectionRef[]; // Only refs unprocessed at the byte/time boundary; same order as input.
  unavailable: SelectionRef[]; // Processed refs absent, version-changed, hidden or no longer matching.
}

/** All maintenance entry points share one token-owned lease. Limits are clamped to config;
 * manual retries target exact versions and never reset every failed row on a cron tick.
 */
export interface MaintainOptions {
  documents: number;
  textBytes: number;
  listPages: number;
  deadlineMs: number;
  reconcile?: boolean; // true requests a pass now; otherwise resume/run only when daily-due.
  retry?: SelectionRef[]; // At most 48 exact refs; empty/absent leaves retry policy unchanged.
}
export interface MaintenanceReport {
  version: 1;
  outcome: "complete" | "partial" | "busy" | "paused";
  generation: number;
  processed: number;
  indexed: number;
  failed: number;
  repaired: number;
  reconciledPages: number;
  textBytes: number;
  status: LibraryStatus;
}
export interface LibraryMaintainRequest { version: 1; options: MaintainOptions }
export interface LibraryRetryRequest { version: 1; refs: SelectionRef[] }
export type LibraryRetryResponse = MaintenanceReport;

export type LibraryErrorCode = "library_unavailable" | "invalid_library_request" | "invalid_cursor"
  | "stale_generation" | "invalid_search_request" | "invalid_pattern" | "search_budget_exceeded";
export interface LibraryErrorResponse {
  version: 1;
  error: { code: LibraryErrorCode; message: string; retryable: boolean };
}
