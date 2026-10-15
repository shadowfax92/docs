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

/** Owns R2 key resolution and mutation. Native R2 is the external dependency, replaced only in tests.
 * Create streams must have a known length, as required by native R2 (pass the original Request.body).
 * Storage failures throw, absence stays null/not-found. Capture all keys before a delete; batches
 * never exceed 1,000. Discovery and reviewed/version-checked removal are unavailable in this slice.
 */
export interface Documents {
  create(input: { body: ReadableStream | null; filename: string; mime: string; title: string }): Promise<DocumentSummary>;
  page(cursor?: string): Promise<CatalogPage>;
  resolve(id: UploadId): Promise<ResolvedDocument | null>;
  remove(id: UploadId, expectedVersion?: string): Promise<RemoveResult>;
}

export function isUploadId(id: string): boolean {
  return /^[A-Za-z0-9]{8}$/.test(id);
}

export function createDocuments(bucket: R2Bucket, publicOrigin: string): Documents {
  // Keep cursor handling private so neither HTTP caller has to reason about shifting R2 listings.
  async function ownedObjects(id: UploadId, metadata: boolean): Promise<R2Object[]> {
    if (!isUploadId(id)) return [];
    const objects: R2Object[] = [];
    let cursor: string | undefined;
    const seen = new Set<string>();
    do {
      const listed = await bucket.list({
        prefix: `${id}/`, cursor,
        ...(metadata ? { include: ["customMetadata", "httpMetadata"] as ("customMetadata" | "httpMetadata")[] } : {}),
      });
      objects.push(...listed.objects);
      if (listed.truncated && (!listed.cursor || seen.has(listed.cursor))) {
        throw new Error("Invalid R2 continuation");
      }
      cursor = listed.truncated ? listed.cursor : undefined;
      if (cursor) seen.add(cursor);
    } while (cursor);
    return metadata ? objects.sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0) : objects;
  }

  return {
    async create(input) {
      const id = generateId();
      const filename = input.filename.replace(/[^\w.\-]/g, "_") || "file";
      const mime = input.mime || contentType(filename);
      const object = await bucket.put(`${id}/${filename}`, input.body, {
        customMetadata: { filename, contentType: mime, docName: input.title, uploadedAt: new Date().toISOString() },
      });
      if (!object) throw new Error("Upload did not create an object");
      return summarize(id, [object], publicOrigin, { filename, contentType: mime, docName: input.title });
    },
    async page() {
      // Returning an empty successful page would let future UI silently select an incomplete corpus.
      throw new Error("Catalog discovery is unavailable in this skeleton");
    },
    async resolve(id) {
      const objects = await ownedObjects(id, true);
      if (!objects.length) return null;
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
          if (!("body" in object)) throw new Error("Document changed before body read");
          if (object.version !== primary.version) {
            await object.body.cancel();
            throw new Error("Document changed before body read");
          }
          return object;
        },
      };
    },
    async remove(id, expectedVersion) {
      // R2 has no atomic compare-and-delete. Until immutable ID reservations land, accepting
      // expectedVersion would falsely promise reviewed deletion safety. Fail before touching R2.
      if (expectedVersion !== undefined) throw new Error("Version-checked deletion is unavailable in this skeleton");
      const objects = await ownedObjects(id, false);
      if (!objects.length) return { status: "not-found", deletedObjectCount: 0 };
      for (let offset = 0; offset < objects.length; offset += 1000) {
        await bucket.delete(objects.slice(offset, offset + 1000).map((object) => object.key));
      }
      return { status: "deleted", deletedObjectCount: objects.length };
    },
  };
}

async function summarize(id: UploadId, objects: R2Object[], origin: string, suppliedMetadata?: Record<string, string>): Promise<DocumentSummary> {
  const primary = objects[0];
  const meta = suppliedMetadata ?? primary.customMetadata ?? {};
  const filename = meta.filename || primary.key.split("/").pop() || "file";
  const mime = meta.contentType || primary.httpMetadata?.contentType || contentType(filename);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(objects.map((o) => [o.key, o.version]))));
  const version = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return {
    id, version, title: meta.docName || filename.replace(/\.[^.]+$/, "").replace(/[_-]/g, " "),
    filename, kind: fileKind(filename, mime), mime,
    sizeBytes: objects.reduce((total, object) => total + object.size, 0),
    uploadedAt: new Date(objects.reduce((newest, object) => Math.max(newest, object.uploaded.getTime()), 0)).toISOString(),
    timeSource: "r2", createdAt: null,
    publicUrl: `${origin}/${id}`, rawUrl: `${origin}/${id}/raw`, downloadUrl: `${origin}/${id}/download`,
    objectCount: objects.length,
    warnings: objects.length > 1 ? ["Multiple objects share this ID; deleting it removes every object."] : [],
  };
}

function contentType(filename: string): string {
  const types: Record<string, string> = { pdf: "application/pdf", html: "text/html", htm: "text/html", md: "text/markdown", markdown: "text/markdown" };
  return types[filename.split(".").pop()?.toLowerCase() || ""] || "application/octet-stream";
}

function fileKind(filename: string, mime: string): FileKind {
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
