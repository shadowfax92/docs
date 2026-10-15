import { MAX_DELETE_BATCH_ITEMS, type CatalogError, type DeleteBatchRequest, type DeleteProgress, type SessionResponse, type TextRecord } from "./contracts";
import { isUploadId, type Documents, type ResolvedDocument } from "./documents";

export interface CatalogSecurity {
  catalogOrigin: string;
  publicOrigin: string;
  password: string;
  sessionKey: string;
}

const COOKIE = "__Host-docs_catalog";
const SESSION_SECONDS = 12 * 60 * 60;
const LOGIN_BYTES = 2048;
const DELETE_BYTES = 32 * 1024;
const CURSOR_BYTES = 8192;
const THROTTLE_WINDOW = 10 * 60;
// This cannot overlap an upload ID. Documents discovery must suppress internal keys, and public
// routes cannot resolve this prefix. Counters contain only keyed IP digests, never credentials.
const INTERNAL_PREFIX = "__docs_internal/catalog/v1/throttle/";
const ASSETS = new Set(["/all-docs", "/all-docs/assets/app.js", "/all-docs/assets/styles.css", "/all-docs/assets/search-worker.js"]);
const encoder = new TextEncoder();

/** Signed session state is intentionally stateless: logout clears this browser's cookie, while
 * rotating password/key revokes copied cookies too. Session and cursor MACs use separate domains.
 */
interface Session { v: 1; sid: string; iat: number; exp: number; csrf: string }
interface Cursor { v: 1; sid: string; exp: number; cursor: string }

class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly retryable = false) { super(message); }
}

/** Deep HTTP module: callers supply Documents/extraction/assets, never auth helpers or R2 keys.
 * R2 is external; the other dependencies are in-process. The fetch seam hides credential/session
 * lifecycle, cursor ownership and bounded mutation ordering. Authentication precedes document I/O;
 * each confirmed ID has its own outcome, so one storage failure cannot erase earlier successes.
 */
