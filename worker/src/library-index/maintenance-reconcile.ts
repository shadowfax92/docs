import type { DocumentSummary } from "../contracts";
import type { LibraryDependencies, LibraryRecords, MaintenanceLease } from "./contracts";
import { LibraryIndexError } from "./contracts";
import { renewMaintenanceLease } from "./maintenance-lease";
import { InvocationBudgetExceeded } from "../invocation-budget";

/** Only page/merge progress is durable, never a per-document seen mark. afterId lets a
 * tight invocation finish an R2 page across runs without replaying successful ingests.
 * The R2 continuation advances only after every D1/R2 difference in that range is handled.
 */
interface ReconcileCursor {
  cursor: string | null;
  lastId: string | null;
  startedAt: number;
  day: string;
  afterId?: string | null;
  anomalies?: number;
  listingRetry?: boolean;
  listingBlocked?: boolean;
}
interface ReconcileRow {
  id: string;
  version: string | null;
  state: string | null;
  changed_at: number | null;
  title: string | null;
  filename: string | null;
  kind: string | null;
  mime: string | null;
  size_bytes: number | null;
  uploaded_at_iso: string | null;
  created_at: string | null;
  object_count: number | null;
  warnings_json: string | null;
  deleted_state: string | null;
}

export interface ReconcileRun {
  deps: LibraryDependencies;
  records: LibraryRecords;
  lease: MaintenanceLease;
  deadlineMs: number;
  pages: number;
  explicit: boolean;
  meta: Map<string, string>;
  canContinue(): boolean;
  onPage?(): void;
}

function parseCursor(value: string | undefined): ReconcileCursor | null {
  if (!value || value === "null") return null;
  const parsed = JSON.parse(value) as ReconcileCursor;
  const id = (value: unknown) => value === null || (typeof value === "string" && /^[A-Za-z0-9]{8}$/.test(value));
  if (!parsed || (parsed.cursor !== null && typeof parsed.cursor !== "string")
    || !id(parsed.lastId) || !Number.isSafeInteger(parsed.startedAt) || !/^\d{4}-\d{2}-\d{2}$/.test(parsed.day)
    || (parsed.afterId !== undefined && !id(parsed.afterId))
    || (parsed.anomalies !== undefined && (!Number.isSafeInteger(parsed.anomalies) || parsed.anomalies < 0))) {
    throw new LibraryIndexError("library_unavailable", "Invalid persisted reconcile checkpoint.", true);
  }
  return parsed;
}

function differs(row: ReconcileRow, summary: DocumentSummary): boolean {
  return row.version !== summary.version || row.title !== summary.title || row.filename !== summary.filename
    || row.kind !== summary.kind || row.mime !== summary.mime || row.size_bytes !== summary.sizeBytes
    || row.uploaded_at_iso !== summary.uploadedAt || row.created_at !== summary.createdAt
    || row.object_count !== summary.objectCount || row.warnings_json !== JSON.stringify(summary.warnings);
}

