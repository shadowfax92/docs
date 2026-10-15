import { describe, expect, it } from "vitest";
import { strToU8, zipSync } from "fflate";
import type { DocumentSummary } from "./contracts";
import type { ResolvedDocument } from "./documents";
import { renderDocument } from "./preview";

const base = "https://docs.example/Ab12Cd34";

/** Test adapter preserves the one-open, version-checked stream interface used by native R2. */
function document(filename: string, input: string | Uint8Array, options: { mime?: string; missing?: boolean; size?: number } = {}) {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  const opened: Array<{ range?: R2Range; maxBytes?: number }> = [];
  let canceled = 0;
  const summary: DocumentSummary = {
    id: "Ab12Cd34", version: "version-1", filename, title: "Fixture <title>", kind: "binary",
    mime: options.mime ?? "application/octet-stream", sizeBytes: options.size ?? bytes.length,
    uploadedAt: "2026-10-14T12:00:00.000Z", timeSource: "r2", createdAt: null,
    publicUrl: base, rawUrl: `${base}/raw`, downloadUrl: `${base}/download`, objectCount: 1, warnings: [],
  };
  const doc: ResolvedDocument = {
    summary, objects: [{ key: `Ab12Cd34/${filename}`, version: "r2-v1", etag: "abc123", sizeBytes: summary.sizeBytes, uploadedAt: summary.uploadedAt }],
    async openBody(opts = {}) {
      if (opened.length) throw new Error("body opened twice");
      opened.push(opts);
      if (options.missing) return null;
      const offset = opts.range && "offset" in opts.range ? opts.range.offset ?? 0 : 0;
      const length = opts.maxBytes ?? (opts.range && "length" in opts.range ? opts.range.length : undefined);
      const selected = bytes.slice(offset, length === undefined ? undefined : offset + length);
      const body = new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(selected); },
        pull(controller) { controller.close(); },
        cancel() { canceled++; },
      });
      return { body, size: summary.sizeBytes, etag: "abc123", httpEtag: '"abc123"', version: "r2-v1", uploaded: new Date(summary.uploadedAt),
        arrayBuffer: () => new Response(body).arrayBuffer(), text: () => new Response(body).text() } as unknown as R2ObjectBody;
    },
  };
  return { doc, opened, get canceled() { return canceled; } };
}

function request(headers: Record<string, string> = {}, method = "GET") {
  return new Request(base, { headers, method });
}

describe("public preview HTTP semantics", () => {
  it("revalidates all variants and only returns 304 after validating a live body", async () => {
    for (const variant of ["page", "raw", "download"] as const) {
      const fixture = document("note.txt", "original");
      const response = await renderDocument(fixture.doc, variant, request());
      expect(response.headers.get("Cache-Control")).toBe("public, max-age=0, must-revalidate");
      expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
      await response.text();
    }
    const live = document("note.txt", "original");
    const response = await renderDocument(live.doc, "raw", request({ "If-None-Match": 'W/"abc123"' }));
    expect(response.status).toBe(304);
    expect(await response.text()).toBe("");
    expect(live.opened).toHaveLength(1);
    expect(live.canceled).toBe(1);
    const removed = document("note.txt", "original", { missing: true });
    const missing = await renderDocument(removed.doc, "raw", request({ "If-None-Match": '"abc123"' }));
    expect(missing.status).toBe(404);
    expect(missing.headers.get("Cache-Control")).toBe("no-store");
  });

  it("streams exact raw/download byte ranges with consistent validators and dispositions", async () => {
    const bytes = new Uint8Array([0, 255, 7, 9, 13, 10]);
    for (const variant of ["raw", "download"] as const) {
      const fixture = document("sample.mp4", bytes);
      const response = await renderDocument(fixture.doc, variant, request({ Range: "bytes=1-3" }));
      expect(response.status).toBe(206);
      expect(response.headers.get("Content-Range")).toBe("bytes 1-3/6");
      expect(response.headers.get("Content-Length")).toBe("3");
      expect(response.headers.get("ETag")).toBe('"abc123"');
      expect(response.headers.get("Content-Type")).toBe("video/mp4");
      expect(response.headers.get("Content-Disposition")).toBe(`${variant === "download" ? "attachment" : "inline"}; filename="sample.mp4"`);
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([255, 7, 9]));
      expect(fixture.opened).toEqual([{ range: { offset: 1, length: 3 } }]);
    }
  });
});

