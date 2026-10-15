/** Shared wire contracts: metadata crosses origins as inert JSON; storage keys never do. */
export type UploadId = string; // Runtime validation: exactly [A-Za-z0-9]{8}.
export type Coverage = "full" | "truncated" | "metadata-only" | "error";
export type FileKind = "html" | "markdown" | "text" | "data" | "pdf"
  | "image" | "audio" | "video" | "archive" | "office" | "binary";

export interface DocumentSummary {
  id: UploadId;
  version: string;
  title: string;
  filename: string;
  kind: FileKind;
  mime: string;
  sizeBytes: number;
  uploadedAt: string;
  timeSource: "r2";
  createdAt: string | null;
  publicUrl: string;
  rawUrl: string;
  downloadUrl: string;
  objectCount: number;
  warnings: string[];
}

export interface CatalogPage {
  version: 1;
  items: DocumentSummary[];
  nextCursor: string | null;
  scanComplete: boolean;
  observedAt: string;
}

export interface TextRecord {
  version: 1;
  id: UploadId;
  documentVersion: string;
  coverage: Coverage;
  reason: string | null;
  text: string;
  sourceBytes: number;
  indexedBytes: number;
  extractorVersion: 1;
}

export interface DocumentFilter {
  kinds: FileKind[];
  uploadedBefore: string | null; // Strict UTC < cutoff; freeze the cutoff before review.
  uploadedAfter: string | null;
}

export interface SelectionRef { id: UploadId; version: string }
export interface ReviewSelection { items: SelectionRef[]; cutoffAt: string | null }

export interface LoginRequest { password: string }
export interface SessionResponse { version: 1; csrfToken: string; expiresAt: string }
export const MAX_DELETE_BATCH_ITEMS = 100;

// The mediator chose UI-owned review and one bounded bulk route, without persistent review jobs.
// Every batch contains frozen ID/version refs; a server must never rerun an age/search predicate.
export interface DeleteBatchRequest {
  version: 1;
  items: SelectionRef[];
  confirmCount: number; // Exactly items.length, between 1 and MAX_DELETE_BATCH_ITEMS.
  confirmation: string; // Exactly `DELETE ${confirmCount} documents`, for this batch, not global review.
}
export interface DeleteProgress {
  version: 1;
  outcomes: { id: UploadId; status: "deleted" | "not-found" | "changed" | "failed" }[];
}
export interface CatalogError {
  version: 1;
  error: { code: string; message: string; retryable: boolean };
}

interface RoleEnvironment {
  DOCS_BUCKET: R2Bucket;
  PUBLIC_DOCS_ORIGIN: string;
  CATALOG_ORIGIN: string;
}
export interface PublicEnv extends RoleEnvironment {
  APP_ROLE: "public";
  AUTH_TOKEN: string;
}
export interface CatalogEnv extends RoleEnvironment {
  APP_ROLE: "catalog";
  ALL_DOCS_PASSWORD: string;
  CATALOG_SESSION_KEY: string;
}
export type Env = PublicEnv | CatalogEnv;
