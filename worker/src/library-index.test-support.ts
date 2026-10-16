import { Miniflare } from "miniflare";
// @ts-expect-error Node-only fixture; production TypeScript targets intentionally omit Node types.
import { readFile } from "node:fs/promises";
import { createDocuments } from "./documents";
import { extractText } from "./extract";
import { createLibraryIndex, DEFAULT_LIBRARY_CONFIG } from "./library-index";
import type { LibraryConfig, LibraryDependencies } from "./library-index";

/** Disposable real workerd D1/R2 fixture. Production SQL and Documents run unchanged;
 * no Cloudflare account, Wrangler config, credentials, network access or persistent state.
 * The single migration has no triggers/embedded semicolons: split its statements into one
 * transactional D1 batch, rather than using exec's one-statement-per-line convenience parser.
 */
export async function createLibraryFixture(options: {
  now?: () => number;
  nonce?: () => string;
  extract?: LibraryDependencies["extract"];
  config?: Partial<LibraryConfig>;
} = {}) {
  const runtime = new Miniflare({
    modules: true, script: "export default { fetch() { return new Response('local library fixture'); } };",
    compatibilityDate: "2024-12-01", host: "127.0.0.1", port: 0, cf: false,
    d1Databases: { LIBRARY_DB: "local-library-index" }, r2Buckets: ["DOCS_BUCKET"],
    outboundService: () => { throw new Error("Library fixtures cannot fetch externally"); },
  });
  try {
    // Miniflare's host proxies and Workers' bindings have distinct type declarations,
    // but expose the same native D1/R2 protocol. This is the only adapter type translation.
    const db = await runtime.getD1Database("LIBRARY_DB") as unknown as D1Database;
    const bucket = await runtime.getR2Bucket("DOCS_BUCKET") as unknown as R2Bucket;
    // import.meta.url is supplied by Node; the Worker-only type library has an empty ImportMeta.
    const migration = new URL("../migrations/0001_library_index.sql", (import.meta as { url: string }).url);
    const sql: string = await readFile(migration, "utf8");
    const statements = sql.replace(/^\s*--.*$/gm, "").split(";").map((part) => part.trim()).filter(Boolean);
    await db.batch(statements.map((statement) => db.prepare(statement)));
    const deferred: Promise<unknown>[] = [];
    const publicOrigin = "https://docs.example";
    const documents = createDocuments(bucket, publicOrigin);
    const deps: LibraryDependencies = {
      db, documents, publicOrigin,
      extract: options.extract ?? extractText,
      now: options.now ?? Date.now,
      nonce: options.nonce ?? (() => crypto.randomUUID()),
      defer: (work) => { deferred.push(work); },
      config: { ...DEFAULT_LIBRARY_CONFIG, ...options.config },
    };
    return {
      db, bucket, documents, deps, library: createLibraryIndex(deps),
      async flush() { await Promise.allSettled(deferred.splice(0)); },
      async dispose() {
        try { await Promise.allSettled(deferred.splice(0)); }
        finally { await runtime.dispose(); }
      },
    };
  } catch (error) {
    await runtime.dispose();
    throw error;
  }
}
