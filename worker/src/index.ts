import type { Env, PublicEnv } from "./contracts";
import { createCatalog } from "./catalog";
import { createDocuments, isUploadId, type Documents } from "./documents";
import { extractText } from "./extract";
import { renderDocument } from "./preview";
import { catalogAssets } from "./ui";
import { createLibraryIndex, type LibraryDependencies } from "./library-index";
import { createInvocationResources } from "./invocation-budget";
import { httpLibraryConfig, httpMaintenanceOptions } from "./http-library";

/** Deployment role is selected before routing: a catalog request can never fall through to active
 * uploaded HTML. Only the public adapter sees the bearer credential; only Catalog receives secrets.
 */
export function createWorker(libraryFactory = createLibraryIndex) {
  function invocation(env: Env, context: Pick<ExecutionContext, "waitUntil">) {
    // Fetch, throttle and deferred extraction share these exact resources. A fresh handler call
    // gets a fresh ledger; waitUntil retains this invocation's ledger instead of resetting quota.
    const resources = createInvocationResources(() => env.LIBRARY_DB, env.DOCS_BUCKET);
    const documents = createDocuments(resources.bucket, env.PUBLIC_DOCS_ORIGIN);
    const config = httpLibraryConfig(env.LIBRARY_SIZE_BUDGET_BYTES);
    let library: ReturnType<typeof createLibraryIndex> | undefined;
    return { documents, resources, config, library: () => library ??= libraryFactory({
      get db() { return resources.db; }, documents, config, budget: resources.budget,
      publicOrigin: env.PUBLIC_DOCS_ORIGIN, extract: extractText,
      defer: (work) => context.waitUntil(work), now: Date.now, nonce: () => crypto.randomUUID(),
    } satisfies LibraryDependencies) };
  }
  return {
    async fetch(request: Request, env: Env, context: Pick<ExecutionContext, "waitUntil">): Promise<Response> {
      if (!validOrigins(env) || (env.APP_ROLE !== "public" && env.APP_ROLE !== "catalog")) return unavailable();
      const url = new URL(request.url);
      const expectedOrigin = env.APP_ROLE === "catalog" ? env.CATALOG_ORIGIN : env.PUBLIC_DOCS_ORIGIN;
      if (url.origin !== expectedOrigin) return unavailable();
      const scope = invocation(env, context);
      if (env.APP_ROLE === "catalog") {
        return createCatalog({
          library: scope.library, config: scope.config, bucket: scope.resources.bucket,
          security: {
            catalogOrigin: env.CATALOG_ORIGIN, publicOrigin: env.PUBLIC_DOCS_ORIGIN,
            password: env.ALL_DOCS_PASSWORD, sessionKey: env.CATALOG_SESSION_KEY,
          }, assets: catalogAssets,
        }).fetch(request);
      }
      return publicFetch(request, env, scope.documents, () => scope.library().documents);
    },
    scheduled(_controller: ScheduledController, env: Env, context: Pick<ExecutionContext, "waitUntil">): void {
      // Only the catalog deployment owns maintenance. The public binding supports authenticated
      // write upkeep, never scheduled scans or a route for index reads.
      if (env.APP_ROLE !== "catalog" || !validOrigins(env)) return;
      const scope = invocation(env, context);
      context.waitUntil(scope.library().maintain(httpMaintenanceOptions(scope.config)));
    },
  };
}
export default createWorker() satisfies ExportedHandler<Env>;

async function publicFetch(request: Request, env: PublicEnv, documents: Documents, writes: () => Documents): Promise<Response> {
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
        const doc = await writes().create({
          body: request.body, filename: request.headers.get("X-Filename") || "file",
          mime: request.headers.get("Content-Type") || "", title: request.headers.get("X-Doc-Name") || "",
        });
        return Response.json({ url: doc.publicUrl, id: doc.id });
      }
      const result = await writes().remove(id);
      // A decorator may refuse an overlapping delete as changed. The CLI must retain history
      // until this invocation proves absence/success, rather than marking a refusal deleted.
      if (result.status === "changed") throw new Error("Deletion did not establish absence");
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
