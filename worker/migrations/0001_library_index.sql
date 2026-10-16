-- Rebuildable derived data only. R2 owns identity/versions and original bytes.
-- No triggers: records.ts owns the guarded metadata/text/FTS/generation batch.
CREATE TABLE documents (
  doc INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE COLLATE BINARY,
  version TEXT NOT NULL,
  title TEXT NOT NULL,
  filename TEXT NOT NULL,
  kind TEXT NOT NULL,
  mime TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  uploaded_at INTEGER NOT NULL,
  uploaded_at_iso TEXT NOT NULL,
  time_source TEXT NOT NULL DEFAULT 'r2' CHECK (time_source = 'r2'),
  created_at TEXT,
  object_count INTEGER NOT NULL CHECK (object_count >= 0),
  warnings_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(warnings_json) AND json_type(warnings_json) = 'array'),
  state TEXT NOT NULL CHECK (state IN ('pending', 'indexed', 'failed', 'deleting')),
  coverage TEXT CHECK (coverage IN ('full', 'truncated', 'metadata-only', 'error')),
  reason TEXT,
  source_bytes INTEGER NOT NULL DEFAULT 0 CHECK (source_bytes >= 0),
  indexed_bytes INTEGER NOT NULL DEFAULT 0 CHECK (indexed_bytes BETWEEN 0 AND 524288),
  extractor INTEGER NOT NULL DEFAULT 0 CHECK (extractor >= 0),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  retry_at INTEGER,
  claim_token TEXT,
  claim_until INTEGER,
  changed_at INTEGER NOT NULL,
  CHECK ((claim_token IS NULL AND claim_until IS NULL) OR
         (claim_token IS NOT NULL AND length(claim_token) > 0 AND claim_until IS NOT NULL))
) STRICT;
CREATE INDEX documents_work ON documents(state, retry_at);
CREATE INDEX documents_uploaded ON documents(uploaded_at, id);

CREATE TABLE document_text (
  doc INTEGER PRIMARY KEY REFERENCES documents(doc) ON DELETE CASCADE,
  body TEXT NOT NULL CHECK (length(CAST(body AS BLOB)) <= 524288 AND instr(body, char(0)) = 0)
) STRICT;
CREATE VIRTUAL TABLE document_fts USING fts5(title, filename, body,
  content='', contentless_delete=1, tokenize='trigram case_sensitive 0', detail=full);

-- Permanent markers. at controls repair age; token alone identifies the delete owner.
-- A second delete must join/refuse an existing operation, never steal its token.
CREATE TABLE deleted_ids (
  id TEXT PRIMARY KEY COLLATE BINARY,
  state TEXT NOT NULL CHECK (state IN ('deleting', 'deleted')),
  token TEXT NOT NULL CHECK (length(token) > 0),
  restore_state TEXT CHECK (restore_state IN ('pending', 'indexed', 'failed')),
  restore_version TEXT,
  at INTEGER NOT NULL
) STRICT;
CREATE INDEX deleted_ids_repair ON deleted_ids(state, at);

-- generation/reconcile/size values are JSON or decimal strings, owned by this module.
-- The maintenance-lease row additionally uses token/expires_at for compare-and-swap.
CREATE TABLE index_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  token TEXT,
  expires_at INTEGER,
  CHECK ((token IS NULL AND expires_at IS NULL) OR
         (token IS NOT NULL AND length(token) > 0 AND expires_at IS NOT NULL))
) STRICT;
INSERT INTO index_meta(key, value) VALUES ('generation', '0');
