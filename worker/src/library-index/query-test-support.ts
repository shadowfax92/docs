import type { DocumentSummary } from "../contracts";

/** Query tests seed the derived tables directly so lifecycle stubs cannot masquerade as a
 * successful write pipeline. All reads and SQL constraints still execute in native D1.
 */
export interface QuerySeed {
  summary: DocumentSummary;
  body: string;
  state?: "pending" | "indexed" | "failed" | "deleting";
  coverage?: "full" | "truncated" | "metadata-only" | "error" | null;
}

export function querySummary(index: number, patch: Partial<DocumentSummary> = {}): DocumentSummary {
  const id = `Q${String(index).padStart(7, "0")}`;
  return {
    id, version: `version-${index}`, title: `Document ${index}`, filename: `note-${index}.txt`,
    kind: "text", mime: "text/plain", sizeBytes: 123, uploadedAt: "2026-10-15T12:00:00.000Z",
    timeSource: "r2", createdAt: null, objectCount: 1, warnings: [],
    publicUrl: `https://docs.example/${id}`, rawUrl: `https://docs.example/${id}/raw`,
    downloadUrl: `https://docs.example/${id}/download`, ...patch,
  };
}

export async function seedQueryRows(db: D1Database, rows: QuerySeed[]): Promise<void> {
  // Small batches also keep fixture population below D1's statement/response size ceilings.
  for (const row of rows) {
    const s = row.summary;
    const result = await db.prepare(`INSERT INTO documents
      (id, version, title, filename, kind, mime, size_bytes, uploaded_at, uploaded_at_iso,
       time_source, created_at, object_count, warnings_json, state, coverage, indexed_bytes,
       source_bytes, extractor, changed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING doc`)
      .bind(s.id, s.version, s.title, s.filename, s.kind, s.mime, s.sizeBytes,
        Date.parse(s.uploadedAt), s.uploadedAt, s.timeSource, s.createdAt, s.objectCount,
        JSON.stringify(s.warnings), row.state ?? "indexed", row.coverage === undefined ? "full" : row.coverage,
        new TextEncoder().encode(row.body).length, s.sizeBytes, 1, 1).first<{ doc: number }>();
    await db.batch([
      db.prepare("INSERT INTO document_text(doc,body) VALUES (?,?)").bind(result!.doc, row.body),
      db.prepare("INSERT INTO document_fts(rowid,title,filename,body) VALUES (?,?,?,?)")
        .bind(result!.doc, s.title, s.filename, row.body),
    ]);
  }
}

/** Trace/delay real D1 calls without replacing SQL execution. A pre-read hook can place an
 * actual generation mutation between awaits; body measurements retain numbers only.
 */
export function observeQueryDB(native: D1Database, before?: (sql: string[]) => Promise<void> | void) {
  const reads: string[] = [];
  const bodyPages: { rows: number; bytes: number }[] = [];
  const original = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
  const sqlFor = new WeakMap<D1PreparedStatement, string>();
  function observeResult(value: unknown) {
    const rows = (value as { results?: Record<string, unknown>[] })?.results;
    if (!rows?.some((row) => typeof row.body === "string")) return;
    bodyPages.push({ rows: rows.length,
      bytes: rows.reduce((n, row) => n + (typeof row.body === "string" ? new TextEncoder().encode(row.body).length : 0), 0) });
  }
  function wrap(statement: D1PreparedStatement, sql: string): D1PreparedStatement {
    const wrapped = new Proxy(statement, {
      get(target, key) {
        if (key === "bind") return (...args: unknown[]) => wrap(target.bind(...args), sql);
        if (["all", "first", "run", "raw"].includes(String(key))) return async (...args: unknown[]) => {
          reads.push(sql);
          await before?.([sql]);
          const result = await (Reflect.get(target, key) as (...args: unknown[]) => Promise<unknown>).apply(target, args);
          observeResult(result);
          return result;
        };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    original.set(wrapped, statement);
    sqlFor.set(wrapped, sql);
    return wrapped;
  }
  const db = new Proxy(native, {
    get(target, key) {
      if (key === "prepare") return (sql: string) => wrap(target.prepare(sql), sql);
      if (key === "batch") return async (statements: D1PreparedStatement[]) => {
        const sql = statements.map((statement) => sqlFor.get(statement)!);
        reads.push(...sql);
        await before?.(sql);
        const results = await target.batch(statements.map((statement) => original.get(statement) ?? statement));
        results.forEach(observeResult);
        return results;
      };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { db, reads, bodyPages };
}
