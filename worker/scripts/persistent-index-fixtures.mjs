import { createHash } from 'node:crypto';

/** Cached scale corpus only: native D1 contains the committed schema and real FTS entries.
 * A representative prefix also has native R2 sources/versions for rendering and byte checks.
 * This is fixture seeding, never an alternate query/extraction implementation or backfill proof.
 */
export async function seedCachedCorpus(mf, count = 5000) {
  const db = await mf.getD1Database('LIBRARY_DB', 'public');
  const bucket = await mf.getR2Bucket('DOCS_BUCKET', 'public');
  let statements = [];
  const timestamp = Date.now() - 86400000;
  for (let i = 0; i < count; i++) {
    const id = `C${String(i).padStart(7, '0')}`, filename = `policy-handbook-${i}.txt`, title = `Policy handbook ${i}`;
    const text = `Database policy ${i}. BodySentinel BodySentinel CaseNeedle literal.a+b 😀 UTF16 needle.\n` + 'A cached native source paragraph with ordinary policy text. '.repeat(26);
    let version = createHash('sha256').update(id + text).digest('hex');
    if (i < 48) {
      const object = await bucket.put(`${id}/${filename}`, text, { customMetadata: { filename, contentType: 'text/plain', docName: title } });
      version = createHash('sha256').update(JSON.stringify([[object.key, object.version]])).digest('hex');
    }
    statements.push(db.prepare(`INSERT INTO documents(doc,id,version,title,filename,kind,mime,size_bytes,
      uploaded_at,uploaded_at_iso,object_count,state,coverage,source_bytes,indexed_bytes,extractor,changed_at)
      VALUES(?,?,?,?,?,'text','text/plain',?,?,?,1,'indexed','full',?,?,1,?)`)
      .bind(i + 1, id, version, title, filename, Buffer.byteLength(text), timestamp,
        new Date(timestamp).toISOString(), Buffer.byteLength(text), Buffer.byteLength(text), timestamp));
    statements.push(db.prepare('INSERT INTO document_text(doc,body) VALUES(?,?)').bind(i + 1, text));
    statements.push(db.prepare('INSERT INTO document_fts(rowid,title,filename,body) VALUES(?,?,?,?)').bind(i + 1, title, filename, text));
    if (statements.length >= 150) { await db.batch(statements); statements = []; }
  }
  if (statements.length) await db.batch(statements);
  await db.prepare("UPDATE index_meta SET value='1' WHERE key='generation'").run();
  return { documents: count, nativeSources: Math.min(48, count), cached: true };
}