const wordXml = (text: string) => `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p><w:p><w:r><w:t>Second paragraph</w:t><w:tab/><w:t>after tab</w:t></w:r></w:p></w:body></w:document>`;
const docx = (xml: string) => zipSync({ "word/document.xml": strToU8(xml) });

describe("bounded DOCX text preview", () => {
  it("shows escaped main-document paragraphs without external resources or Word-layout claims", async () => {
    const bytes = zipSync({ "word/document.xml": strToU8(wordXml("DOCX sentinel &amp; &#x3c;script&#x3e;bad()&lt;/script&gt;")), "word/media/ignored.bin": new Uint8Array(2 * 1024 * 1024) });
    const html = await (await renderDocument(document("report.docx", bytes).doc, "page", request())).text();
    expect(html).toContain("DOCX sentinel &#38; &#60;script&#62;bad()&#60;/script&#62;");
    expect(html).toContain("Second paragraph");
    expect(html).toContain("Main document text only");
    expect(html).not.toContain("<script>bad()");
    expect(html).not.toContain("officeapps");
  });

  it("falls back on malformed ZIP/XML, entity declarations, duplicate entries and entry-count limits", async () => {
    const entries = Object.fromEntries(Array.from({ length: 257 }, (_, index) => [`part-${index}`, strToU8("part")]));
    for (const bytes of [
      strToU8("not zip"), docx("<w:document>unclosed"), docx('<!DOCTYPE x [<!ENTITY secret SYSTEM "https://evil.example/">]>' + wordXml("&secret;")),
      docx(wordXml("&unknown;")), zipSync(entries),
    ]) {
      const html = await (await renderDocument(document("bad.docx", bytes).doc, "page", request())).text();
      expect(html.includes('class="download-card"')).toBe(true);
      expect(html).toContain(`href="${base}/download"`);
    }
  });

  it("bounds actual expansion even when ZIP size declarations lie", async () => {
    const bytes = docx(wordXml("x".repeat(2 * 1024 * 1024)));
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    view.setUint32(22, 100, true); // forged local uncompressed size
    for (let offset = 0; offset + 46 <= bytes.length; offset++) {
      if (view.getUint32(offset, true) === 0x02014b50) view.setUint32(offset + 24, 100, true);
    }
    const html = await (await renderDocument(document("bomb.docx", bytes).doc, "page", request())).text();
    expect(html.includes('class="download-card"')).toBe(true);
    expect(html).toContain("expanded");
  });
});

describe("public page rendering", () => {
  it("renders safe self-hosted Markdown without serializing untrusted source into a script", async () => {
    const source = '# Hello\n\n</script><script>globalThis.pwned = true</script>\n\n<img src=x onerror=alert(1)>\n\n[x](javascript:alert(1))\n\n**Strong**\n\n```html\n<script>bad()</script>\n```';
    const response = await renderDocument(document("note.md", source).doc, "page", request());
    const html = await response.text();
    expect(html).toContain("<h1>Hello</h1>");
    expect(html).toContain("<strong>Strong</strong>");
    expect(html).toContain("&lt;script&gt;globalThis.pwned = true&lt;/script&gt;");
    expect(html).not.toContain("<script>globalThis.pwned");
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('href="javascript:');
    expect(html).not.toContain("cdnjs");
    expect(html).not.toContain("const raw =");
    expect(html).toContain('href="https://docs.example/Ab12Cd34/download"');
    expect(html).toContain("Fixture &#60;title&#62;");
  });

  it("keeps authored HTML styling/scripts/forms without viewer chrome and keeps originals exact", async () => {
    const source = '<!doctype html><style>body{background:purple}</style><form><input name="q"></form><script>window.author=true</script>';
    for (const variant of ["page", "raw", "download"] as const) {
      const response = await renderDocument(document("custom.html", source).doc, variant, request());
      const html = await response.text();
      expect(html).toContain(source);
      expect(html).not.toContain('class="viewer-bar"');
      if (variant !== "page") expect(html).toBe(source);
    }
  });

  it.each([
    ["photo.png", '<img src="https://docs.example/Ab12Cd34/raw"'],
    ["vector.svg", '<img src="https://docs.example/Ab12Cd34/raw"'],
    ["report.pdf", '<iframe src="https://docs.example/Ab12Cd34/raw"'],
    ["sound.mp3", '<audio controls preload="metadata"'],
    ["movie.mp4", '<video controls preload="metadata" playsinline'],
  ])("uses a native preview and download fallback for %s without buffering its payload", async (filename, expected) => {
    const fixture = document(filename, "native fixture");
    const response = await renderDocument(fixture.doc, "page", request());
    const html = await response.text();
    expect(html).toContain(expected);
    expect(html).toContain(`href="${base}/download"`);
    expect(fixture.opened).toEqual([{ maxBytes: 1 }]);
    expect(fixture.canceled).toBe(1);
  });
});

