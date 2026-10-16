import type { LibraryDependencies, LibraryMaintenance, LibraryRecords } from "./contracts";
import { unavailable } from "./contracts";

/** Maintenance owner supplies lease acquisition, bounded drain/reconcile and storage pause.
 * Records owns lifecycle writes; maintenance owns lease/cursor/size bookkeeping without generation bumps.
 */
export function createLibraryMaintenance(_deps: LibraryDependencies, _records: LibraryRecords): LibraryMaintenance {
  return { async maintain() { return unavailable("maintenance"); } };
}
