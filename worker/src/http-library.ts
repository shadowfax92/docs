import type { DocumentFilter, SelectionRef } from "./contracts";
import { LIBRARY_LIMITS, type LibrarySearchRequest, type LibrarySnippetsRequest, type MaintainOptions } from "./library-contracts";
import { DEFAULT_LIBRARY_CONFIG, LibraryIndexError, type LibraryConfig } from "./library-index";
import type { SearchQuery } from "./search";

/** HTTP admission only: bound untrusted JSON/config before crossing LibraryIndex. SQL, matching,
 * generation and internal continuation validation remain owned by that deep module.
 */
export const HTTP_CURSOR_BYTES = 8192;
// Encode the opaque UTF-8 bytes before JSON, avoiding sixfold control-character escaping.
// The outer base64/HMAC envelope and metadata URL then fit Cloudflare's 16 KiB URL ceiling.
export const HTTP_CURSOR_ENCODED_BYTES = Math.ceil(HTTP_CURSOR_BYTES / 3) * 4;
export const HTTP_CURSOR_TOKEN_BYTES = Math.ceil((HTTP_CURSOR_ENCODED_BYTES + 1024) / 3) * 4 + 44;
export const HTTP_SEARCH_BYTES = HTTP_CURSOR_TOKEN_BYTES + 8192;
export const HTTP_LIBRARY_BODY_BYTES = 32 * 1024;

export function httpLibraryConfig(budget?: string): Readonly<LibraryConfig> {
  const value = typeof budget === "string" && /^\d+$/.test(budget) ? Number(budget) : NaN;
  // This rollout has no approved paid capacity. Deployment/request configuration may lower the
  // storage gate, never raise the conservative ceiling or change CPU/billing policy.
  return { ...DEFAULT_LIBRARY_CONFIG, sizeBudgetBytes: Number.isSafeInteger(value) && value >= 0
    ? Math.min(value, DEFAULT_LIBRARY_CONFIG.sizeBudgetBytes) : DEFAULT_LIBRARY_CONFIG.sizeBudgetBytes };
}

export function httpMaintenanceOptions(config: Readonly<LibraryConfig>): MaintainOptions {
  return { documents: Math.min(config.drainDocuments, 12), textBytes: Math.min(config.drainTextBytes, LIBRARY_LIMITS.drainBytes),
    listPages: Math.min(config.reconcilePages, 1), deadlineMs: Math.min(config.maintenanceMs, LIBRARY_LIMITS.maintenanceMs) };
}