export function createCatalog(deps: {
  documents: Documents;
  bucket: R2Bucket;
  security: CatalogSecurity;
  extract: (doc: ResolvedDocument) => Promise<TextRecord>;
  assets: (path: string) => Response | null;
}): { fetch(request: Request): Promise<Response> } {
  const { security } = deps;
  // Card previews frame the configured public origin only (sandboxed, inert; see ui/card-preview.ts).
  // A misconfigured deployment gets no frame-src at all, so default-src 'none' blocks every frame.
  const frameSource = configured(security) ? security.publicOrigin : null;
  let signingKey: Promise<CryptoKey> | undefined;
  function key() {
    // Lazy initialization keeps bad/missing deployment config on the private 503 path. Including
    // the password and literal host makes rotation and deployment-alias changes invalidate tokens.
    return signingKey ??= (async () => {
      const root = await importKey(encoder.encode(security.sessionKey));
      const material = await crypto.subtle.sign("HMAC", root,
        encoder.encode(JSON.stringify(["docs-catalog-key-v1", security.catalogOrigin, security.password])));
      return importKey(material);
    })();
  }
  async function mac(domain: string, value: string) {
    return crypto.subtle.sign("HMAC", await key(), encoder.encode(`${domain}\n${value}`));
  }
  async function equal(domain: string, expected: string, actual: string) {
    // Native HMAC verification compares fixed-size MACs in constant time; no JS early-exit byte
    // loop or length-padding comparison can turn a password with extra spaces into a match.
    return crypto.subtle.verify("HMAC", await key(), await mac(domain, expected), encoder.encode(`${domain}\n${actual}`));
  }
  async function sign(domain: string, value: unknown) {
    const payload = base64(encoder.encode(JSON.stringify(value)));
    return `${payload}.${base64(new Uint8Array(await mac(domain, payload)))}`;
  }
  async function verify(domain: string, token: string, maxLength: number): Promise<unknown> {
    if (!token || token.length > maxLength) return null;
    const parts = token.split(".");
    if (parts.length !== 2 || !/^[A-Za-z0-9_-]+$/.test(parts[0]) || !/^[A-Za-z0-9_-]{43}$/.test(parts[1])) return null;
    try {
      if (!await crypto.subtle.verify("HMAC", await key(), unbase64(parts[1]), encoder.encode(`${domain}\n${parts[0]}`))) return null;
      return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(unbase64(parts[0])));
    } catch { return null; }
  }
  async function authenticate(request: Request): Promise<Session> {
    const cookie = request.headers.get("Cookie") || "";
    if (cookie.length > 8192) throw unauthorized();
    const values = cookie.split(";").map((part) => part.trim()).filter((part) => part.startsWith(`${COOKIE}=`));
    const state = values.length === 1 ? await verify("session-v1", values[0].slice(COOKIE.length + 1), 2048) : null;
    if (!isRecord(state) || state.v !== 1 || !randomToken(state.sid) || !randomToken(state.csrf)
      || !Number.isSafeInteger(state.iat) || !Number.isSafeInteger(state.exp)
      || (state.iat as number) > now() || (state.exp as number) <= now()
      || (state.exp as number) - (state.iat as number) !== SESSION_SECONDS) throw unauthorized();
    return state as unknown as Session;
  }
  async function mutate(request: Request, session: Session) {
    checkBrowser(request, true);
    const csrf = request.headers.get("X-CSRF-Token") || "";
    if (!randomToken(csrf) || !await equal("csrf-v1", session.csrf, csrf)) {
      throw new HttpError(403, "csrf_invalid", "Refresh the library before trying again.");
    }
  }

  /** Every login attempt reserves budget before password evaluation, including successful attempts.
   * Conditional R2 writes coordinate across createCatalog instances and isolates, with bounded CAS
   * retries (no process-local Map pretending to be global). A nonce avoids identical-body ETag ABA.
   * R2 contention/write-rate failures fail closed; this is a fixed-window counter, not edge DDoS
   * protection. The global budget also limits IP-key growth to 100 per window. Old keys require an
   * integrator-owned prefix lifecycle policy; this module never deletes owner data for housekeeping.
   */
  async function throttle(request: Request) {
    const window = Math.floor(now() / THROTTLE_WINDOW);
    const scope = base64(new Uint8Array(await mac("throttle-scope-v1", security.catalogOrigin)));
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    if (ip.length > 64) throw new HttpError(400, "invalid_client", "Invalid client address.");
    const ipHash = base64(new Uint8Array(await mac("throttle-ip-v1", ip)));
    for (const [name, limit] of [["global", 100], [ipHash, 10]] as const) {
      const path = `${INTERNAL_PREFIX}${scope}/${window}/${name}`;
      let reserved = false;
      for (let attempt = 0; attempt < 3; attempt++) {
        const object = await deps.bucket.get(path);
        let count = 0;
        if (object) {
          if (!("body" in object)) throw new Error("Invalid throttle state");
          if (object.size > 1024) { await object.body.cancel(); throw new Error("Invalid throttle state"); }
          const state: unknown = JSON.parse(await boundedText(object.body, 1024));
          if (!isRecord(state) || !Number.isSafeInteger(state.count) || (state.count as number) < 0 || (state.count as number) > limit) throw new Error("Invalid throttle state");
          count = state.count as number;
        }
        if (count >= limit) throw throttled();
        const result = await deps.bucket.put(path, JSON.stringify({ count: count + 1, nonce: random() }), {
          onlyIf: object ? { etagMatches: object.etag } : { etagDoesNotMatch: "*" },
          httpMetadata: { contentType: "application/json" },
        });
        if (result) { reserved = true; break; }
      }
      if (!reserved) throw throttled();
    }
  }

  async function route(request: Request): Promise<Response> {
    if (!configured(security) || new URL(request.url).origin !== security.catalogOrigin) {
      throw new HttpError(503, "catalog_unavailable", "The private library is not configured.");
    }
    if (request.url.length > 24 * 1024) throw new HttpError(414, "url_too_long", "The request URL is too long.");
    const url = new URL(request.url);
    const path = url.pathname;
    if (request.method === "GET" && ASSETS.has(path)) {
      queryKeys(url, []);
      const response = deps.assets(path);
      if (!response) throw new HttpError(503, "assets_unavailable", "The library assets are unavailable.", true);
      return response;
    }
    if (path === "/all-docs/session" && request.method === "POST") {
      queryKeys(url, []);
      checkBrowser(request, true);
      const body = await jsonBody(request, LOGIN_BYTES);
      if (!isRecord(body) || typeof body.password !== "string" || !body.password || encoder.encode(body.password).length > 1024) {
        throw new HttpError(400, "invalid_login", "Supply a password of at most 1024 bytes.");
      }
      await throttle(request);
      if (!await equal("password-v1", security.password, body.password)) throw unauthorized();
      const issuedAt = now();
      const session: Session = { v: 1, sid: random(), csrf: random(), iat: issuedAt, exp: issuedAt + SESSION_SECONDS };
      const response = Response.json(sessionResponse(session));
      response.headers.set("Set-Cookie", `${COOKIE}=${await sign("session-v1", session)}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${SESSION_SECONDS}`);
      return response;
    }
    const sessionRoute = path === "/all-docs/session" && (request.method === "GET" || request.method === "DELETE");
    const listRoute = path === "/all-docs/api/documents" && request.method === "GET";
    const textRoute = /^\/all-docs\/api\/documents\/([^/]+)\/text$/.exec(path);
    const textRead = request.method === "GET" && textRoute;
    const deleteRoute = path === "/all-docs/api/delete" && request.method === "POST";
    if (!sessionRoute && !listRoute && !textRead && !deleteRoute) throw new HttpError(404, "not_found", "Not found.");

    // Neither invalid browser headers nor bad routes probe Documents. Session authentication is
    // first on every document route, so absence, versions and storage failures stay private.
    const session = await authenticate(request);
    checkBrowser(request, false);
    if (sessionRoute) {
      queryKeys(url, []);
      if (request.method === "GET") return Response.json(sessionResponse(session));
      await mutate(request, session);
      return new Response(null, { status: 204, headers: { "Set-Cookie": `${COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT` } });
    }
    if (listRoute) {
      queryKeys(url, ["cursor"]);
      let cursor: string | undefined;
      if (url.searchParams.has("cursor")) {
        const state = await verify("cursor-v1", url.searchParams.get("cursor")!, 16 * 1024);
        if (!isRecord(state) || state.v !== 1 || state.sid !== session.sid
          || !Number.isSafeInteger(state.exp) || (state.exp as number) <= now() || (state.exp as number) > session.exp
          || typeof state.cursor !== "string" || !state.cursor || encoder.encode(state.cursor).length > CURSOR_BYTES) {
          throw new HttpError(400, "invalid_cursor", "Refresh the library to restart discovery.");
        }
        cursor = state.cursor;
      }
      const page = await deps.documents.page(cursor);
      if (page.nextCursor !== null && (!page.nextCursor || encoder.encode(page.nextCursor).length > CURSOR_BYTES)) throw new Error("Invalid document continuation");
      const nextCursor = page.nextCursor === null ? null : await sign("cursor-v1", {
        v: 1, sid: session.sid, exp: Math.min(session.exp, now() + 30 * 60), cursor: page.nextCursor,
      } satisfies Cursor);
      return Response.json({ ...page, nextCursor });
    }
    if (textRead) {
      queryKeys(url, ["version"]);
      const id = textRead[1];
      const version = url.searchParams.get("version");
      if (!isUploadId(id) || !validVersion(version)) throw new HttpError(400, "invalid_document", "Supply a valid document ID and version.");
      const document = await deps.documents.resolve(id);
      if (!document) throw new HttpError(404, "not_found", "Document not found.");
      if (document.summary.version !== version) throw new HttpError(409, "document_changed", "Refresh the changed document.");
      const text = await deps.extract(document);
      if (text.id !== id || text.documentVersion !== version) throw new HttpError(409, "document_changed", "Refresh the changed document.");
      return Response.json(text);
    }
    queryKeys(url, []);
    await mutate(request, session);
    const batch = deleteBatch(await jsonBody(request, DELETE_BYTES));
    const outcomes: DeleteProgress["outcomes"] = [];
    // Sequential execution bounds storage pressure and preserves the reviewed order. remove owns
    // immutable-ID/version checks; never rescan a filter or widen the set after confirmation.
    for (const item of batch.items) {
      try {
        const result = await deps.documents.remove(item.id, item.version);
        outcomes.push({ id: item.id, status: result.status });
      } catch { outcomes.push({ id: item.id, status: "failed" }); }
    }
    return Response.json({ version: 1, outcomes } satisfies DeleteProgress);
  }
  return {
    async fetch(request) {
      try { return privatize(await route(request), frameSource); }
      catch (error) {
        const failure = error instanceof HttpError ? error : new HttpError(503, "catalog_failure", "The library operation could not complete.", true);
        return privatize(Response.json({ version: 1, error: {
          code: failure.code, message: failure.message, retryable: failure.retryable,
        } } satisfies CatalogError, {
          status: failure.status,
          ...(failure.status === 429 ? { headers: { "Retry-After": String(THROTTLE_WINDOW - now() % THROTTLE_WINDOW) } } : {}),
        }), frameSource);
      }
    },
  };
}

