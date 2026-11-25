import type { CatalogPage, DocumentSummary, FileKind, UploadId } from "./contracts";

/** Server-only object identity. Never serialize keys into catalog JSON or accept them from clients. */
export interface ObjectRef {
  key: string;
  version: string;
  etag: string;
  sizeBytes: number;
  uploadedAt: string;
}
export interface ResolvedDocument {
  summary: DocumentSummary;
  objects: readonly ObjectRef[]; // Lexicographic order; first is the legacy primary object.
  /** Open the primary once; null means removed, a changed version throws. Caller consumes/cancels it. */
  openBody(options?: { range?: R2Range; maxBytes?: number }): Promise<R2ObjectBody | null>;
}
export interface RemoveResult {
  status: "deleted" | "not-found" | "changed";
  deletedObjectCount: number;
}
export interface DocumentInput {
  body: ReadableStream | null;
  filename: string;
  mime: string;
  title: string;
}
export type UpdateResult = { status: "updated"; document: DocumentSummary }
  | { status: "not-found" | "changed" };

/** Owns R2 key resolution and mutation. Native R2 is the external dependency, replaced only in tests.
 * Create streams must have a known length, as required by native R2 (pass the original Request.body).
 * Storage failures throw, absence stays null/not-found. Capture all keys before a delete; batches
 * never exceed 1,000. A page scans up to 200 keys, plus a bounded prefix scan to finish its final ID;
 * groups over 10,000 objects or 128 prefix pages fail explicitly rather than returning partial IDs.
 * Catalog signs the opaque continuation before exposing it. Pages observe a changing corpus, not
 * an atomic snapshot; even empty pages must be followed while nextCursor is non-null.
 * An updated ID has a permanent ID/ publication marker and immutable private revision bytes.
 * Updates and deletions conditionally replace that marker; deleting a captured payload can never
 * remove a concurrent replacement. A deletion marker is terminal, even if byte cleanup fails.
 * All deployed writers must understand this protocol; out-of-band/S3 writes remain unsupported.
 */
export interface Documents {
  create(input: DocumentInput): Promise<DocumentSummary>;
  update(id: UploadId, input: Omit<DocumentInput, "title"> & { title?: string }): Promise<UpdateResult>;
  page(cursor?: string): Promise<CatalogPage>;
  resolve(id: UploadId): Promise<ResolvedDocument | null>;
  remove(id: UploadId, expectedVersion?: string): Promise<RemoveResult>;
}

export function isUploadId(id: string): boolean {
  return /^[A-Za-z0-9]{8}$/.test(id);
}

const PAGE_SIZE = 200;
const MAX_DOCUMENT_OBJECTS = 10_000;
const MAX_PREFIX_PAGES = 128;
const METADATA: ("customMetadata" | "httpMetadata")[] = ["customMetadata", "httpMetadata"];
const reservationKey = (id: UploadId) => `__docs_internal/reservations/${id}`;
const absentOnly = () => ({ onlyIf: new Headers({ "If-None-Match": "*" }) });
const revisionKey = (id: UploadId, revision: string) => `__docs_internal/revisions/${id}/${revision}`;
type DocumentObject = Pick<R2Object, "key" | "version" | "etag" | "size" | "uploaded" | "customMetadata" | "httpMetadata">;

/** The marker is the publication boundary, never document content. Its body contains a fresh
 * nonce so even repeated deletes/identical bytes have distinct ETags for compare-and-swap.
 * Private staged bytes stay invisible until publication, including during a legacy ID's first update.
 */
type Publication = { kind: "legacy"; marker: R2Object | null; objects: DocumentObject[] }
  | { kind: "active"; marker: R2Object; revision: string; objects: [DocumentObject] }
  | { kind: "deleted"; marker: R2Object; revision: string | null };
type PublicationChange = { state: "active"; revision: string; object: DocumentObject }
  | { state: "deleted"; revision: string | null };

/** Only traversal state crosses requests, never client-supplied keys or buffered object metadata.
 * The trailing ID is resolved completely on the page that first observes it, then skipped on later
 * R2 pages. This keeps groups intact without unbounded pending objects inside a cursor or R2 state.
 */
interface DiscoveryCursor { version: 1; r2: string; lastId: string | null }

