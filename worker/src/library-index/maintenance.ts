import type { LibraryDependencies, LibraryMaintenance, LibraryRecords, DeletionClaim, MaintenanceLease } from "./contracts";
import { LibraryIndexError } from "./contracts";
import type { MaintainOptions, MaintenanceReport } from "../library-contracts";
import { LIBRARY_LIMITS } from "../library-contracts";
import { isUploadId } from "../documents";
import { InvocationBudgetExceeded } from "../invocation-budget";
import { readLibraryState } from "./query";
import { acquireMaintenanceLease, releaseMaintenanceLease, saveMaintenanceMeta } from "./maintenance-lease";
import { prioritizeReconcile, reconcileLibrary } from "./maintenance-reconcile";
import { prepareMaintenanceStorage } from "./maintenance-storage";

/** Shared cron/operator orchestration over the LibraryRecords seam. This module owns
 * bounded selection and housekeeping; records alone owns visible state and generation.
 * Work is awaited sequentially, so budget finalization never overlaps a body or SQL write.
 */
export function createLibraryMaintenance(deps: LibraryDependencies, records: LibraryRecords): LibraryMaintenance {
  return { async maintain(request) {
    validateOptions(request);
    const options = admitOptions(deps, request);
    const started = deps.now();
    const elapsedStart = performance.now();
    const canContinue = () => deps.now() - started < options.deadlineMs
      && performance.now() - elapsedStart < options.deadlineMs && (deps.budget?.remaining ?? Infinity) > 0;
    const counts = { processed: 0, indexed: 0, failed: 0, repaired: 0, reconciledPages: 0, textBytes: 0 };
    let outcome: MaintenanceReport["outcome"] = "complete";
    let lease: MaintenanceLease | null = null;
    const meta = new Map<string, string>();
    const originalMeta = new Map<string, string>();
    const finalize = async (): Promise<MaintenanceReport> => {
      const cleanup = async () => {
        try {
          if (lease) await saveMaintenanceMeta(deps, lease,
            [...meta].filter(([key, value]) => originalMeta.get(key) !== value));
          const snapshot = await readLibraryState(deps);
          // A final reconcile page may just have discovered pending rows after the drain.
          // Completion cannot advertise a finished backfill while those rows still await work.
          if (outcome === "complete" && snapshot.status.counts.pending > 0) outcome = "partial";
          return { version: 1 as const, outcome, ...counts, ...snapshot };
        } finally {
          if (lease) await releaseMaintenanceLease(deps, lease);
        }
      };
      // Exactly one checkpoint statement + the shared three-read state helper + release.
      // The ledger keeps actual work counts; entering this scope never resets them.
      return deps.budget ? deps.budget.finalize(cleanup) : cleanup();
    };
    try {
      if (!canContinue()) { outcome = "partial"; return await finalize(); }
      lease = await acquireMaintenanceLease(deps, options.deadlineMs);
      if (!lease) { outcome = "busy"; return await finalize(); }
      if (!canContinue()) { outcome = "partial"; return await finalize(); }
      const initial = await deps.db.prepare(`SELECT key, value FROM index_meta
        WHERE key IN ('reconcile', 'last-reconciled-at', 'anomalies')`).all<{ key: string; value: string }>();
      for (const entry of initial.results) { meta.set(entry.key, entry.value); originalMeta.set(entry.key, entry.value); }

      let reconciledFirst = false;
      const reconcile = async () => {
        const result = await reconcileLibrary({ deps, records, lease: lease!, deadlineMs: options.deadlineMs,
          pages: options.listPages, explicit: options.reconcile === true, meta, canContinue,
          onPage: () => { counts.reconciledPages++; } });
        if (!result.complete && outcome !== "paused") outcome = "partial";
      };
      if (options.listPages > 0 && prioritizeReconcile(meta, options.reconcile === true)) {
        await reconcile();
        reconciledFirst = true;
      }

      // Manual retries stay exact and bounded. One ref at a time allows a caller's 48-ref
      // request to stop truthfully at the invocation budget without splitting a record batch.
      for (const ref of options.retry ?? []) {
        if (!canContinue()) { outcome = "partial"; break; }
        await records.retry([ref], lease);
      }
      if (canContinue() && options.documents > 0) {
        const repairs = (await deps.db.prepare(`SELECT id, token, at, restore_state AS restoreState,
          restore_version AS restoreVersion FROM deleted_ids WHERE state='deleting' AND at <= ?
          ORDER BY at, id COLLATE BINARY LIMIT ?`).bind(deps.now() - deps.config.deletionRepairMs, options.documents + 1)
          .all<DeletionClaim>()).results;
        for (const repair of repairs) {
          if (!canContinue() || counts.processed >= options.documents) { outcome = "partial"; break; }
          const result = await records.repairDeletion(repair, lease);
          counts.processed++;
          if (result !== "stale") counts.repaired++;
        }
      }
      if (canContinue() && counts.processed < options.documents) {
        const rows = (await deps.db.prepare(`SELECT id, version, state FROM documents d WHERE
          ((state='pending') OR (state='failed' AND attempts < ?) OR (state='indexed' AND extractor < ? AND attempts < ?))
          AND (retry_at IS NULL OR retry_at <= ?) AND (claim_until IS NULL OR claim_until <= ?)
          AND NOT EXISTS (SELECT 1 FROM deleted_ids t WHERE t.id=d.id)
          ORDER BY coalesce(retry_at, 0), id COLLATE BINARY LIMIT ?`)
          .bind(Math.min(5, deps.config.maxAttempts), deps.config.extractorVersion, Math.min(5, deps.config.maxAttempts),
            deps.now(), deps.now(), options.documents - counts.processed + 1)
          .all<{ id: string; version: string; state: string }>()).results;
        for (const ref of rows) {
          // Extraction may lose a stale finalization race and still return bytes. Reserve
          // its entire possible body before claiming, then charge the actual reported bytes.
          if (!canContinue() || counts.processed >= options.documents
            // Current records admission: claim 3 + validity/capacity/R2/body finalization,
            // plus two maintenance gate statements, needs at least 16 ordinary operations.
            // This is a preflight, never a charge or a guessed upper bound on R2 traversal;
            // the wrapped resources still reject every actual opaque operation over 40.
            || (deps.budget?.remaining ?? Infinity) < 16
            || options.textBytes - counts.textBytes < LIBRARY_LIMITS.bodyBytes) { outcome = "partial"; break; }
          if (!await prepareMaintenanceStorage(deps, lease)) {
            outcome = "paused";
            // Pending rows already satisfy the pause contract. Failed/upgrade rows must
            // cross records' guarded pause path so visible state/generation stays its owner.
            // Persisted pause prevents body extraction; available current text is retained.
            if (ref.state !== "pending" && canContinue()) {
              const claim = await records.claim(ref, lease);
              if (claim && canContinue()) {
                const result = await records.index(claim);
                counts.processed++;
                counts.textBytes += result.textBytes;
              }
            }
            break;
          }
          if (!canContinue()) { outcome = "partial"; break; }
          const claim = await records.claim(ref, lease);
          if (!claim) continue;
          if (!canContinue()) { outcome = "partial"; break; }
          const result = await records.index(claim);
          counts.processed++;
          counts.textBytes += result.textBytes;
          if (result.outcome === "indexed") counts.indexed++;
          if (result.outcome === "failed") counts.failed++;
          if (result.outcome === "paused") { outcome = "paused"; break; }
        }
      }
      // Reconcile adds metadata after the due drain; text waits for the next bounded run.
      // A paused text gate still permits names/repair discovery while budget remains.
      if (canContinue()) {
        if (!reconciledFirst) await reconcile();
      } else if (outcome !== "paused") outcome = "partial";
    } catch (error) {
      if (error instanceof InvocationBudgetExceeded) { if (outcome !== "paused") outcome = "partial"; }
      else {
        // Preserve successful within-page progress even if a later opaque storage operation
        // fails. Finalization is awaited and the original backend failure remains visible.
        await finalize();
        throw error;
      }
    }
    return finalize();
  } };
}

