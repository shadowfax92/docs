/** Loopback fixture server shared by the headless Vim proofs. Each owned
 * in-memory source crosses the production Preview -> enhanceHtml -> skill runtime
 * path (esbuild bundles of preview.ts and vim.ts) on a fresh stream per request,
 * exactly as at the Documents seam. No R2, owner data, deployment or network.
 */
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

async function importBundle(entry) {
  const bundle = await build({
    entryPoints: [fileURLToPath(new URL(entry, import.meta.url))],
    bundle: true, write: false, platform: "node", format: "esm", target: "es2022",
  });
  return import("data:text/javascript;base64," + Buffer.from(bundle.outputFiles[0].text).toString("base64"));
}

export const { renderDocument } = await importBundle("../../preview.ts");
export const { enhanceHtml } = await importBundle("../../vim.ts");

/** Bake authored HTML with the verbatim vendored upstream assembler (theme none),
 * as a skill-built upload would be, with its own source/storage identity. */
export function bake(html, source, key) {
  return execFileSync("python3", ["-B", "-c",
    "import sys;sys.path.insert(0,sys.argv[1]);import build;print(build.build(sys.stdin.read(),theme='none',source=sys.argv[2],key=sys.argv[3])[0])",
    fileURLToPath(new URL("upstream/scripts", import.meta.url)), source, key,
  ], { input: html, encoding: "utf8" });
}

/** Serve `sources` ({path: html | {markdown}}) and their /raw and /download
 * variants on 127.0.0.1. `route(context)` may return a Response to cross the
 * enhancement seam differently for one request; undefined uses Preview.
 * Handler failures become 500s recorded in serverErrors for the caller to assert.
 */
export async function startProofServer({ sources, id, title, route }) {
  const serverErrors = [];
  let origin;
  const server = createServer(async (req, res) => {
    try {
      const requested = new URL(req.url, origin).pathname;
      const variant = requested.endsWith("/raw") ? "raw" : requested.endsWith("/download") ? "download" : "page";
      const path = requested.replace(/\/(?:raw|download)$/, "");
      if (!(path in sources)) { res.writeHead(404); res.end(); return; }
      const generated = typeof sources[path] !== "string";
      const bytes = new TextEncoder().encode(generated ? sources[path].markdown : sources[path]);
      const name = title.toLowerCase().replace(/\W+/g, "-");
      const summary = {
        id, version: "fixture-v1", title, filename: name + (generated ? ".md" : ".html"),
        kind: generated ? "markdown" : "html", mime: generated ? "text/markdown" : "text/html",
        sizeBytes: bytes.length, uploadedAt: "2026-10-15T00:00:00.000Z", timeSource: "r2", createdAt: null,
        publicUrl: origin + path, rawUrl: origin + path + "/raw", downloadUrl: origin + path + "/download", objectCount: 1, warnings: [],
      };
      const doc = {
        summary, objects: [{ sizeBytes: bytes.length, etag: "fixture-etag", uploadedAt: summary.uploadedAt }],
        openBody: async () => ({ body: new Response(bytes).body }),
      };
      const render = () => renderDocument(doc, variant, new Request(origin + requested));
      const response = (route && await route({ path, variant, summary, render })) || await render();
      res.writeHead(response.status, { ...Object.fromEntries(response.headers), "Cache-Control": "no-store" });
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) { serverErrors.push(String(error)); res.writeHead(500); res.end("Fixture failed"); }
  });
  await new Promise((ok, fail) => { server.once("error", fail); server.listen(0, "127.0.0.1", ok); });
  origin = `http://127.0.0.1:${server.address().port}`;
  return { origin, serverErrors, close: () => new Promise(ok => server.close(ok)) };
}