function readCursor(value: string): DiscoveryCursor {
  if (value.length > 16_384) throw new Error("Invalid document cursor");
  try {
    const parsed = JSON.parse(value) as DiscoveryCursor;
    if (parsed.version === 1 && typeof parsed.r2 === "string" && parsed.r2.length > 0
      && (parsed.lastId === null || (typeof parsed.lastId === "string" && isUploadId(parsed.lastId)))) return parsed;
  } catch { /* Invalid/foreign traversal state must fail before touching storage. */ }
  throw new Error("Invalid document cursor");
}

function continuation(listed: R2Objects, previous?: string): string | undefined {
  if (!listed.truncated) return undefined;
  if (!listed.cursor || listed.cursor === previous) throw new Error("Invalid R2 continuation");
  return listed.cursor;
}

export function createDocuments(bucket: R2Bucket, publicOrigin: string): Documents {
  // Keep cursor handling private so neither HTTP caller has to reason about shifting R2 listings.
  async function ownedObjects(id: UploadId, metadata: boolean): Promise<R2Object[]> {
    if (!isUploadId(id)) return [];
    const objects: R2Object[] = [];
    let cursor: string | undefined;
    const seen = new Set<string>();
    const keys = new Set<string>();
    let pages = 0;
    do {
      if (++pages > MAX_PREFIX_PAGES) throw new Error("Document exceeds prefix page limit");
      const listed = await bucket.list({
        prefix: `${id}/`, cursor,
        ...(metadata ? { include: METADATA } : {}),
      });
      for (const object of listed.objects) {
        if (!object.key.startsWith(`${id}/`) || keys.has(object.key)) throw new Error("Inconsistent R2 document listing");
        keys.add(object.key);
        objects.push(object);
        if (objects.length > MAX_DOCUMENT_OBJECTS) throw new Error("Document exceeds object limit");
      }
      cursor = continuation(listed, cursor);
      if (cursor && seen.has(cursor)) throw new Error("Invalid R2 continuation");
      if (cursor) seen.add(cursor);
    } while (cursor);
    return metadata ? objects.sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0) : objects;
  }

  async function reserveUpload(): Promise<{ id: UploadId; reservation: R2Object }> {
    for (let attempt = 0; attempt < 8; attempt++) {
      const id = generateId();
      // Probe before claiming so ordinary legacy collisions remain available for reviewed removal.
      // Recheck after acquisition: old deployments/out-of-band writers do not honor reservations.
      if ((await ownedObjects(id, false)).length) continue;
      const reservation = await bucket.put(reservationKey(id), "", {
        ...absentOnly(), customMetadata: { purpose: "upload" },
      });
      if (reservation && !(await ownedObjects(id, false)).length) return { id, reservation };
      // Never release a claim, even if the writer crashes or encounters a collision. Releasing it
      // could let another request republish this ID after a deletion or a delayed payload commit.
    }
    throw new Error("Could not reserve a unique upload ID");
  }

  function publication(id: UploadId, objects: R2Object[]): Publication {
    const marker = objects.find((object) => object.key === `${id}/`) ?? null;
    const state = marker?.customMetadata?.docsState;
    if (state === undefined) return { kind: "legacy", marker, objects };
    const revision = marker?.customMetadata?.docsRevision ?? "";
    if (marker && state === "deleted" && (!revision || /^[a-f0-9-]{36}$/.test(revision))) return { kind: "deleted", marker, revision: revision || null };
    if (!marker || state !== "active" || !/^[a-f0-9-]{36}$/.test(revision)) throw new Error("Invalid publication marker");
    // Publication copies the immutable payload's server-returned identity/metadata atomically.
    // Discovery can summarize 200 updated IDs without 200 extra R2 HEADs (one invocation has
    // a shared 40-operation budget). openBody still checks the actual payload version and ETag.
    const meta = marker.customMetadata ?? {};
    const size = Number(meta.docsPayloadSize);
    const uploaded = new Date(meta.docsPayloadUploadedAt);
    if (!meta.docsPayloadVersion || !meta.docsPayloadEtag || !/^\d+$/.test(meta.docsPayloadSize ?? "")
      || !Number.isSafeInteger(size) || !Number.isFinite(uploaded.getTime())) throw new Error("Invalid revision metadata");
    const object: DocumentObject = {
      key: revisionKey(id, revision), version: meta.docsPayloadVersion, etag: meta.docsPayloadEtag,
      size, uploaded, customMetadata: meta,
    };
    return { kind: "active", marker, revision, objects: [object] };
  }

  function publish(id: UploadId, previous: R2Object | null, change: PublicationChange) {
    const { state, revision } = change;
    return bucket.put(`${id}/`, JSON.stringify({ state, revision, nonce: crypto.randomUUID() }), {
      ...(previous ? { onlyIf: { etagMatches: previous.etag } } : absentOnly()),
      customMetadata: {
        ...(change.state === "active" ? {
          ...change.object.customMetadata,
          docsPayloadVersion: change.object.version, docsPayloadEtag: change.object.etag,
          docsPayloadSize: String(change.object.size), docsPayloadUploadedAt: change.object.uploaded.toISOString(),
        } : {}),
        docsState: state, ...(revision ? { docsRevision: revision } : {}),
      },
    });
  }

  async function deleteObjects(keys: string[]): Promise<void> {
    for (let offset = 0; offset < keys.length; offset += 1000) await bucket.delete(keys.slice(offset, offset + 1000));
  }

  async function discard(keys: string[]): Promise<void> {
    // Publication already decided the result. Cleanup failure must not report an update as
    // failed after its new bytes became public; retained obsolete bytes have no public route.
    try { await deleteObjects(keys); } catch { /* Best-effort reclamation of immutable objects. */ }
  }

  return {
    async create(input) {
      const { id, reservation } = await reserveUpload();
      const filename = input.filename.replace(/[^\w.\-]/g, "_") || "file";
      const mime = input.mime || contentType(filename);
      const object = await bucket.put(`${id}/${filename}`, input.body, {
        ...absentOnly(),
        customMetadata: {
          filename, contentType: mime, docName: input.title, uploadedAt: new Date().toISOString(),
          docsReservation: reservation.version,
        },
      });
      // A conditional payload collision is not retried: native R2 may have consumed the stream.
      // Keep the claim and fail closed rather than buffer/replay owner document bytes.
      if (!object) throw new Error("Upload did not create an object");
      return summarize(id, [object], publicOrigin, { filename, contentType: mime, docName: input.title });
    },
    async update(id, input) {
      if (!isUploadId(id)) return { status: "not-found" };
      const owned = await ownedObjects(id, true);
      const current = publication(id, owned);
      if (current.kind === "deleted" || current.kind === "legacy" && !owned.some((object) => object.key !== `${id}/`)) return { status: "not-found" };
      const { title } = await summarize(id, current.objects, publicOrigin);
      const filename = input.filename.replace(/[^\w.\-]/g, "_") || "file";
      const metadata = { filename, contentType: input.mime || contentType(filename), docName: input.title ?? title };
      const revision = crypto.randomUUID();
      const key = revisionKey(id, revision);
      const object = await bucket.put(key, input.body, { ...absentOnly(), customMetadata: metadata });
      if (!object) throw new Error("Revision did not create an object");
      // Do not delete staged bytes on an ambiguous publish exception: an in-flight R2 write
      // can still commit. Only a definitive conditional refusal proves these bytes are unreferenced.
      if (!await publish(id, current.marker, { state: "active", revision, object: { ...object, customMetadata: metadata } })) {
        await discard([key]);
        return { status: "changed" };
      }
      await discard([...owned.filter((item) => item.key !== `${id}/`).map((item) => item.key),
        ...(current.kind === "active" ? [current.objects[0].key] : [])]);
      return { status: "updated", document: await summarize(id, [object], publicOrigin, metadata) };
    },
    async page(cursor) {
      const state = cursor === undefined ? null : readCursor(cursor);
      const observedAt = new Date().toISOString();
      const listed = await bucket.list({ cursor: state?.r2, limit: PAGE_SIZE, ...{ include: METADATA } });
      const next = continuation(listed, state?.r2);
      const groups = new Map<UploadId, R2Object[]>();
      for (const object of listed.objects) {
        // Private reservations/catalog state and unrelated bucket keys never become documents.
        const id = /^([A-Za-z0-9]{8})\//.exec(object.key)?.[1];
        if (!id || id === state?.lastId) continue;
        const group = groups.get(id) ?? [];
        group.push(object);
        groups.set(id, group);
      }
      const tail = [...groups.keys()].at(-1);
      if (next && tail) groups.set(tail, await ownedObjects(tail, true));
      const items: DocumentSummary[] = [];
      for (const [id, objects] of groups) {
        // Legacy ID/ markers count only beside files. Managed markers instead publish one
        // private revision, or hide the entire ID after deletion, including across page seams.
        const state = publication(id, objects);
        if (state.kind !== "deleted" && (state.kind === "active"
          || objects.some((object) => object.key.length > id.length + 1))) {
          items.push(await summarize(id, state.objects, publicOrigin));
        }
      }
      return {
        version: 1, items, scanComplete: !next, observedAt,
        nextCursor: next ? JSON.stringify({ version: 1, r2: next, lastId: tail ?? state?.lastId ?? null } satisfies DiscoveryCursor) : null,
      };
    },
    async resolve(id) {
      const owned = await ownedObjects(id, true);
      const state = publication(id, owned);
      if (state.kind === "deleted" || state.kind === "legacy" && !owned.some((object) => object.key !== `${id}/`)) return null;
      const objects = state.objects;
      const summary = await summarize(id, objects, publicOrigin);
      const primary = objects[0];
      let opened = false;
      return {
        summary,
        objects: objects.map((object) => ({
          key: object.key, version: object.version, etag: object.etag,
          sizeBytes: object.size, uploadedAt: object.uploaded.toISOString(),
        })),
        async openBody(options = {}) {
          if (opened) throw new Error("Document body has already been opened");
          if (options.maxBytes !== undefined && (!Number.isSafeInteger(options.maxBytes) || options.maxBytes <= 0)) {
            throw new Error("maxBytes must be a positive safe integer");
          }
          if (options.range && options.maxBytes !== undefined) throw new Error("Choose range or maxBytes");
          opened = true;
          const object = await bucket.get(primary.key, {
            onlyIf: { etagMatches: primary.etag },
            ...(options.range ? { range: options.range } : {}),
            ...(options.maxBytes !== undefined ? { range: { offset: 0, length: options.maxBytes } } : {}),
          });
          if (!object) return null;
          if (!("body" in object) || !object.body) throw new Error("Document changed before body read");
          if (object.version !== primary.version) {
            await object.body.cancel();
            throw new Error("Document changed before body read");
          }
          return object;
        },
      };
    },
    async remove(id, expectedVersion) {
      if (!isUploadId(id)) return { status: "not-found", deletedObjectCount: 0 };
      if (expectedVersion !== undefined && !/^[a-f0-9]{64}$/.test(expectedVersion)) return { status: "changed", deletedObjectCount: 0 };
      const reviewed = expectedVersion !== undefined;
      const owned = await ownedObjects(id, true);
      const state = publication(id, owned);
      if (state.kind === "deleted") {
        // Retrying an interrupted deletion finishes captured legacy-byte cleanup without ever
        // releasing the tombstone or making this ID publishable again.
        await deleteObjects([...owned.filter((object) => object.key !== `${id}/`).map((object) => object.key),
          ...(state.revision ? [revisionKey(id, state.revision)] : [])]);
        return { status: "not-found", deletedObjectCount: 0 };
      }
      const objects = state.objects;
      if (state.kind === "legacy" && !owned.some((object) => object.key !== `${id}/`)) return { status: "not-found", deletedObjectCount: 0 };
      if (reviewed) {
        if (await versionOf(objects) !== expectedVersion) return { status: "changed", deletedObjectCount: 0 };
      }
      if (reviewed && state.kind === "legacy") {
        // Claim legacy IDs before deletion so no managed creator can acquire their now-empty
        // prefix. A lost conditional claim is retriable but never authority to proceed this time.
        const claim = await bucket.head(reservationKey(id)) ?? await bucket.put(reservationKey(id), "", {
          ...absentOnly(), customMetadata: { purpose: "legacy" },
        });
        if (!claim) return { status: "changed", deletedObjectCount: 0 };
        const purpose = claim.customMetadata?.purpose;
        // A reserved-but-uncommitted creator may still publish after this request. Only its one
        // atomic payload carrying this claim's version proves publication finished. Legacy claims
        // exclude creators entirely; unknown/corrupt claims fail closed instead of guessing.
        if (purpose !== "legacy" && !(purpose === "upload" && objects.length === 1
          && objects[0].customMetadata?.docsReservation === claim.version)) {
          return { status: "changed", deletedObjectCount: 0 };
        }
        const current = await ownedObjects(id, true);
        if (!current.length) return { status: "not-found", deletedObjectCount: 0 };
        if (await versionOf(current) !== expectedVersion) return { status: "changed", deletedObjectCount: 0 };
      }
      // Tombstone first using the same conditional boundary as updates. The marker survives
      // cleanup forever; a paused updater can no longer republish after this delete succeeds.
      if (!await publish(id, state.marker, { state: "deleted", revision: state.kind === "active" ? state.revision : null })) {
        return { status: "changed", deletedObjectCount: 0 };
      }
      // Freeze every key before the first batch. Listing while deleting can shift cursor pages
      // and skip owned objects. Private claims live outside this prefix and survive every removal.
      await deleteObjects([...owned.filter((object) => object.key !== `${id}/`).map((object) => object.key),
        ...(state.kind === "active" ? [objects[0].key] : [])]);
      return { status: "deleted", deletedObjectCount: objects.length };
    },
  };
}