/** Admission is independent of the HTTP caller: cron and operator use this same policy.
 * Zero is valid to skip a phase; non-finite/fractional values never reach SQL.
 */
function validateOptions(options: MaintainOptions): void {
  const invalid = () => { throw new LibraryIndexError("invalid_library_request", "Invalid maintenance options.", false); };
  if (!options || typeof options !== "object") invalid();
  for (const key of ["documents", "textBytes", "listPages", "deadlineMs"] as const) {
    if (!Number.isSafeInteger(options[key]) || options[key] < 0) invalid();
  }
  if (options.reconcile !== undefined && typeof options.reconcile !== "boolean") invalid();
  if (options.retry !== undefined && (!Array.isArray(options.retry) || options.retry.length > LIBRARY_LIMITS.snippetRefs
    || options.retry.some((ref) => !ref || typeof ref.id !== "string" || !isUploadId(ref.id)
      || typeof ref.version !== "string" || !/^[a-f0-9]{64}$/.test(ref.version)))) invalid();
}

function admitOptions(deps: LibraryDependencies, request: MaintainOptions): MaintainOptions {
  for (const value of Object.values(deps.config)) {
    if (!Number.isSafeInteger(value) || value < 0) throw new LibraryIndexError("library_unavailable", "Invalid maintenance configuration.", false);
  }
  return { ...request,
    documents: Math.min(request.documents, deps.config.drainDocuments, 100),
    textBytes: Math.min(request.textBytes, deps.config.drainTextBytes, LIBRARY_LIMITS.drainBytes),
    deadlineMs: Math.min(request.deadlineMs, deps.config.maintenanceMs, LIBRARY_LIMITS.maintenanceMs),
    listPages: Math.min(request.listPages, deps.config.reconcilePages, 100),
  };
}