describe("bounded text and data previews", () => {
  it("escapes source/log markup with addressable lines", async () => {
    const html = await (await renderDocument(document("source.ts", '<script>bad()</script>\r\nconst x = 1;').doc, "page", request())).text();
    expect(html).toContain('id="L2"');
    expect(html).toContain("&#60;script&#62;bad()&#60;/script&#62;");
    expect(html).not.toContain("<script>bad()");
    expect(html).toContain('aria-hidden="true">2</span>');
  });

  it("pretty prints JSON but rejects invalid and excessively nested JSON with a download", async () => {
    const html = await (await renderDocument(document("data.json", '{"a":1}').doc, "page", request())).text();
    expect(html).toContain('  &#34;a&#34;: 1');
    for (const source of ['{"a":', '['.repeat(1000) + '0' + ']'.repeat(1000)]) {
      const response = await renderDocument(document("data.json", source).doc, "page", request());
      const output = await response.text();
      expect(output).toContain('class="download-card"');
      expect(output).toContain(`href="${base}/download"`);
    }
  });

  it.each([
    ["rows.csv", 'name,value,notes\r\n"A, B",42,"first\nsecond"\r\n"Say ""hi""",-1,"<img onerror=x>"\r\n'],
    ["rows.tsv", 'name\tvalue\tnotes\n"A, B"\t42\t"first\nsecond"\n"Say ""hi"""\t-1\t"<img onerror=x>"\n'],
  ])("parses quoted delimiters, quotes, multiline cells and numeric columns in %s", async (filename, source) => {
    const html = await (await renderDocument(document(filename, source).doc, "page", request())).text();
    expect(html).toContain("Showing 2 of 2 rows.");
    expect(html).toContain("<td>A, B</td>");
    expect(html).toContain('<td class="numeric">42</td>');
    expect(html).toContain("<td>first\nsecond</td>");
    expect(html).toContain("Say &#34;hi&#34;");
    expect(html).toContain("&#60;img onerror=x&#62;");
  });

  it("bounds table rows/columns/cells and rejects malformed quoting", async () => {
    const html = await (await renderDocument(document("many.csv", 'n\n' + Array.from({ length: 250 }, (_, i) => i).join('\n')).doc, "page", request())).text();
    expect(html).toContain("Showing 200 of 250 rows.");
    for (const source of ['name\n"unfinished', 'name\n"closed"oops', Array(65).fill("x").join(","), 'name\n' + 'x'.repeat(10000)]) {
      const output = await (await renderDocument(document("bad.csv", source).doc, "page", request())).text();
      expect(output).toContain('class="download-card"');
      expect(output).toContain(`href="${base}/download"`);
    }
  });

  it("shows honest plain-text prefixes without corrupting split UTF-8, and falls back for large structured data", async () => {
    const fixture = document("large.txt", 'a'.repeat(256 * 1024 - 1) + '€tail');
    const html = await (await renderDocument(fixture.doc, "page", request())).text();
    expect(html).toContain("Raw has the full file.");
    expect(html).not.toContain("�");
    expect(fixture.opened).toEqual([{ maxBytes: 256 * 1024 }]);
    for (const filename of ["large.md", "large.json", "large.csv"]) {
      const large = document(filename, "x", { size: 300000 });
      const output = await (await renderDocument(large.doc, "page", request())).text();
      expect(output).toContain("Preview limit is 256 KB");
      expect(large.opened).toEqual([{ maxBytes: 1 }]);
      expect(large.canceled).toBe(1);
    }
  });

  it.each([new Uint8Array([0xff, 0xfe]), new Uint8Array([65, 0, 66])])("rejects binary or invalid UTF-8 with fallback", async (bytes) => {
    const html = await (await renderDocument(document("bytes.txt", bytes).doc, "page", request())).text();
    expect(html).toContain('class="download-card"');
    expect(html).toContain(`href="${base}/download"`);
  });
});

