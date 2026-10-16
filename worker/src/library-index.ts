import type { Documents } from "./documents";
import type { LibraryPage, LibrarySearchRequest, LibrarySearchResponse, LibrarySnippetsRequest,
  LibrarySnippetsResponse, MaintainOptions, MaintenanceReport } from "./library-contracts";
import { LIBRARY_LIMITS } from "./library-contracts";
import type { LibraryConfig, LibraryDependencies } from "./library-index/contracts";
import { createLibraryQueries } from "./library-index/query";
import { createLibraryRecords } from "./library-index/records";
import { createLibraryMaintenance } from "./library-index/maintenance";

export { LibraryIndexError } from "./library-index/contracts";
export type { LibraryConfig, LibraryDependencies } from "./library-index/contracts";

/** Deep server-only module over a rebuildable D1 index of authoritative R2 Documents.
 * Owns version/tombstone guards, deferred extraction, generation and bounded query/repair policy.
 * HTTP supplies per-invocation resources; both roles share this index while only catalog reads it.
 */
export interface LibraryIndex {
  readonly documents: Documents;
  page(cursor?: string): Promise<LibraryPage>;
  search(request: LibrarySearchRequest): Promise<LibrarySearchResponse>;
  snippets(request: LibrarySnippetsRequest): Promise<LibrarySnippetsResponse>;
  maintain(options: MaintainOptions): Promise<MaintenanceReport>;
}

export const DEFAULT_LIBRARY_CONFIG: Readonly<LibraryConfig> = Object.freeze({
  extractorVersion: 1,
  sizeBudgetBytes: LIBRARY_LIMITS.sizeBudgetBytes,
  drainDocuments: 12,
  drainTextBytes: LIBRARY_LIMITS.drainBytes,
  maintenanceMs: LIBRARY_LIMITS.maintenanceMs,
  reconcilePages: 1,
  maxAttempts: 5,
  deletionRepairMs: 10 * 60 * 1000,
});

/** Composition has no I/O or hidden environment globals. HTTP owns role/auth and defer owns
 * waitUntil lifetime; private implementations own SQL, operation tokens and cursor contents.
 */
export function createLibraryIndex(deps: LibraryDependencies): LibraryIndex {
  const records = createLibraryRecords(deps);
  const queries = createLibraryQueries(deps);
  const maintenance = createLibraryMaintenance(deps, records);
  return {
    documents: records.documents,
    page: (cursor) => queries.page(cursor),
    search: (request) => queries.search(request),
    snippets: (request) => queries.snippets(request),
    maintain: (options) => maintenance.maintain(options),
  };
}
