import type { LibraryStatus } from "../library-contracts";
import { LIBRARY_LIMITS } from "../library-contracts";
import type { LibraryDependencies, MaintenanceLease } from "./contracts";
import { saveMaintenanceMeta } from "./maintenance-lease";

const PAUSED = "paused: index size budget";

/** Read actual D1 allocation before each one-body batch. The source planning estimate is
 * disclosed, not treated as an upper bound: compressed DOCX can expand far beyond its source.
 * A worst admitted body reserve protects small budgets before the 50-sample projection exists.
 */
export async function prepareMaintenanceStorage(deps: LibraryDependencies, lease: MaintenanceLease): Promise<boolean> {
  const result = await deps.db.prepare(`SELECT
    sum(CASE WHEN state = 'indexed' THEN 1 ELSE 0 END) AS indexed,
    sum(CASE WHEN state IN ('pending', 'failed') OR (state='indexed' AND extractor < ?) THEN 1 ELSE 0 END) AS remaining,
    sum(CASE WHEN state IN ('pending', 'failed') OR (state='indexed' AND extractor < ?) THEN min(size_bytes, 524288) ELSE 0 END) AS source
    FROM documents d WHERE state <> 'deleting' AND NOT EXISTS (SELECT 1 FROM deleted_ids t WHERE t.id=d.id)`)
    .bind(deps.config.extractorVersion, deps.config.extractorVersion)
    .all<{ indexed: number | null; remaining: number | null; source: number | null }>();
  const row = result.results[0];
  const bytes = result.meta.size_after;
  const budgetBytes = deps.config.sizeBudgetBytes;
  const indexed = row.indexed ?? 0;
  const remaining = row.remaining ?? 0;
  // Allocation per indexed sample includes metadata/FTS overhead, deliberately conservative.
  // This also works when page allocation reports zero growth for several individual documents.
  const projectedBytes = indexed >= 50 ? Math.ceil(bytes + remaining * (bytes / indexed)) : null;
  const planningBytes = Math.ceil(bytes + 3.2 * (row.source ?? 0));
  const reserve = Math.ceil(3.2 * LIBRARY_LIMITS.bodyBytes) + 16_384;
  const paused = remaining > 0 && (bytes + reserve > budgetBytes || (projectedBytes !== null && projectedBytes > budgetBytes));
  const storage: LibraryStatus["storage"] = { bytes, budgetBytes, planningBytes, projectedBytes,
    paused, reason: paused ? PAUSED : null };
  await saveMaintenanceMeta(deps, lease, [["storage", JSON.stringify(storage)]]);
  return !paused;
}