async function versionOf(objects: DocumentObject[]): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(objects.map((o) => [o.key, o.version]))));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function summarize(id: UploadId, objects: DocumentObject[], origin: string, suppliedMetadata?: Record<string, string>): Promise<DocumentSummary> {
  const primary = objects[0];
  const meta = suppliedMetadata ?? primary.customMetadata ?? {};
  const filename = meta.filename || primary.key.split("/").pop() || "file";
  const mime = meta.contentType || primary.httpMetadata?.contentType || contentType(filename);
  const version = await versionOf(objects);
  return {
    id, version, title: meta.docName || filename.replace(/\.[^.]+$/, "").replace(/[_-]/g, " "),
    filename, kind: fileKind(filename, mime), mime,
    sizeBytes: objects.reduce((total, object) => total + object.size, 0),
    // Client metadata's uploadedAt cannot make a recent grouped object eligible for age deletion.
    uploadedAt: new Date(objects.reduce((newest, object) => Math.max(newest, object.uploaded.getTime()), -Infinity)).toISOString(),
    timeSource: "r2", createdAt: null,
    publicUrl: `${origin}/${id}`, rawUrl: `${origin}/${id}/raw`, downloadUrl: `${origin}/${id}/download`,
    objectCount: objects.length,
    warnings: objects.length > 1 ? ["Multiple objects share this ID; deleting it removes every object."] : [],
  };
}