describe("range and fallback edge cases", () => {
  it.each([
    ["bytes=2-", 206, "cdef", "bytes 2-5/6"],
    ["bytes=-2", 206, "ef", "bytes 4-5/6"],
    ["bytes=-999999999999999999999999999999", 206, "abcdef", "bytes 0-5/6"],
    ["bytes=0-99999999999999999999999999", 206, "abcdef", "bytes 0-5/6"],
    ["bytes=6-", 416, "", "bytes */6"],
    ["bytes=-0", 416, "", "bytes */6"],
    ["bytes=3-1", 416, "", "bytes */6"],
    ["bytes=9007199254740992-", 416, "", "bytes */6"],
    ["bytes=0-1,4-5", 200, "abcdef", null],
    ["items=0-1", 200, "abcdef", null],
    ["bytes=garbage", 200, "abcdef", null],
  ])("handles %s without buffering originals", async (range, status, content, contentRange) => {
    const fixture = document("media.mp4", "abcdef");
    const response = await renderDocument(fixture.doc, "raw", request({ Range: range }));
    expect(response.status).toBe(status);
    expect(response.headers.get("Content-Range")).toBe(contentRange);
    expect(await response.text()).toBe(content);
    if (status === 416) expect(fixture.canceled).toBe(1);
  });

  it("gives If-None-Match precedence and requires a strong matching If-Range", async () => {
    const cached = document("media.mp4", "abcdef");
    const match = await renderDocument(cached.doc, "raw", request({ "If-None-Match": '"abc123"', Range: "bytes=999-" }));
    expect(match.status).toBe(304);
    expect(match.headers.get("Content-Range")).toBeNull();
    for (const validator of ['"different"', 'W/"abc123"', "Wed, 14 Oct 2026 12:00:00 GMT"]) {
      const full = await renderDocument(document("media.mp4", "abcdef").doc, "raw", request({ "If-Range": validator, Range: "bytes=1-2" }));
      expect(full.status).toBe(200);
      expect(await full.text()).toBe("abcdef");
    }
    const partial = await renderDocument(document("media.mp4", "abcdef").doc, "raw", request({ "If-Range": '"abc123"', Range: "bytes=1-2" }));
    expect(partial.status).toBe(206);
    expect(await partial.text()).toBe("bc");
  });

  it("does not reuse stale validators for pages or removed/replaced originals", async () => {
    const page = await renderDocument(document("file.txt", "fresh").doc, "page", request({ "If-None-Match": "*" }));
    expect(page.status).toBe(200);
    expect(page.headers.get("ETag")).toBeNull();
    await page.text();
    for (const variant of ["page", "raw", "download"] as const) {
      const removed = await renderDocument(document("gone.txt", "old", { missing: true }).doc, variant, request({ "If-None-Match": "*" }));
      expect(removed.status).toBe(404);
      const changed = document("changed.txt", "different");
      changed.doc.openBody = async () => { throw new Error("Document changed before body read"); };
      await expect(renderDocument(changed.doc, variant, request({ "If-None-Match": "*" }))).rejects.toThrow("Document changed");
    }
  });

  it("keeps full download bytes, uses conservative MIME, and contains direct SVG scripts", async () => {
    const bytes = new Uint8Array([0, 255, 128, 13, 10, 7]);
    for (const filename of ["payload.bin", "x.constructor", "x.__proto__", "old.doc"]) {
      const response = await renderDocument(document(filename, bytes, { mime: "text/html" }).doc, "download", request());
      expect(response.headers.get("Content-Type")).toBe("application/octet-stream");
      expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    }
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';
    const response = await renderDocument(document("vector.svg", svg).doc, "raw", request());
    expect(response.headers.get("Content-Type")).toBe("image/svg+xml");
    expect(response.headers.get("Content-Security-Policy")).toContain("sandbox");
    expect(await response.text()).toBe(svg);
    const metadata = document('strange.bin', bytes, { mime: 'application/x-custom' });
    const html = await (await renderDocument(metadata.doc, "page", request())).text();
    for (const expected of ['<dt>File</dt>', '<dt>Type</dt>', '<dt>Size</dt>', '<dt>Uploaded</dt>', '<dt>ID</dt>', 'application/x-custom', 'No preview for binary files.']) expect(html).toContain(expected);
    expect(metadata.canceled).toBe(1);
  });

  it("releases HEAD and unsatisfiable empty-body streams", async () => {
    const head = document("note.txt", "abcdef");
    const response = await renderDocument(head.doc, "raw", request({}, "HEAD"));
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Length")).toBe("6");
    expect(await response.text()).toBe("");
    expect(head.canceled).toBe(1);
    const empty = await renderDocument(document("empty.mp3", "").doc, "raw", request({ Range: "bytes=0-" }));
    expect(empty.status).toBe(416);
    expect(empty.headers.get("Content-Range")).toBe("bytes */0");
  });
});

