import type { DocumentSummary, SelectionRef, TextRecord } from "../contracts";
import { isUploadId } from "../documents";
import { InvocationBudgetExceeded } from "../invocation-budget";
import { LIBRARY_LIMITS } from "../library-contracts";
import type { LibraryStatus } from "../library-contracts";
import type { DeletionClaim, IndexRecordResult, LibraryDependencies, LibraryRecords,
  MaintenanceLease, RecordClaim, RecordWrite } from "./contracts";
import { LibraryIndexError } from "./contracts";

type Sql = { sql: string; values: unknown[] };
const sql = (query: string, ...values: unknown[]): Sql => ({ sql: query, values });
const encoder = new TextEncoder();
const PAUSED = "paused: index size budget";
// Admission policy shared with maintenance: native 512-KiB entropy regressed the empirical
// 3.2x planning estimate. Reserve 16x text +16 KiB; this is conservative headroom, not a
// universal SQLite bound. Keep actual-size samples, the generation fence and storage-full pause.
const TEXT_STORAGE_MULTIPLIER = 16;
const TEXT_STORAGE_HEADROOM_BYTES = 16 * 1024;
const active = "(SELECT token FROM index_meta WHERE key='generation') = ?";
const noTombstone = "NOT EXISTS (SELECT 1 FROM deleted_ids WHERE id=?)";

/** All lifecycle mutations live here, behind the same Documents interface used by both writers.
 * R2 remains authoritative: uploads survive derived-index outages, while deletes must durably hide
 * before touching R2. SQL batches fence each async handoff with version and unique operation tokens.
 */