export async function reconcileLibrary(run: ReconcileRun): Promise<{ pages: number; complete: boolean }> {
  const { deps, records, lease, meta } = run;
  const today = new Date(deps.now()).toISOString().slice(0, 10);
  let state = parseCursor(meta.get("reconcile"));
  const completedAt: string | null = JSON.parse(meta.get("last-reconciled-at") ?? "null");
  if (!state && !run.explicit && completedAt?.slice(0, 10) === today) return { pages: 0, complete: true };
  state ??= { cursor: null, lastId: null, afterId: null, startedAt: deps.now(), day: today, anomalies: 0 };
  const checkpoint = () => meta.set("reconcile", JSON.stringify(state));
  checkpoint();
  // A prefix too expensive even on an otherwise empty invocation cannot be paged through
  // this opaque Documents seam. Preserve its cursor, stop automatic replay, and let an
  // explicit operator request retry after the underlying listing constraint is addressed.
  if (state.listingBlocked && !run.explicit) return { pages: 0, complete: false };
  let pages = 0;
  while (pages < run.pages && run.canContinue()) {
    if (!await renewMaintenanceLease(deps, lease, run.deadlineMs) || !run.canContinue()) return { pages, complete: false };
    const startedUsed = deps.budget?.used ?? 0;
    let page;
    try { page = await deps.documents.page(state.cursor ?? undefined); }
    catch (error) {
      if (error instanceof InvocationBudgetExceeded) {
        // lease + meta read + renewal cost three on a listing-only retry. No guessed
        // prefix cost: only an actually exhausted fresh allowance trips this stop.
        state.listingBlocked = state.listingRetry === true && startedUsed <= 3;
        state.listingRetry = true;
        checkpoint();
      }
      throw error;
    }
    delete state.listingRetry;
    delete state.listingBlocked;
    checkpoint();
    const observedAt = Date.parse(page.observedAt);
    if (!Number.isFinite(observedAt) || page.items.length > 200 || page.scanComplete !== (page.nextCursor === null)
      || page.items.some((item, index) => !/^[A-Za-z0-9]{8}$/.test(item.id)
        || (index > 0 && page.items[index - 1].id >= item.id)
        || (state!.lastId !== null && item.id <= state!.lastId))) {
      throw new LibraryIndexError("library_unavailable", "Document listing violated reconcile ordering.", true);
    }
    // ASCII upload IDs have the same order in R2 byte listings, JS comparisons and SQLite
    // COLLATE BINARY. No localeCompare/NOCASE: either would misjoin uppercase/lowercase IDs.
    const upper: string | null = page.nextCursor === null ? null : page.items.at(-1)?.id ?? state.lastId;
    if (page.items.length || page.scanComplete) {
      let after = state.afterId ?? state.lastId;
      while (run.canContinue()) {
        const rows = (await deps.db.prepare(`WITH ids AS (
          SELECT id FROM documents WHERE (? IS NULL OR id > ? COLLATE BINARY) AND (? IS NULL OR id <= ? COLLATE BINARY)
          UNION SELECT id FROM deleted_ids WHERE (? IS NULL OR id > ? COLLATE BINARY) AND (? IS NULL OR id <= ? COLLATE BINARY)
        ) SELECT ids.id, d.version, d.state, d.changed_at, d.title, d.filename, d.kind, d.mime,
          d.size_bytes, d.uploaded_at_iso, d.created_at, d.object_count, d.warnings_json, t.state AS deleted_state
          FROM ids LEFT JOIN documents d ON d.id = ids.id LEFT JOIN deleted_ids t ON t.id = ids.id
          ORDER BY ids.id COLLATE BINARY LIMIT 200`)
          .bind(after, after, upper, upper, after, after, upper, upper).all<ReconcileRow>()).results;
        const summaries = page.items.filter((item) => after === null || item.id > after);
        // A dense D1-only gap can exceed 200 rows. Stop this merge at the D1 range's last
        // returned ID, then fetch another bounded range instead of buffering the gap.
        const limitId = rows.length === 200 ? rows.at(-1)!.id : null;
        const ids = [...new Set([...rows.map((row) => row.id), ...summaries.map((item) => item.id)])]
          .filter((id) => limitId === null || id <= limitId).sort();
        const byId = new Map(rows.map((row) => [row.id, row]));
        const bySummary = new Map(summaries.map((item) => [item.id, item]));
        for (const id of ids) {
          if (!run.canContinue()) return { pages, complete: false };
          const row = byId.get(id);
          const summary = bySummary.get(id);
          if (summary) {
            if (row?.deleted_state === "deleted") state.anomalies = (state.anomalies ?? 0) + 1;
            else if (!row?.deleted_state && (!row || differs(row, summary))) {
              await records.ingest(summary, observedAt, lease);
            }
          } else if (row?.version && row.state !== "deleting" && !row.deleted_state
            && row.changed_at !== null && row.changed_at < observedAt) {
            // Records re-resolves R2 and guards the captured ref/change time. A listing gap
            // or a concurrent upload alone never authorizes a tombstone.
            await records.confirmMissing({ id, version: row.version }, observedAt, lease);
          }
          state.afterId = after = id;
          checkpoint();
        }
        if (rows.length < 200) break;
      }
      if (!run.canContinue()) return { pages, complete: false };
    }
    pages++;
    run.onPage?.();
    if (page.scanComplete) {
      meta.set("last-reconciled-at", JSON.stringify(new Date(deps.now()).toISOString()));
      meta.set("anomalies", String(state.anomalies ?? 0));
      meta.set("reconcile", "null");
      return { pages, complete: true };
    }
    if (page.nextCursor === state.cursor) throw new LibraryIndexError("library_unavailable", "Reconcile cursor did not advance.", true);
    state = { ...state, cursor: page.nextCursor, lastId: upper, afterId: null };
    checkpoint();
  }
  return { pages, complete: false };
}

/** Retry a budget-interrupted opaque listing before drain/repair spend this invocation.
 * A successful page clears this flag; a genuinely oversized prefix is then parked explicitly.
 */
export function prioritizeReconcile(meta: Map<string, string>, explicit: boolean): boolean {
  const state = parseCursor(meta.get("reconcile"));
  return state?.listingRetry === true && (explicit || state.listingBlocked !== true);
}