describe("stream lifecycle and active input", () => {
  it("cancels an over-budget adapter stream and keeps the original download", async () => {
    const fixture = document("misreported.txt", "small");
    let canceled = false;
    fixture.doc.openBody = async () => ({ body: new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(300000)); },
      cancel() { canceled = true; },
    }) }) as R2ObjectBody;
    const html = await (await renderDocument(fixture.doc, "page", request())).text();
    expect(canceled).toBe(true);
    expect(html).toContain("exceeds the preview byte limit");
    expect(html).toContain(`href="${base}/download"`);
  });

  it("cancels pending text reads when the requesting client aborts", async () => {
    const fixture = document("pending.txt", "unused");
    let canceled = false;
    fixture.doc.openBody = async () => ({ body: new ReadableStream<Uint8Array>({ cancel() { canceled = true; } }) }) as R2ObjectBody;
    const controller = new AbortController();
    const rendering = renderDocument(fixture.doc, "page", new Request(base, { signal: controller.signal }));
    controller.abort();
    await expect(rendering).rejects.toThrow("aborted");
    expect(canceled).toBe(true);
  });

  it.each([
    '</script><script>alert("script-breakout")</script>',
    '<svg onload=alert(1)><foreignObject><iframe srcdoc="attack"></iframe></foreignObject></svg>',
    '[link](javascript:alert(1))\n[ref][x]\n[x]: vbscript:msgbox(1)',
    '![image](data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+)\n[link](data:text/html;base64,PHNjcmlwdD4=)',
    '<style>body{display:none}</style><form action="https://evil.example"><input autofocus onfocus=alert(1)></form>',
  ])("keeps active Markdown inert: %s", async (source) => {
    const html = await (await renderDocument(document("active.md", source).doc, "page", request())).text();
    const article = html.slice(html.indexOf('<article class="prose">'), html.indexOf('</article>'));
    expect(article).not.toMatch(/<(?:script|svg|iframe|style|form|input)\b/i);
    expect(article).not.toMatch(/(?:href|src)="(?:javascript|vbscript|data:(?:text\/html|image\/svg))/i);
  });
});

it("propagates storage read failures instead of caching a successful fallback", async () => {
  const fixture = document("failed.txt", "unused");
  fixture.doc.openBody = async () => ({ body: new ReadableStream<Uint8Array>({ start(controller) { controller.error(new Error("R2 stream failed")); } }) }) as R2ObjectBody;
  await expect(renderDocument(fixture.doc, "page", request())).rejects.toThrow("R2 stream failed");
});