function checkBrowser(request: Request, mutation: boolean) {
  const origin = request.headers.get("Origin");
  const expected = new URL(request.url).origin;
  const site = request.headers.get("Sec-Fetch-Site");
  // Fetch Metadata is additional evidence, never authentication. Reads with no Origin must be
  // explicit same-origin fetches; same-site sibling uploads are rejected even with a valid cookie.
  if ((origin !== null && origin !== expected) || (site !== null && site !== "same-origin")
    || (mutation ? origin !== expected : origin === null && site !== "same-origin")
    || request.headers.get("X-Docs-Catalog") !== "1") {
    throw new HttpError(403, "origin_forbidden", "Use the private library on its configured origin.");
  }
}
function configured(security: CatalogSecurity) {
  try {
    const validOrigin = (value: string) => { const url = new URL(value); return url.origin === value && (url.protocol === "https:" || url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)); };
    return validOrigin(security.catalogOrigin) && validOrigin(security.publicOrigin) && security.catalogOrigin !== security.publicOrigin
      && typeof security.password === "string" && security.password.length > 0 && security.password.length <= 1024 && encoder.encode(security.password).length <= 1024
      && typeof security.sessionKey === "string" && security.sessionKey.length <= 1024 && encoder.encode(security.sessionKey).length >= 32 && encoder.encode(security.sessionKey).length <= 1024;
  } catch { return false; }
}
function queryKeys(url: URL, allowed: string[]) {
  for (const key of url.searchParams.keys()) if (!allowed.includes(key) || url.searchParams.getAll(key).length !== 1) {
    throw new HttpError(400, "invalid_query", "Unexpected or repeated query parameter.");
  }
}
function deleteBatch(value: unknown): DeleteBatchRequest {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.items)
    || !value.items.length || value.items.length > MAX_DELETE_BATCH_ITEMS
    || value.confirmCount !== value.items.length || value.confirmation !== `DELETE ${value.items.length} documents`) {
    throw new HttpError(400, "invalid_confirmation", "Confirm the exact batch of 1–100 documents.");
  }
  const seen = new Set<string>();
  for (const item of value.items) {
    if (!isRecord(item) || typeof item.id !== "string" || !isUploadId(item.id) || !validVersion(item.version) || seen.has(item.id)) {
      throw new HttpError(400, "invalid_selection", "Each document ID must appear once with its reviewed version.");
    }
    seen.add(item.id);
  }
  return value as unknown as DeleteBatchRequest;
}
function validVersion(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9_-]{1,256}$/.test(value); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function randomToken(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value); }
function now() { return Math.floor(Date.now() / 1000); }
function random() { return base64(crypto.getRandomValues(new Uint8Array(32))); }
function base64(bytes: Uint8Array) { return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
function unbase64(value: string) { return Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - value.length % 4) % 4)), (char) => char.charCodeAt(0)); }
function importKey(value: ArrayBuffer | Uint8Array) { return crypto.subtle.importKey("raw", value, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]); }
function sessionResponse(session: Session): SessionResponse { return { version: 1, csrfToken: session.csrf, expiresAt: new Date(session.exp * 1000).toISOString() }; }
function unauthorized() { return new HttpError(401, "unauthorized", "Sign in to the private library."); }
function throttled() { return new HttpError(429, "login_throttled", "Too many sign-in attempts. Try again later.", true); }

