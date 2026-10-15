import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import type { TextRecord } from "./contracts";

// Only storage is substituted: the production extractor and native HTMLRewriter run in workerd.
// The HTTP adapter supplies a single-use, range-shaped body without reading owner R2 objects.
let runtime: Miniflare;
beforeAll(async () => {
  const bundled = await build({
    stdin: { contents: `
      import { extractText } from './src/extract';
      export default { async fetch(request) {
        const bytes = new Uint8Array(await request.arrayBuffer());
        const url = new URL(request.url);
        let cancelled = false;
        let opened = false;
        const summary = {
          id:'Ab12Cd34', version:'fixture-version', filename:url.searchParams.get('name') || 'note.txt',
          kind:url.searchParams.get('kind') || 'text', mime:url.searchParams.get('mime') || 'text/plain',
          sizeBytes:bytes.length, objectCount:Number(url.searchParams.get('objects') || 1),
        };
        const doc = { summary, objects:[{sizeBytes:bytes.length}], async openBody(options) {
          if (opened) throw new Error('opened twice');
          opened = true;
          if (url.searchParams.has('missing')) return null;
          if (url.searchParams.has('changed')) throw new Error('private key must not escape');
          const cap = options.maxBytes;
          const size = Math.min(bytes.length, cap);
          let offset = 0;
          return { body:new ReadableStream({ pull(controller) {
            if (url.searchParams.has('read-error')) { controller.error(new Error('private read detail')); return; }
            if (offset === size) { controller.close(); return; }
            const end = Math.min(size, offset + Number(url.searchParams.get('chunk') || 16384));
            controller.enqueue(bytes.slice(offset,end)); offset = end;
          }, cancel() { cancelled = true; } }) };
        }};
        return Response.json({record:await extractText(doc), opened, cancelled});
      }};
    // Node supplies import.meta.url; the production Cloudflare type set does not declare it.
    `, resolveDir: new URL("../", (import.meta as ImportMeta & { url: string }).url).pathname },
    bundle: true, write: false, format: "esm", platform: "browser", target: "es2022",
  });
  runtime = new Miniflare({
    modules: true, script: bundled.outputFiles[0].text, compatibilityDate: "2024-12-01",
    outboundService: () => { throw new Error("Extraction must never make an outbound request"); },
  });
});
afterAll(async () => { await runtime?.dispose(); });

async function extract(body: string | Uint8Array, query = "") {
  const response = await runtime.dispatchFetch(`https://extract.example/?${query}`, { method: "POST", body });
  expect(response.status).toBe(200);
  return await response.json() as { record: TextRecord; opened: boolean; cancelled: boolean };
}

