import { describe, expect, it } from "vitest";
import { enhanceHtml } from "./vim";

const identity = { id: "Ab12Cd34", title: "Authored report", publicUrl: "https://docs.example/Ab12Cd34" };
const htmlResponse = (body: BodyInit, headers: Record<string, string> = {}) =>
  new Response(body, { headers: { "Content-Type": "text/html; charset=utf-8", ...headers } });

describe("public HTML vim enhancement", () => {
  it("preserves authored bytes and adds one offline theme-none runtime with stable identity", async () => {
    const original = '<!doctype html><html><head><style>main{color:purple}</style></head><body><main><h1>Report</h1><p>One point</p></main><script>window.authored = true</script></body></html>';
    const response = await enhanceHtml(htmlResponse(original), identity);
    const result = await response.text();
    expect(result.startsWith(original)).toBe(true);
    expect(result).toContain('data-vh="runtime"');
    expect(result).toContain('"theme":"none"');
    expect(result).toContain('"storageKey":"docs:https://docs.example/Ab12Cd34"');
    expect(result).not.toContain('data-vh="doc"');
    expect(result).not.toMatch(/<(?:script|link)\b[^>]*(?:src|href)=/i);
  });

  it("is byte-idempotent and preserves baked comment/source identity", async () => {
    const first = await enhanceHtml(htmlResponse("<main><h1>Fragment</h1><p>Text</p></main>"), identity);
    const built = await first.text();
    const second = await enhanceHtml(htmlResponse(built), { ...identity, publicUrl: "https://docs.example/Other123" });
    expect(await second.text()).toBe(built);
    const baked = '<!-- vim-html:head:begin --><style data-vh="theme">body{color:red}</style><!-- vim-html:head:end --><p>Original</p><script data-vh="config">window.VIM_HTML={source:"/source/report.html",storageKey:"original"}</script><script data-vh="runtime">window.__VH={}</script>';
    expect(await (await enhanceHtml(htmlResponse(baked), identity)).text()).toBe(baked);
  });

  it.each([
    '<h1>Fragment</h1><p>Text</p>',
    '<html><title>No optional tags</title><h1>Title</h1><p>Body</p></html>',
    '<p title="a > b">Text</p><script>window.tag="<body>";</script>',
  ])("enhances fragments and omitted structural tags without rewriting them", async (body) => {
    const result = await (await enhanceHtml(htmlResponse(body), identity)).text();
    expect(result.startsWith(body)).toBe(true);
    expect(result).toContain('data-vh="runtime"');
  });

  it.each([
    '<meta http-equiv="Content-Security-Policy" content="script-src \'none\'"><p>Protected</p>',
    '<script>unterminated', '<style>unterminated', '<!-- incomplete',
    '<template><p>Inert</p>', '<svg><text>Foreign</text>', '<plaintext>All text', '<p title="incomplete',
    '<h1>One</h1><script><!--<script></script>',
    '<template><p>Hidden</p></svg>', '<svg><p>Hidden</p></template>',
    '<meta charset="windows-1252"><p>Legacy encoding</p>',
  ])("declines CSP and unfinished parser contexts instead of breaking authored content", async (body) => {
    expect(await (await enhanceHtml(htmlResponse(body), identity)).text()).toBe(body);
  });

  it.each<Record<string, string>>([
    { "Content-Security-Policy": "default-src 'self'" },
    { "Content-Security-Policy": "script-src 'unsafe-inline' 'nonce-fixed'; style-src 'unsafe-inline'" },
    { "Content-Security-Policy": "script-src 'unsafe-inline'; style-src 'unsafe-inline', default-src 'none'" },
    { "Content-Security-Policy": "script-src 'unsafe-inline'; script-src-elem 'none'; style-src 'unsafe-inline'" },
    { "Content-Security-Policy": "script-src 'unsafe-inline'; style-src 'unsafe-inline'; sandbox" },
    { "Content-Security-Policy": "script-src\u00a0'unsafe-inline'; script-src 'none'; style-src 'unsafe-inline'" },
    { "Content-Type": "text/plain" }, { "Content-Type": "text/html; charset=windows-1252" },
    { "Content-Encoding": "gzip" }, { "Cache-Control": "public, no-transform" },
    { "Content-Range": "bytes 0-9/20" }, { "Content-Disposition": "attachment" },
  ])("returns unsupported response representations without consuming them", async (headers) => {
    const response = htmlResponse("<h1>Original</h1>", headers);
    expect(await enhanceHtml(response, identity)).toBe(response);
    expect(response.bodyUsed).toBe(false);
  });

  it("enhances generated previews whose unchanged CSP permits the offline inline layer", async () => {
    const policy = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' https: http: data:; media-src 'self'; frame-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; object-src 'none'";
    const response = await enhanceHtml(htmlResponse("<main><p>Generated text</p></main>", { "Content-Security-Policy": policy }), identity);
    expect((await response.text()).includes('data-vh="runtime"')).toBe(true);
    expect(response.headers.get("Content-Security-Policy")).toBe(policy);
  });

  it("retains byte fidelity for invalid UTF-8 and BOM/CRLF source", async () => {
    const invalid = new Uint8Array([0x3c, 0x70, 0x3e, 0xff]);
    expect(new Uint8Array(await (await enhanceHtml(htmlResponse(invalid), identity)).arrayBuffer())).toEqual(invalid);
    const original = new TextEncoder().encode('\uFEFF<h1>日本語</h1>\r\n<p>Résumé</p>\r\n');
    const bytes = new Uint8Array(await (await enhanceHtml(htmlResponse(original), identity)).arrayBuffer());
    expect(bytes.slice(0, original.length)).toEqual(original);
  });

  it("escapes hostile identity in script data and removes obsolete representation validators", async () => {
    const response = await enhanceHtml(htmlResponse("<p>Text</p>", {
      ETag: '"original"', "Content-Length": "11", "Content-MD5": "original", "Accept-Ranges": "bytes",
      "X-Authored": "keep", "Cache-Control": "no-cache",
    }), { ...identity, title: '</script><script>window.pwned=true</script><!--' });
    const result = await response.text();
    expect(result).not.toContain('</script><script>window.pwned');
    expect(result).toContain('\\u003c/script>');
    expect((result.match(/<script\b/g) || []).length).toBe(2);
    expect((result.match(/<\/script>/g) || []).length).toBe(2);
    for (const header of ["ETag", "Content-Length", "Content-MD5", "Accept-Ranges"]) expect(response.headers.has(header)).toBe(false);
    expect(response.headers.get("X-Authored")).toBe("keep");
    expect(response.headers.get("Cache-Control")).toBe("no-cache");
  });

  it("replays oversized source exactly and cancels its unread tail on downstream cancellation", async () => {
    const prefix = new Uint8Array(4 * 1024 * 1024).fill(65);
    const tail = new Uint8Array([66, 67]);
    const large = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(prefix); c.enqueue(tail); c.close(); } });
    const response = await enhanceHtml(htmlResponse(large, { ETag: '"large"' }), identity);
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(bytes.length).toBe(prefix.length + 2);
    expect(bytes.slice(-2)).toEqual(tail);
    expect(response.headers.get("ETag")).toBe('"large"');

    let cancelled: unknown;
    const unending = new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(prefix); c.enqueue(tail); },
      cancel(reason) { cancelled = reason; },
    });
    const output = await enhanceHtml(htmlResponse(unending), identity);
    await output.body!.cancel("reader left");
    expect(cancelled).toBe("reader left");
  });

  it("propagates source read failures", async () => {
    const broken = new ReadableStream<Uint8Array>({ start(c) { c.error(new Error("R2 interrupted")); } });
    await expect(enhanceHtml(htmlResponse(broken), identity)).rejects.toThrow("R2 interrupted");
  });
});
