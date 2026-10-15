import type { Env, PublicEnv } from "./contracts";
import { createCatalog } from "./catalog";
import { createDocuments, isUploadId, type Documents } from "./documents";
import { extractText } from "./extract";
import { renderDocument } from "./preview";
import { catalogAssets } from "./ui";

/** Deployment role is selected before routing: a catalog request can never fall through to active
 * uploaded HTML. Only the public adapter sees the bearer credential; only Catalog receives secrets.
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (!validOrigins(env) || (env.APP_ROLE !== "public" && env.APP_ROLE !== "catalog")) {
      return unavailable();
    }
    const url = new URL(request.url);
    const expectedOrigin = env.APP_ROLE === "catalog" ? env.CATALOG_ORIGIN : env.PUBLIC_DOCS_ORIGIN;
    if (url.origin !== expectedOrigin) return unavailable();
    const documents = createDocuments(env.DOCS_BUCKET, env.PUBLIC_DOCS_ORIGIN);
    if (env.APP_ROLE === "catalog") {
      return createCatalog({
        documents, bucket: env.DOCS_BUCKET,
        security: {
          catalogOrigin: env.CATALOG_ORIGIN, publicOrigin: env.PUBLIC_DOCS_ORIGIN,
          password: env.ALL_DOCS_PASSWORD, sessionKey: env.CATALOG_SESSION_KEY,
        },
        extract: extractText, assets: catalogAssets,
      }).fetch(request);
    }
    return publicFetch(request, env, documents);
  },
} satisfies ExportedHandler<Env>;

async function publicFetch(request: Request, env: PublicEnv, documents: Documents): Promise<Response> {
  const path = new URL(request.url).pathname.slice(1);
  if (request.method === "GET" && (path === "all-docs" || path === "all-docs/")) {
    return new Response(null, {
      status: 302,
      headers: {
        Location: `${env.CATALOG_ORIGIN}/all-docs`,
        "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow, noarchive",
      },
    });
  }
  const upload = request.method === "PUT" && path === "upload";
  const deletion = request.method === "DELETE" && path.startsWith("upload/");
  if (upload || deletion) {
    const id = path.slice("upload/".length);
    if (deletion && !isUploadId(id)) return new Response("Not found", { status: 404 });
    if (!(await isAuthorized(request, env.AUTH_TOKEN))) return new Response("Unauthorized", { status: 401 });
    try {
      if (upload) {
        const doc = await documents.create({
          body: request.body, filename: request.headers.get("X-Filename") || "file",
          mime: request.headers.get("Content-Type") || "", title: request.headers.get("X-Doc-Name") || "",
        });
        return Response.json({ url: doc.publicUrl, id: doc.id });
      }
      const result = await documents.remove(id);
      return new Response(result.status === "not-found" ? "Not found" : null, {
        status: result.status === "not-found" ? 404 : 204,
        headers: { "X-Docs-Delete-Result": result.status === "not-found" ? "not-found" : "deleted" },
      });
    } catch {
      // The CLI only discards history on marked absence/success; storage errors must be unmarked.
      return new Response("Storage error", { status: 500 });
    }
  }
  if (request.method === "GET" && !path) return new Response("docs — document sharing");
  if (request.method !== "GET" || !path) return new Response("Not found", { status: 404 });
  const [id, variant, ...rest] = path.split("/");
  if (!isUploadId(id) || rest.length || (variant && variant !== "raw" && variant !== "download")) {
    return new Response("Not found", { status: 404 });
  }
  try {
    const document = await documents.resolve(id);
    return document
      ? await renderDocument(document, variant === "raw" || variant === "download" ? variant : "page", request)
      : new Response("Not found", { status: 404 });
  } catch {
    return new Response("Storage error", { status: 500 });
  }
}

// Upload and legacy bearer deletion share one authorization implementation. Digesting equal-length
// bytes also avoids the old space-padding comparison treating a trailing-space token as equivalent.
async function isAuthorized(request: Request, token: string): Promise<boolean> {
  const auth = request.headers.get("Authorization");
  if (!token || !auth) return false;
  const digest = async (value: string) => new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  const [actual, expected] = await Promise.all([digest(auth), digest(`Bearer ${token}`)]);
  let difference = 0;
  for (let index = 0; index < actual.length; index++) difference |= actual[index] ^ expected[index];
  return difference === 0;
}

function validOrigins(env: Env): boolean {
  try {
    return new URL(env.PUBLIC_DOCS_ORIGIN).origin === env.PUBLIC_DOCS_ORIGIN
      && new URL(env.CATALOG_ORIGIN).origin === env.CATALOG_ORIGIN
      && env.PUBLIC_DOCS_ORIGIN !== env.CATALOG_ORIGIN;
  } catch { return false; }
}

function unavailable(): Response {
  return new Response("Worker role or origin is not configured", {
    status: 503,
    headers: { "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow, noarchive" },
  });
}