function contentType(filename: string): string {
  // Legacy objects may have no metadata. Infer conventional types for preview/search coverage;
  // this is a display hint, never a validation that the bytes are safe or the format is decodable.
  const ext = filename.split(".").pop()?.toLowerCase() || "";
  const types: Record<string, string> = {
    pdf: "application/pdf", html: "text/html", htm: "text/html", md: "text/markdown", markdown: "text/markdown",
    txt: "text/plain", log: "text/plain", json: "application/json", csv: "text/csv", tsv: "text/tab-separated-values",
    xml: "application/xml", yaml: "text/yaml", yml: "text/yaml", css: "text/css", js: "text/javascript", mjs: "text/javascript",
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", avif: "image/avif", svg: "image/svg+xml", ico: "image/x-icon",
    mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", flac: "audio/flac", m4a: "audio/mp4",
    mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime",
    zip: "application/zip", gz: "application/gzip", tar: "application/x-tar", "7z": "application/x-7z-compressed",
    doc: "application/msword", xls: "application/vnd.ms-excel", ppt: "application/vnd.ms-powerpoint",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    odt: "application/vnd.oasis.opendocument.text",
  };
  if (["c", "h", "cpp", "hpp", "go", "rs", "py", "rb", "java", "sh", "bash", "zsh", "ts", "tsx", "jsx", "sql", "toml", "ini", "conf"].includes(ext)) return "text/plain";
  return Object.hasOwn(types, ext) ? types[ext] : "application/octet-stream";
}

function fileKind(filename: string, mime: string): FileKind {
  mime = mime.split(";", 1)[0].trim().toLowerCase();
  const ext = filename.split(".").pop()?.toLowerCase() || "";
  if (["html", "htm"].includes(ext)) return "html";
  if (["md", "markdown"].includes(ext)) return "markdown";
  if (ext === "pdf") return "pdf";
  if (["json", "csv", "tsv", "xml", "yaml", "yml"].includes(ext)) return "data";
  if (["zip", "tar", "gz", "7z"].includes(ext)) return "archive";
  if (["doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt"].includes(ext)) return "office";
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("video/")) return "video";
  return mime.startsWith("text/") ? "text" : "binary";
}

function generateId(): UploadId {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let result = "";
  while (result.length < 8) {
    const bytes = crypto.getRandomValues(new Uint8Array(10));
    for (const byte of bytes) if (byte < 248 && result.length < 8) result += chars[byte % chars.length];
  }
  return result;
}