const kinds = new Set(["html", "markdown", "text", "data", "pdf", "image", "audio", "video", "archive", "office", "binary"]);
const encoder = new TextEncoder();
export function httpSearchRequest(value: unknown): LibrarySearchRequest {
  if (!record(value) || !fields(value, ["version", "query", "filter", "cursor"]) || value.version !== 1
    || !validQuery(value.query) || !validFilter(value.filter)
    || (value.cursor !== undefined && (typeof value.cursor !== "string" || !value.cursor || value.cursor.length > HTTP_CURSOR_TOKEN_BYTES))) {
    return invalid("invalid_search_request");
  }
  return value as unknown as LibrarySearchRequest;
}
export function httpSnippetsRequest(value: unknown): LibrarySnippetsRequest {
  if (!record(value) || !fields(value, ["version", "generation", "query", "refs"]) || value.version !== 1
    || !Number.isSafeInteger(value.generation) || (value.generation as number) < 0 || !validQuery(value.query)) return invalid();
  httpRefs(value.refs);
  return value as unknown as LibrarySnippetsRequest;
}
export function httpRetryRequest(value: unknown): SelectionRef[] {
  if (!record(value) || !fields(value, ["version", "refs"]) || value.version !== 1) return invalid();
  return httpRetryRefs(value.refs);
}
export function httpMaintainRequest(value: unknown, config: Readonly<LibraryConfig>): MaintainOptions {
  if (!record(value) || !fields(value, ["version", "options"]) || value.version !== 1 || !record(value.options)
    || !fields(value.options, ["documents", "textBytes", "listPages", "deadlineMs", "reconcile", "retry"])) return invalid();
  const options = value.options;
  const caps = httpMaintenanceOptions(config);
  for (const field of ["documents", "textBytes", "listPages", "deadlineMs"] as const) {
    if (!Number.isSafeInteger(options[field]) || (options[field] as number) < 0) return invalid();
    caps[field] = Math.min(caps[field], options[field] as number);
  }
  if (options.reconcile !== undefined) {
    if (typeof options.reconcile !== "boolean") return invalid();
    caps.reconcile = options.reconcile;
  }
  if (options.retry !== undefined) caps.retry = httpRetryRefs(options.retry);
  return caps;
}
function httpRefs(value: unknown): SelectionRef[] {
  if (!Array.isArray(value) || value.length > LIBRARY_LIMITS.snippetRefs) return invalid();
  const seen = new Set<string>();
  for (const ref of value) {
    // IDs, not ID/version pairs, are unique: a request cannot ask for conflicting versions.
    if (!record(ref) || !fields(ref, ["id", "version"]) || typeof ref.id !== "string" || !/^[A-Za-z0-9]{8}$/.test(ref.id)
      || typeof ref.version !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(ref.version) || seen.has(ref.id)) return invalid();
    seen.add(ref.id);
  }
  return value as SelectionRef[];
}
function httpRetryRefs(value: unknown): SelectionRef[] {
  const refs = httpRefs(value);
  // Retry mutates stored failed versions; maintenance accepts only authoritative R2 digests.
  // Snippet lookup may report unavailable for an opaque older ref. Legacy deletion admission
  // stays with its existing contract; none of these checks resolve R2 or touch the database.
  if (refs.some((ref) => !/^[a-f0-9]{64}$/.test(ref.version))) return invalid();
  return refs;
}
function validQuery(value: unknown): value is SearchQuery {
  return record(value) && fields(value, ["text", "mode", "ignoreCase"]) && typeof value.text === "string"
    && encoder.encode(value.text).length <= LIBRARY_LIMITS.queryBytes
    && (value.mode === "literal" || value.mode === "regex") && typeof value.ignoreCase === "boolean";
}
function validFilter(value: unknown): value is DocumentFilter {
  return record(value) && fields(value, ["kinds", "uploadedBefore", "uploadedAfter"]) && Array.isArray(value.kinds)
    && value.kinds.length <= kinds.size && value.kinds.every((kind) => typeof kind === "string" && kinds.has(kind))
    && new Set(value.kinds).size === value.kinds.length && cutoff(value.uploadedBefore) && cutoff(value.uploadedAfter);
}
function cutoff(value: unknown): boolean {
  return value === null || typeof value === "string" && value.length <= 64 && Number.isFinite(Date.parse(value));
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}
function fields(value: Record<string, unknown>, allowed: string[]): boolean { return Object.keys(value).every((key) => allowed.includes(key)); }
function invalid(code: "invalid_library_request" | "invalid_search_request" = "invalid_library_request"): never {
  throw new LibraryIndexError(code, "Invalid library request.", false);
}

/** JSON.parse accepts repeated object keys and prototype-shaped keys. Reject both on the bounded
 * original JSON before using its parsed values; otherwise ambiguous security fields become last-wins.
 * This pass only tokenizes already-valid JSON, so it needs no separate JSON grammar implementation.
 */
export function httpJson(text: string): unknown {
  const value: unknown = JSON.parse(text);
  const stack: ({ keys: Set<string>; key: boolean } | null)[] = [];
  const tokens = /"(?:\\[\s\S]|[^"\\])*"|[{}\[\],:]|[^\s{}\[\],:]+/g;
  for (const [token] of text.matchAll(tokens)) {
    if (token === "{") stack.push({ keys: new Set(), key: true });
    else if (token === "[") stack.push(null);
    else if (token === "}" || token === "]") stack.pop();
    else {
      const object = stack.at(-1);
      if (!object) continue;
      if (token === ":") object.key = false;
      else if (token === ",") object.key = true;
      else if (object.key && token.startsWith('"')) {
        const key = JSON.parse(token) as string;
        if (object.keys.has(key) || ["__proto__", "prototype", "constructor"].includes(key)) throw new Error("Ambiguous JSON object");
        object.keys.add(key);
      }
    }
  }
  return value;
}
