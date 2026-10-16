import type { DocumentSummary, SelectionRef, TextRecord } from "../contracts";
import type { Documents, ResolvedDocument } from "../documents";
import type { IndexState, LibraryPage, LibrarySearchRequest, LibrarySearchResponse,
  LibrarySnippetsRequest, LibrarySnippetsResponse, MaintainOptions, MaintenanceReport } from "../library-contracts";
import type { LibraryErrorCode } from "../library-contracts";

/** Server-only composition details. No caller outside LibraryIndex needs DB layout, lifecycle
 * claims or lease tokens; query/records/maintenance share the same injected clock and config.
 */
export interface LibraryConfig {
  extractorVersion: TextRecord["extractorVersion"];
  sizeBudgetBytes: number;
  drainDocuments: number; // 12 conservative Free default; 100 maximum for an admitted Paid run.
  drainTextBytes: number;
  maintenanceMs: number;
  reconcilePages: number;
  maxAttempts: number;
  deletionRepairMs: number;
}
export interface LibraryDependencies {
  db: D1Database;
  documents: Documents; // Undecorated authoritative R2 module; prevents recursive maintenance.
  extract(doc: ResolvedDocument): Promise<TextRecord>;
  defer(work: Promise<unknown>): void;
  now(): number; // Epoch milliseconds; elapsed budgets also stop if this clock advances.
  nonce(): string; // Unique operation identity, independent of wall-clock time.
  publicOrigin: string;
  config: Readonly<LibraryConfig>;
}
export interface LibraryQueries {
  page(cursor?: string): Promise<LibraryPage>;
  search(request: LibrarySearchRequest): Promise<LibrarySearchResponse>;
  snippets(request: LibrarySnippetsRequest): Promise<LibrarySnippetsResponse>;
}

/** Token is acquired by a conditional write checked with meta.changes === 1. Renewal, release,
 * cursor saves and claim acquisition compare token AND unexpired lease inside their SQL batch.
 * Timestamps determine eligibility only; they never authorize another operation's cleanup.
 */
export interface MaintenanceLease { token: string; expiresAt: number }
export interface RecordClaim {
  ref: SelectionRef;
  token: string;
  expiresAt: number;
  lease: MaintenanceLease | null; // null is an upload's independently token-owned deferred claim.
}
export interface DeletionClaim {
  id: string;
  token: string;
  at: number;
  restoreState: Exclude<IndexState, "deleting"> | null;
  restoreVersion: string | null;
}
export type RecordWrite = "written" | "unchanged" | "tombstoned" | "stale";
export interface IndexRecordResult { outcome: "indexed" | "failed" | "stale"; textBytes: number }

/** records.ts owns every guarded metadata/text/FTS/tombstone/generation mutation, extraction
 * claim finalization and the Documents decorator. Maintenance selects work itself using db,
 * but must cross these narrow operations to mutate document state. No generic repository.
 */
export interface LibraryRecords {
  readonly documents: Documents;
  ingest(summary: DocumentSummary, observedAt: number, lease?: MaintenanceLease): Promise<RecordWrite>;
  claim(ref: SelectionRef, lease?: MaintenanceLease): Promise<RecordClaim | null>;
  index(claim: RecordClaim): Promise<IndexRecordResult>;
  repairDeletion(claim: DeletionClaim, lease: MaintenanceLease): Promise<"restored" | "deleted" | "stale">;
  confirmMissing(ref: SelectionRef, observedAt: number, lease: MaintenanceLease): Promise<RecordWrite>;
  retry(refs: SelectionRef[], lease: MaintenanceLease): Promise<number>;
}
export interface LibraryMaintenance { maintain(options: MaintainOptions): Promise<MaintenanceReport> }

/** Safe HTTP-mappable failure. Stub modules fail closed rather than advertising empty success;
 * later owners retain the typed failure seam while replacing their implementation.
 */
export class LibraryIndexError extends Error {
  constructor(readonly code: LibraryErrorCode, message: string, readonly retryable: boolean) {
    super(message);
    this.name = "LibraryIndexError";
  }
}
export function unavailable(piece: string): never {
  throw new LibraryIndexError("library_unavailable", `Library ${piece} is not implemented.`, true);
}