describe("extractText in native workerd", () => {
  it("searches old HTML without scripts, styles, templates or noscript and keeps word separators", async () => {
    const { record } = await extract(`<!doctype html><title>A &amp; B</title>
      <style>styleSecret</style><script>throw new Error('scriptSecret')</script>
      <template><p>templateSecret</p><template>nestedSecret</template></template>
      <noscript>noscriptSecret</noscript><h1>Hello</h1><p>world&nbsp;😀</p>
      <!-- commentSecret --><span>one</span><span>two</span>`, "kind=html&name=old.html");
    expect(record).toMatchObject({ coverage: "full", reason: null, documentVersion: "fixture-version" });
    expect(record.text).toBe("A & B Hello world 😀 one two");
    expect(record.indexedBytes).toBe(new TextEncoder().encode(record.text).length);
  });

  it("keeps a typical embedded vim runtime from exhausting the readable-text budget", async () => {
    const source = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><style>${"a".repeat(700 * 1024)}</style></head><body><script>${"b".repeat(700 * 1024)}</script><main>Real searchable document tail</main></body></html>`;
    const { record } = await extract(source, "kind=html&name=vim.html");
    expect(record).toMatchObject({ coverage: "full", text: "Real searchable document tail", reason: null });
    expect(record.sourceBytes).toBeGreaterThan(1024 * 1024);
  });

  it("handles native void and self-closing element lifecycles without losing following text", async () => {
    const { record } = await extract('<meta charset="utf-8"><link rel="stylesheet" href="https://never.example/style"><p>one<br>two</p><hr><img src="https://never.example/image"><input value="attributeSecret"><svg><script/><circle/></svg><p>three</p>', "kind=html");
    expect(record).toMatchObject({ coverage: "full", text: "one two three", reason: null });
  });

  it("handles malformed/nested excluded HTML and decodes entities once without treating text as markup", async () => {
    for (const source of [
      "<template><p>private</template><p>public</p>",
      "<div><noscript><span>private</span></noscript><p>public</p></div>",
      "<svg><script>private</script></svg><p>public</p>",
    ]) expect((await extract(source, "kind=html")).record.text).toBe("public");
    expect((await extract("<p>&lt;script&gt; &amp;amp; &#x1f600; &copy no-semicolon \\*</p>", "kind=html&chunk=1")).record.text)
      .toBe("<script> &amp; 😀 © no-semicolon \\*");
    expect((await extract("<p>visible</p><script>unclosed", "kind=html")).record.text).toBe("visible");
    expect((await extract("one<script>private</script>two<style>private</style>three", "kind=html")).record.text).toBe("one two three");
  });

  it("searches UTF-8 Markdown, code and structured data as source without executing or rendering it", async () => {
    for (const name of ["notes.md", "code.ts", "query.sql", "data.json", "data.csv", "data.xml", "config.yaml"]) {
      const { record } = await extract("\ufeff# 😀 Héllo\n<script>literal source</script>", `name=${name}&kind=binary&mime=application/octet-stream&chunk=1`);
      expect(record).toMatchObject({ coverage: "full", text: "# 😀 Héllo\n<script>literal source</script>", reason: null });
    }
    expect((await extract("", "name=empty.txt")).record).toMatchObject({ coverage: "full", text: "", indexedBytes: 0 });
  });

  it("caps source/output bytes without replacement characters or split Unicode scalars and cancels unused bodies", async () => {
    const limit = 512 * 1024;
    const output = await extract("😀".repeat(limit / 4 + 1));
    expect(output.record.coverage).toBe("truncated");
    expect(output.record.reason).toContain("512 KiB");
    expect(output.record.indexedBytes).toBe(limit);
    expect(output.record.text).toBe("😀".repeat(limit / 4));

    // The source limit bisects an astral character inside discarded CSS, then misses the real body.
    // Reporting truncated is essential even though the bounded HTML output is empty.
    const source = "<style>" + "x".repeat(2 * 1024 * 1024 - 8) + "😀</style><p>tail outside source cap</p>";
    const truncated = await extract(source, "kind=html");
    expect(truncated.record).toMatchObject({ coverage: "truncated", text: "", indexedBytes: 0 });
    expect(truncated.record.reason).toContain("2 MiB");
    expect(truncated.cancelled).toBe(true);
    expect(truncated.record.text).not.toContain("�");
  });

  it("reports invalid UTF-8, binary bytes and unsupported encodings honestly", async () => {
    expect((await extract(new Uint8Array([0x61, 0xff, 0x62]))).record).toMatchObject({ coverage: "error", text: "" });
    expect((await extract(new Uint8Array([0x61, 0xe2, 0x82]))).record).toMatchObject({ coverage: "error", text: "" });
    expect((await extract("a\u0000b")).record).toMatchObject({ coverage: "metadata-only", text: "" });
    const encoding = await extract("legacy", "mime=text/plain;charset=windows-1252");
    expect(encoding.opened).toBe(false);
    expect(encoding.record.reason).toContain("encoding");
  });

  it("leaves binary formats unopened and identifies the exact PDF/DOCX extraction seam", async () => {
    for (const [name, kind, source] of [["bad.pdf", "pdf", "%PDF corrupt"], ["bad.docx", "office", "PK corrupt"], ["data.zip", "archive", "PK"], ["photo.png", "image", "PNG"]]) {
      const result = await extract(source, `name=${name}&kind=${kind}&mime=application/octet-stream`);
      expect(result.opened).toBe(false);
      expect(result.record).toMatchObject({ coverage: "metadata-only", text: "", indexedBytes: 0 });
      expect(result.record.reason).toBeTruthy();
    }
  });

  it("discloses primary-object-only coverage and read/parser failures without private details", async () => {
    const grouped = await extract("first object", "objects=2");
    expect(grouped.record).toMatchObject({ coverage: "truncated", text: "first object" });
    expect(grouped.record.reason).toContain("primary object");
    for (const query of ["missing", "changed", "read-error"]) {
      const result = await extract("text", query);
      expect(result.record).toMatchObject({ coverage: "error", text: "", indexedBytes: 0 });
      expect(result.record.reason).not.toContain("private");
    }
    const nodes = await extract("<span></span>".repeat(32769), "kind=html");
    expect(nodes.record).toMatchObject({ coverage: "error", text: "", indexedBytes: 0 });
  });
});
