import { describe, expect, it } from "vitest";
import { createLibraryFixture } from "./library-index.test-support";

describe("migrated local library schema", () => {
  it("uses native workerd HTML extraction for the default fixture dependency", async () => {
    const fixture = await createLibraryFixture();
    try {
      await fixture.bucket.put("Native01/page.html", "<p>Hello 😀 &amp; body</p><script>private script</script>", {
        customMetadata: { filename: "page.html", contentType: "text/html", docName: "Native extraction" },
      });
      const doc = (await fixture.documents.resolve("Native01"))!;
      expect(await fixture.deps.extract(doc)).toMatchObject({
        id: "Native01", documentVersion: doc.summary.version,
        coverage: "full", reason: null, text: "Hello 😀 & body",
      });
      await fixture.bucket.put("Native01/page.html", "<p>replacement</p>");
      await expect(fixture.deps.extract(doc)).rejects.toThrow(/changed/);
    } finally { await fixture.dispose(); }
  }, 20_000);

  it("stores metadata/text with a stable FTS rowid and supports contentless trigram deletion", async () => {
    const fixture = await createLibraryFixture();
    try {
      const { db, bucket, documents } = fixture;
      await bucket.put("Schema01/note.txt", "body needle", {
        customMetadata: { filename: "note.txt", contentType: "text/plain", docName: "A needle" },
      });
      const summary = (await documents.resolve("Schema01"))!.summary;
      await db.prepare(`INSERT INTO documents
        (id, version, title, filename, kind, mime, size_bytes, uploaded_at, uploaded_at_iso,
         time_source, created_at, object_count, warnings_json, state, coverage, source_bytes,
         indexed_bytes, extractor, changed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'indexed', 'full', ?, 11, 1, ?)`)
        .bind(summary.id, summary.version, summary.title, summary.filename, summary.kind, summary.mime,
          summary.sizeBytes, Date.parse(summary.uploadedAt), summary.uploadedAt, summary.timeSource,
          summary.createdAt, summary.objectCount, JSON.stringify(summary.warnings), summary.sizeBytes, 1234).run();
      const row = await db.prepare("SELECT * FROM documents WHERE id = ?").bind(summary.id)
        .first<{ doc: number; uploaded_at_iso: string; warnings_json: string; created_at: string | null }>();
      expect(row).toMatchObject({ uploaded_at_iso: summary.uploadedAt, warnings_json: "[]", created_at: null });
      await db.batch([
        db.prepare("INSERT INTO document_text(doc, body) VALUES (?, ?)").bind(row!.doc, "body needle"),
        db.prepare("INSERT INTO document_fts(rowid, title, filename, body) VALUES (?, ?, ?, ?)")
          .bind(row!.doc, summary.title, summary.filename, "body needle"),
      ]);
      expect(await db.prepare("SELECT rowid FROM document_fts WHERE document_fts MATCH ?")
        .bind('"needle"').all()).toMatchObject({ results: [{ rowid: row!.doc }] });
      expect(await db.prepare("SELECT body FROM document_text WHERE doc = ?").bind(row!.doc).first("body"))
        .toBe("body needle");
      await db.prepare("DELETE FROM document_fts WHERE rowid = ?").bind(row!.doc).run();
      expect((await db.prepare("SELECT rowid FROM document_fts WHERE document_fts MATCH ?")
        .bind('"needle"').all()).results).toEqual([]);
      await expect(db.prepare("UPDATE documents SET state = 'unknown'").run()).rejects.toThrow();
      await expect(db.prepare("UPDATE document_text SET body = ?").bind("bad\0text").run()).rejects.toThrow();
      expect(await db.prepare("SELECT value FROM index_meta WHERE key = 'generation'").first("value")).toBe("0");
    } finally { await fixture.dispose(); }
  }, 20_000);

  it("retains distinct operation identities at the same wall-clock time and rejects partial lease ownership", async () => {
    const fixture = await createLibraryFixture();
    try {
      const { db } = fixture;
      await db.batch([
        db.prepare("INSERT INTO deleted_ids(id, state, token, at) VALUES (?, 'deleting', ?, ?)")
          .bind("Token001", "delete-owner-A", 1000),
        db.prepare("INSERT INTO deleted_ids(id, state, token, at) VALUES (?, 'deleting', ?, ?)")
          .bind("Token002", "delete-owner-B", 1000),
        db.prepare("INSERT INTO index_meta(key, value, token, expires_at) VALUES ('maintenance-lease', '', ?, ?)")
          .bind("lease-owner-A", 41000),
      ]);
      expect((await db.prepare("SELECT token, at FROM deleted_ids ORDER BY id").all()).results)
        .toEqual([{ token: "delete-owner-A", at: 1000 }, { token: "delete-owner-B", at: 1000 }]);
      await expect(db.prepare("INSERT INTO deleted_ids(id, state, token, at) VALUES ('Token003', 'deleting', '', 1000)")
        .run()).rejects.toThrow();
      await expect(db.prepare("UPDATE index_meta SET expires_at = NULL WHERE key = 'maintenance-lease'")
        .run()).rejects.toThrow();
    } finally { await fixture.dispose(); }
  }, 20_000);
});
