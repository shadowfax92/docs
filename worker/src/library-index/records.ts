import type { LibraryDependencies, LibraryRecords } from "./contracts";
import { unavailable } from "./contracts";

/** Lifecycle owner supplies tombstone-before-R2 removal and guarded, per-version indexing.
 * Until implemented, writes fail before touching R2; read-only resolution remains authoritative.
 */
export function createLibraryRecords(deps: LibraryDependencies): LibraryRecords {
  return {
    documents: {
      async create() { return unavailable("document creation"); },
      page: (cursor) => deps.documents.page(cursor),
      resolve: (id) => deps.documents.resolve(id),
      async remove() { return unavailable("document removal"); },
    },
    async ingest() { return unavailable("metadata ingestion"); },
    async claim() { return unavailable("record claims"); },
    async index() { return unavailable("record indexing"); },
    async repairDeletion() { return unavailable("deletion repair"); },
    async confirmMissing() { return unavailable("missing record confirmation"); },
    async retry() { return unavailable("manual retry"); },
  };
}