export function createLibraryRecords(deps: LibraryDependencies): LibraryRecords {
  const { db } = deps;
  const prepare = (part: Sql) => db.prepare(part.sql).bind(...part.values);
  const leaseGuard = (lease?: MaintenanceLease | null): Sql => lease
    ? sql("EXISTS (SELECT 1 FROM index_meta WHERE key='maintenance-lease' AND token=? AND expires_at>?)", lease.token, deps.now())
    : sql("1");
  const combine = (...parts: Sql[]): Sql => sql(parts.map((part) => `(${part.sql})`).join(" AND "), ...parts.flatMap((part) => part.values));

  /** Admission and all effects are one native D1 transaction, admitted whole by the budget wrapper.
   * The generation row's token is a transaction-local latch, cleared before commit (also rolled
   * back on failure). Unlike repeating a predicate after changing its row, this preserves one guard
   * across metadata/text/FTS effects. No schema/key is added and readers only consume its value.
   */
  async function mutate(guard: Sql, visible: Sql | boolean, steps: Sql[]): Promise<boolean> {
    const token = deps.nonce();
    const change = typeof visible === "boolean" ? sql(visible ? "1" : "0") : visible;
    const result = await db.batch([
      prepare(sql(`UPDATE index_meta SET value=CAST(CAST(value AS INTEGER) + CASE WHEN ${change.sql} THEN 1 ELSE 0 END AS TEXT),
        token=?, expires_at=? WHERE key='generation' AND (${guard.sql})`, ...change.values, token, deps.now(), ...guard.values)),
      ...steps.map((step) => prepare(sql(step.sql.replace(/@guard/g, active), ...step.values, token))),
      prepare(sql("UPDATE index_meta SET token=NULL, expires_at=NULL WHERE key='generation' AND token=?", token)),
    ]);
    return result[0].meta.changes === 1;
  }

  const recordGuard = (claim: RecordClaim): Sql => combine(sql(`EXISTS (SELECT 1 FROM documents WHERE id=? AND version=?
    AND state IN ('pending','failed','indexed') AND claim_token=? AND claim_until=? AND claim_until>?)`,
  claim.ref.id, claim.ref.version, claim.token, claim.expiresAt, deps.now()),
  sql(noTombstone, claim.ref.id), leaseGuard(claim.lease));
  const deletionGuard = (claim: DeletionClaim, lease?: MaintenanceLease): Sql => combine(sql(`EXISTS
    (SELECT 1 FROM deleted_ids WHERE id=? AND state='deleting' AND token=? AND restore_version IS ?)
    AND NOT EXISTS (SELECT 1 FROM documents WHERE id=? AND (state!='deleting' OR version IS NOT ?))`,
  claim.id, claim.token, claim.restoreVersion, claim.id, claim.restoreVersion), leaseGuard(lease));

  async function ingest(summary: DocumentSummary, observedAt: number, lease?: MaintenanceLease): Promise<RecordWrite> {
    // Wall clocks can tie. When replacing a known version, resolve R2 again and fence that
    // asynchronous observation with the captured generation; an older upload/listing cannot
    // overwrite a newer ingest merely because both mutations happened in the same millisecond.
    const before = await prepare(sql(`SELECT version,(SELECT value FROM index_meta WHERE key='generation') AS generation
      FROM documents WHERE id=?`, summary.id)).first<{ version: string; generation: string }>();
    let predecessor: Sql = before ? sql("EXISTS(SELECT 1 FROM documents WHERE id=? AND version=?)", summary.id, before.version)
      : sql("NOT EXISTS(SELECT 1 FROM documents WHERE id=?)", summary.id);
    if (before && before.version !== summary.version) {
      const current = await deps.documents.resolve(summary.id);
      if (!current || current.summary.version !== summary.version) return "stale";
      predecessor = combine(predecessor, sql("(SELECT value FROM index_meta WHERE key='generation')=?", before.generation));
    }
    const fields = ["version", "title", "filename", "kind", "mime", "size_bytes", "uploaded_at", "uploaded_at_iso",
      "time_source", "created_at", "object_count", "warnings_json"];
    const values = [summary.version, summary.title, summary.filename, summary.kind, summary.mime, summary.sizeBytes,
      Date.parse(summary.uploadedAt), summary.uploadedAt, summary.timeSource, summary.createdAt, summary.objectCount, JSON.stringify(summary.warnings)];
    const different = sql(`NOT EXISTS (SELECT 1 FROM documents WHERE id=? AND ${fields.map((field) => `${field} IS ?`).join(" AND ")})`, summary.id, ...values);
    const admitted = await mutate(combine(sql(noTombstone, summary.id), leaseGuard(lease), predecessor, different,
      sql("NOT EXISTS (SELECT 1 FROM documents WHERE id=? AND (state='deleting' OR changed_at>?))", summary.id, observedAt)), true, [
      sql("DELETE FROM document_fts WHERE rowid IN (SELECT doc FROM documents WHERE id=?) AND @guard", summary.id),
      sql("DELETE FROM document_text WHERE doc IN (SELECT doc FROM documents WHERE id=? AND version!=?) AND @guard", summary.id, summary.version),
      sql(`INSERT INTO documents(id, ${fields.join(",")}, state, changed_at)
        SELECT ?, ${fields.map(() => "?").join(",")}, 'pending', ? WHERE @guard
        ON CONFLICT(id) DO UPDATE SET ${fields.map((field) => `${field}=excluded.${field}`).join(",")},
        state=CASE WHEN documents.version=excluded.version THEN documents.state ELSE 'pending' END,
        coverage=CASE WHEN documents.version=excluded.version THEN documents.coverage ELSE NULL END,
        reason=CASE WHEN documents.version=excluded.version THEN documents.reason ELSE NULL END,
        source_bytes=CASE WHEN documents.version=excluded.version THEN documents.source_bytes ELSE 0 END,
        indexed_bytes=CASE WHEN documents.version=excluded.version THEN documents.indexed_bytes ELSE 0 END,
        extractor=CASE WHEN documents.version=excluded.version THEN documents.extractor ELSE 0 END,
        attempts=CASE WHEN documents.version=excluded.version THEN documents.attempts ELSE 0 END,
        retry_at=CASE WHEN documents.version=excluded.version THEN documents.retry_at ELSE NULL END,
        claim_token=CASE WHEN documents.version=excluded.version THEN documents.claim_token ELSE NULL END,
        claim_until=CASE WHEN documents.version=excluded.version THEN documents.claim_until ELSE NULL END,
        changed_at=excluded.changed_at`, summary.id, ...values, deps.now()),
      sql(`INSERT INTO document_fts(rowid,title,filename,body)
        SELECT d.doc,d.title,d.filename,coalesce(t.body,'') FROM documents d LEFT JOIN document_text t ON t.doc=d.doc
        WHERE d.id=? AND @guard`, summary.id),
    ]);
    if (admitted) return "written";
    const result = await prepare(sql(`SELECT EXISTS(SELECT 1 FROM deleted_ids WHERE id=?) AS tombstone,
      EXISTS(SELECT 1 FROM documents WHERE id=? AND ${fields.map((field) => `${field} IS ?`).join(" AND ")} AND state!='deleting') AND (${leaseGuard(lease).sql}) AS current`,
    summary.id, summary.id, ...values, ...leaseGuard(lease).values)).first<{ tombstone: number; current: number }>();
    return result!.tombstone ? "tombstoned" : result!.current ? "unchanged" : "stale";
  }

  async function claim(ref: SelectionRef, lease?: MaintenanceLease): Promise<RecordClaim | null> {
    const now = deps.now();
    const result: RecordClaim = { ref: { id: ref.id, version: ref.version }, token: deps.nonce(),
      expiresAt: now + 2 * deps.config.maintenanceMs, lease: lease ? { ...lease } : null };
    // Claim/attempt bookkeeping never changes visible state or generation. A live token excludes
    // both upload waitUntil and maintenance; expiry permits recovery after a terminated invocation.
    const admitted = await mutate(combine(leaseGuard(lease), sql(noTombstone, ref.id), sql(`EXISTS
      (SELECT 1 FROM documents WHERE id=? AND version=? AND state!='deleting'
      AND (state='pending' OR (state='failed' AND attempts<?) OR extractor<?)
      AND (retry_at IS NULL OR retry_at<=?) AND (claim_until IS NULL OR claim_until<=?))`,
    ref.id, ref.version, deps.config.maxAttempts, deps.config.extractorVersion, now, now)), false, [
      sql("UPDATE documents SET claim_token=?, claim_until=? WHERE id=? AND version=? AND @guard", result.token, result.expiresAt, ref.id, ref.version),
    ]);
    return admitted ? result : null;
  }

  const storageGuard = () => sql(`NOT EXISTS (SELECT 1 FROM index_meta WHERE key='storage'
    AND (json_extract(value,'$.paused')=1 OR json_extract(value,'$.bytes')>=?
      OR json_extract(value,'$.projectedBytes')>?))`, deps.config.sizeBudgetBytes, deps.config.sizeBudgetBytes);

  /** Actual size is sampled before extraction AND before write. The final transaction also checks
   * persisted pause, closing a concurrent maintenance pause. Source projections are estimates;
   * the bounded next body reserves growth headroom even before the 50-document measured estimate.
   */
  async function capacity(nextBytes: number): Promise<{ allowed: boolean; generation: string }> {
    const result = await prepare(sql(`SELECT (SELECT value FROM index_meta WHERE key='storage') AS storage,
      (SELECT value FROM index_meta WHERE key='generation') AS generation,
      (SELECT count(*) FROM documents WHERE state='indexed') AS indexed,
      (SELECT count(*) FROM documents WHERE state='pending' OR state='failed') AS pending`)).all<{ storage: string | null; generation: string; indexed: number; pending: number }>();
    const info = result.results[0];
    const stored = info.storage ? JSON.parse(info.storage) as LibraryStatus["storage"] : null;
    const bytes = Math.max(result.meta.size_after, stored?.bytes ?? 0);
    const budgetBytes = deps.config.sizeBudgetBytes;
    const projectedBytes = info.indexed >= 50 ? Math.ceil(bytes + info.pending * bytes / info.indexed) : stored?.projectedBytes ?? null;
    if (stored?.paused || !Number.isSafeInteger(budgetBytes) || budgetBytes <= 0
      || bytes + Math.ceil(TEXT_STORAGE_MULTIPLIER * nextBytes) + TEXT_STORAGE_HEADROOM_BYTES > budgetBytes || (projectedBytes !== null && projectedBytes > budgetBytes)) {
      const storage: LibraryStatus["storage"] = { bytes, budgetBytes, planningBytes: stored?.planningBytes ?? null,
        projectedBytes, paused: true, reason: PAUSED };
      await prepare(sql(`INSERT INTO index_meta(key,value) VALUES ('storage',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, JSON.stringify(storage))).run();
      return { allowed: false, generation: info.generation };
    }
    return { allowed: true, generation: info.generation };
  }

  async function release(claim: RecordClaim, paused = false): Promise<void> {
    // Storage pause is pending work, including a formerly failed retry or extractor upgrade.
    // Retain available text/coverage and attempt history; only a visible state change bumps generation.
    await mutate(recordGuard(claim), paused ? sql("EXISTS(SELECT 1 FROM documents WHERE id=? AND state!='pending')", claim.ref.id) : false, [
      sql(`UPDATE documents SET state=CASE WHEN ? THEN 'pending' ELSE state END,
        changed_at=CASE WHEN ? AND state!='pending' THEN ? ELSE changed_at END,
        claim_token=NULL, claim_until=NULL WHERE id=? AND @guard`, Number(paused), Number(paused), deps.now(), claim.ref.id),
    ]);
  }

  async function writeText(claim: RecordClaim, record: TextRecord, capacityGeneration: string): Promise<boolean> {
    const failed = record.coverage === "error";
    const state = failed ? "failed" : "indexed";
    const visibleChange = sql(`NOT EXISTS (SELECT 1 FROM documents d LEFT JOIN document_text t ON d.doc=t.doc
      WHERE d.id=? AND d.state=? AND d.coverage IS ? AND d.reason IS ? AND d.source_bytes=?
      AND d.indexed_bytes=? AND d.extractor=? AND coalesce(t.body,'')=?)`, claim.ref.id, state, record.coverage,
    record.reason, record.sourceBytes, record.indexedBytes, record.extractorVersion, record.text);
    const now = deps.now();
    // The sampled generation and actual size come from the same D1 statement. Since every
    // visible body/metadata write bumps it, only one concurrent writer can spend that capacity.
    // A loser remeasures using its already-extracted text instead of bypassing the size gate.
    return mutate(combine(recordGuard(claim), storageGuard(),
      sql("(SELECT value FROM index_meta WHERE key='generation')=?", capacityGeneration)), visibleChange, [
      // Read the old body when deciding changed_at, before replacing document_text. All
      // subsequent effects use the transaction latch even though this clears the row's claim.
      sql(`UPDATE documents SET state=?, coverage=?, reason=?, source_bytes=?, indexed_bytes=?, extractor=?,
        attempts=CASE WHEN ? THEN attempts+1 ELSE 0 END,
        retry_at=CASE WHEN ? AND attempts+1<? THEN ? + min(3600000,60000*(1 << min(attempts,6))) ELSE NULL END,
        claim_token=NULL, claim_until=NULL, changed_at=CASE WHEN ${visibleChange.sql} THEN ? ELSE changed_at END
        WHERE id=? AND @guard`, state, record.coverage, record.reason, record.sourceBytes, record.indexedBytes,
      record.extractorVersion, Number(failed), Number(failed), deps.config.maxAttempts, now, ...visibleChange.values, now, claim.ref.id),
      sql(`INSERT INTO document_text(doc,body) SELECT doc,? FROM documents WHERE id=? AND @guard
        ON CONFLICT(doc) DO UPDATE SET body=excluded.body`, record.text, claim.ref.id),
      sql("DELETE FROM document_fts WHERE rowid IN (SELECT doc FROM documents WHERE id=?) AND @guard", claim.ref.id),
      sql("INSERT INTO document_fts(rowid,title,filename,body) SELECT doc,title,filename,? FROM documents WHERE id=? AND @guard", record.text, claim.ref.id),
    ]);
  }

  async function index(claim: RecordClaim): Promise<IndexRecordResult> {
    let textBytes = 0;
    const stale = (): IndexRecordResult => ({ outcome: "stale", textBytes });
    if (!await prepare(sql(`SELECT 1 WHERE ${recordGuard(claim).sql}`, ...recordGuard(claim).values)).first()) return stale();
    // Compressed source bytes do not bound extracted text. Admit the full 512-KiB text cap
    // before extraction; the second gate can use the actual bounded output without re-extracting.
    if (!(await capacity(LIBRARY_LIMITS.bodyBytes)).allowed) { await release(claim, true); return { outcome: "paused", textBytes }; }
    let record: TextRecord;
    try {
      const doc = await deps.documents.resolve(claim.ref.id);
      if (!doc || doc.summary.version !== claim.ref.version) { await release(claim); return stale(); }
      record = boundedText(await deps.extract(doc), claim.ref, deps.config.extractorVersion);
      textBytes = record.indexedBytes;
    } catch (error) {
      // Admission is retryable orchestration, never an extraction attempt. Wrapped resources have
      // already accounted for every admitted operation; this module must not double-charge them.
      if (isAdmission(error)) throw error;
      if (isStorageFull(error)) { await pauseStorage(); await release(claim, true); return { outcome: "paused", textBytes }; }
      record = { version: 1, id: claim.ref.id, documentVersion: claim.ref.version, coverage: "error",
        reason: "The document could not be read or parsed within the extraction limits.", text: "", sourceBytes: 0, indexedBytes: 0, extractorVersion: deps.config.extractorVersion };
    }
    try {
      // At most one retry of finalization, retaining the extracted body. Resource wrappers still
      // admit each whole batch before I/O; contention or budget refusal never spends an attempt.
      for (let attempt = 0; attempt < 2; attempt++) {
        const gate = await capacity(record.indexedBytes);
        if (!gate.allowed) { await release(claim, true); return { outcome: "paused", textBytes }; }
        if (await writeText(claim, record, gate.generation)) return { outcome: record.coverage === "error" ? "failed" : "indexed", textBytes };
        if (!await prepare(sql(`SELECT 1 WHERE ${recordGuard(claim).sql}`, ...recordGuard(claim).values)).first()) return stale();
      }
      await release(claim);
      return stale();
    } catch (error) {
      if (isStorageFull(error)) { await pauseStorage(); await release(claim, true); return { outcome: "paused", textBytes }; }
      throw error;
    }
  }

  async function pauseStorage(): Promise<void> {
    // Do not copy a backend error, SQL or bindings into status/logs. If D1 is already full even
    // this small write may fail; callers retain pending work and a retryable unavailable response.
    await prepare(sql(`INSERT INTO index_meta(key,value) VALUES ('storage',json_object('bytes',0,'budgetBytes',?,
      'planningBytes',NULL,'projectedBytes',NULL,'paused',json('true'),'reason',?)) ON CONFLICT(key) DO UPDATE
      SET value=json_set(value,'$.paused',json('true'),'$.reason',?)`, deps.config.sizeBudgetBytes, PAUSED, PAUSED)).run();
  }

  async function finalizeDeletion(claim: DeletionClaim, lease?: MaintenanceLease): Promise<boolean> {
    return mutate(deletionGuard(claim, lease), false, [
      sql("DELETE FROM document_fts WHERE rowid IN (SELECT doc FROM documents WHERE id=?) AND @guard", claim.id),
      sql("DELETE FROM document_text WHERE doc IN (SELECT doc FROM documents WHERE id=?) AND @guard", claim.id),
      sql("DELETE FROM documents WHERE id=? AND @guard", claim.id),
      sql("UPDATE deleted_ids SET state='deleted' WHERE id=? AND token=? AND @guard", claim.id, claim.token),
    ]);
  }

  async function restoreDeletion(claim: DeletionClaim, lease?: MaintenanceLease): Promise<boolean> {
    return mutate(deletionGuard(claim, lease), sql("EXISTS(SELECT 1 FROM documents WHERE id=? AND state='deleting')", claim.id), [
      sql("UPDATE documents SET state=?, changed_at=?, claim_token=NULL, claim_until=NULL WHERE id=? AND version IS ? AND @guard",
        claim.restoreState ?? "pending", deps.now(), claim.id, claim.restoreVersion),
      sql("DELETE FROM deleted_ids WHERE id=? AND token=? AND state='deleting' AND @guard", claim.id, claim.token),
    ]);
  }

  async function readDeletion(id: string): Promise<DeletionClaim & { state: string } | null> {
    return prepare(sql(`SELECT id,token,at,restore_state AS restoreState,restore_version AS restoreVersion,state
      FROM deleted_ids WHERE id=?`, id)).first<DeletionClaim & { state: string }>();
  }

  const records: LibraryRecords = {
    documents: {
      async create(input) {
        const summary = await deps.documents.create(input);
        try {
          await ingest(summary, deps.now());
          // Attach the rejection handler before handing lifetime to waitUntil. It never leaks raw
          // backend errors or loses a successful R2 response, even when defer itself refuses work.
          const work = (async () => { const owned = await claim(summary); if (owned) await index(owned); })()
            .catch(() => { safeLog("deferred-index"); });
          deps.defer(work);
        } catch { safeLog("upload-upkeep"); }
        return summary;
      },
      page: (cursor) => deps.documents.page(cursor),
      resolve: (id) => deps.documents.resolve(id),
      async remove(id, expectedVersion) {
        if (!isUploadId(id)) return { status: "not-found", deletedObjectCount: 0 };
        const token = deps.nonce();
        const at = deps.now();
        const hidden = await mutate(sql(noTombstone, id), sql("EXISTS(SELECT 1 FROM documents WHERE id=? AND state!='deleting')", id), [
          sql(`INSERT INTO deleted_ids(id,state,token,restore_state,restore_version,at)
            SELECT ?,'deleting',?,(SELECT state FROM documents WHERE id=?),(SELECT version FROM documents WHERE id=?),? WHERE @guard`, id, token, id, id, at),
          sql("UPDATE documents SET state='deleting', changed_at=?, claim_token=NULL, claim_until=NULL WHERE id=? AND @guard", at, id),
        ]);
        const owned = await readDeletion(id);
        if (!hidden || !owned || owned.token !== token) {
          if (owned?.state === "deleted") return { status: "not-found", deletedObjectCount: 0 };
          throw unavailable();
        }
        // A concurrent delete refuses the active nonce rather than stealing a same-clock marker.
        // R2 exceptions leave this marker hidden; ten-minute leased repair owns the next decision.
        const result = await deps.documents.remove(id, expectedVersion);
        const completed = result.status === "changed" ? await restoreDeletion(owned) : await finalizeDeletion(owned);
        if (!completed) throw unavailable(); // A late loser must never advertise another operation's success.
        return result;
      },
    },
    ingest, claim, index,
    async repairDeletion(claim, lease) {
      const current = await readDeletion(claim.id);
      if (!current || current.state !== "deleting" || current.token !== claim.token || current.restoreVersion !== claim.restoreVersion
        || current.at + deps.config.deletionRepairMs > deps.now()) return "stale";
      const doc = await deps.documents.resolve(claim.id);
      // A permanent marker is never cleared, including for unsupported external recreation.
      const done = doc ? await restoreDeletion(current, lease) : await finalizeDeletion(current, lease);
      return done ? (doc ? "restored" : "deleted") : "stale";
    },
    async confirmMissing(ref, observedAt, lease) {
      // Generation fences the resolve handoff even if another visible mutation used the same clock.
      // A conservative lost race is retried by reconcile; it cannot tombstone a newer ingest.
      const snapshot = await prepare(sql(`SELECT d.changed_at,(SELECT value FROM index_meta WHERE key='generation') AS generation
        FROM documents d WHERE id=? AND version=? AND state!='deleting' AND changed_at<? AND ${noTombstone}`,
      ref.id, ref.version, observedAt, ref.id)).first<{ changed_at: number; generation: string }>();
      if (!snapshot || await deps.documents.resolve(ref.id)) return "stale";
      const token = deps.nonce();
      return await mutate(combine(leaseGuard(lease), sql(noTombstone, ref.id), sql(`EXISTS
        (SELECT 1 FROM documents WHERE id=? AND version=? AND state!='deleting' AND changed_at=? AND changed_at<?)
        AND (SELECT value FROM index_meta WHERE key='generation')=?`, ref.id, ref.version, snapshot.changed_at, observedAt, snapshot.generation)), true, [
        sql("INSERT INTO deleted_ids(id,state,token,at) SELECT ?,'deleted',?,? WHERE @guard", ref.id, token, deps.now()),
        sql("DELETE FROM document_fts WHERE rowid IN (SELECT doc FROM documents WHERE id=?) AND @guard", ref.id),
        sql("DELETE FROM document_text WHERE doc IN (SELECT doc FROM documents WHERE id=?) AND @guard", ref.id),
        sql("DELETE FROM documents WHERE id=? AND version=? AND @guard", ref.id, ref.version),
      ]) ? "written" : "stale";
    },
    async retry(refs, lease) {
      if (refs.length > LIBRARY_LIMITS.snippetRefs) throw new LibraryIndexError("invalid_library_request", "Too many retry references.", false);
      // One JSON-bound exact-ref update fits the shared invocation budget even at 48 refs;
      // resetting attempts/retry timing never changes the visible failed state or generation.
      const leaseCheck = leaseGuard(lease);
      const result = await db.batch([prepare(sql(`UPDATE documents SET attempts=0,retry_at=NULL,claim_token=NULL,claim_until=NULL
        WHERE state='failed' AND (attempts!=0 OR retry_at IS NOT NULL)
        AND (claim_until IS NULL OR claim_until<=?) AND (${leaseCheck.sql})
        AND NOT EXISTS (SELECT 1 FROM deleted_ids x WHERE x.id=documents.id)
        AND EXISTS (SELECT 1 FROM json_each(?) r WHERE json_extract(r.value,'$.id')=documents.id
          AND json_extract(r.value,'$.version')=documents.version)`, deps.now(), ...leaseCheck.values, JSON.stringify(refs)))]);
      return result[0].meta.changes;
    },
  };
  return records;
}

/** Defense at the persistence seam: trusted extraction is already bounded, but no injected
 * extractor may store a foreign ref, NUL, binary controls or more than 512 KiB of UTF-8 text.
 */
function boundedText(record: TextRecord, ref: SelectionRef, extractor: TextRecord["extractorVersion"]): TextRecord {
  if (record.id !== ref.id || record.documentVersion !== ref.version || record.extractorVersion !== extractor
    || !["full", "truncated", "metadata-only", "error"].includes(record.coverage)) throw unavailable();
  const prefix = record.text.slice(0, LIBRARY_LIMITS.bodyBytes);
  const clean = prefix.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, " ");
  const output = new Uint8Array(LIBRARY_LIMITS.bodyBytes);
  const { read, written } = encoder.encodeInto(clean, output);
  const limited = prefix.length !== record.text.length || prefix !== clean || read !== clean.length;
  const searchable = record.coverage === "full" || record.coverage === "truncated";
  return { ...record, text: searchable ? new TextDecoder().decode(output.subarray(0, written)) : "",
    indexedBytes: searchable ? written : 0, sourceBytes: Number.isSafeInteger(record.sourceBytes) && record.sourceBytes >= 0 ? record.sourceBytes : 0,
    coverage: searchable && limited ? "truncated" : record.coverage,
    reason: limited && searchable ? "Extracted text was sanitized or limited to 512 KiB UTF-8." : record.reason?.slice(0, 1024) ?? null };
}
function unavailable() { return new LibraryIndexError("library_unavailable", "Document index upkeep could not complete; retry later.", true); }
function isAdmission(error: unknown): boolean { return error instanceof InvocationBudgetExceeded; }
function isStorageFull(error: unknown): boolean {
  return error instanceof Error && /SQLITE_FULL|Exceeded maximum DB size|database or disk is full|storage (?:limit|quota)|database.*(?:size|storage).*limit/i.test(error.message);
}
function safeLog(category: "upload-upkeep" | "deferred-index") { console.warn("library-records", { category }); }