async function jsonBody(request: Request, maxBytes: number): Promise<unknown> {
  if (request.headers.get("Content-Type")?.split(";")[0].trim().toLowerCase() !== "application/json") throw new HttpError(415, "json_required", "Use application/json.");
  const length = request.headers.get("Content-Length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > maxBytes)) {
    void request.body?.cancel().catch(() => {});
    throw new HttpError(413, "body_too_large", "The request body is too large.");
  }
  const body = await boundedText(request.body, maxBytes);
  try { return JSON.parse(body); } catch { throw new HttpError(400, "invalid_json", "Supply a valid JSON request."); }
}

/** Count streamed bytes, not a client-supplied Content-Length. Cancel on overflow, timeout, invalid
 * UTF-8 or reader failure so credential streams and R2 bodies never linger after an early return.
 */
async function boundedText(body: ReadableStream<Uint8Array> | null, maxBytes: number): Promise<string> {
  if (!body) throw new HttpError(400, "invalid_body", "A request body is required.");
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
  let size = 0;
  let text = "";
  let complete = false;
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; void reader.cancel().catch(() => {}); }, 10_000);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (timedOut) throw new HttpError(408, "body_timeout", "The request body took too long.", true);
      if (done) { complete = true; return text + decoder.decode(); }
      size += value.byteLength;
      if (size > maxBytes) throw new HttpError(413, "body_too_large", "The request body is too large.");
      text += decoder.decode(value, { stream: true });
    }
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "invalid_body", "The request body could not be read.");
  } finally {
    clearTimeout(timer);
    if (!complete) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
/** `frameSource` is a validated literal origin (URL-serialized, so it cannot add a directive). It is
 * the only frame the catalog may embed; scripts, connections and framing of the catalog itself
 * stay as strict as without it. */
function privatize(response: Response, frameSource: string | null): Response {
  const headers = new Headers(response.headers);
  for (const key of [...headers.keys()]) if (key.toLowerCase().startsWith("access-control-")) headers.delete(key);
  headers.set("Cache-Control", "no-store");
  headers.set("X-Robots-Tag", "noindex, nofollow, noarchive");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Cross-Origin-Opener-Policy", "same-origin");
  headers.set("Cross-Origin-Resource-Policy", "same-origin");
  headers.set("Origin-Agent-Cluster", "?1");
  headers.set("Content-Security-Policy", `default-src 'none'; script-src 'self'; style-src 'self'; worker-src 'self'; connect-src 'self'; img-src 'self'; font-src 'self'; ${frameSource ? `frame-src ${frameSource}; ` : ""}object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
