import MarkdownIt from "markdown-it";
import { Inflate } from "fflate";
import type { DocumentSummary } from "./contracts";
import type { ResolvedDocument } from "./documents";
import { enhanceHtml } from "./vim";

const TEXT_BYTES = 256 * 1024;
const MAX_LINES = 2000;
const MAX_ROWS = 200;
const MAX_COLUMNS = 64;
const DOCX_BYTES = 2 * 1024 * 1024;
const DOCX_XML_BYTES = 1024 * 1024;
const markdown: { render(source: string): string } = new MarkdownIt({ html: false, linkify: false });

type Format = "html" | "markdown" | "text" | "json" | "csv" | "tsv" | "pdf" | "image" | "audio" | "video" | "docx" | "unsupported";
class PreviewFailure extends Error {}

/** Public rendering owns original-byte delivery and bounded format previews behind one interface.
 * Documents validates identity/version. Each opened stream is transferred, consumed, or canceled;
 * storage failures propagate, while unsupported/invalid content keeps a useful download fallback.
 */
export async function renderDocument(
  doc: ResolvedDocument,
  variant: "page" | "raw" | "download",
  request: Request,
): Promise<Response> {
  if (variant !== "page") return originalResponse(doc, variant, request);
  const format = formatOf(doc.summary.filename, doc.summary.mime);
  const primary = doc.objects[0];
  const identity = { id: doc.summary.id, title: doc.summary.title, publicUrl: doc.summary.publicUrl };
  const headers = publicHeaders();
  headers.set("Content-Type", format === "html" ? originalMime(doc.summary.filename, doc.summary.mime) : "text/html; charset=utf-8");

  if (format === "html") {
    const obj = await doc.openBody();
    if (!obj) return missingResponse();
    if (request.method === "HEAD") { await obj.body.cancel(); return new Response(null, { headers }); }
    // Authored HTML keeps its scripts/forms/styles and gets only the dedicated vim enhancement.
    // In particular, neither viewer chrome nor a generated-page CSP is applied to authored pages.
    return enhanceHtml(new Response(obj.body, { headers }), identity);
  }

  const textual = ["text", "markdown", "json", "csv", "tsv", "docx"].includes(format);
  const limit = format === "docx" ? DOCX_BYTES : TEXT_BYTES;
  const tooLarge = textual && format !== "text" && primary.sizeBytes > limit;
  // R2 rejects ranges of zero-byte objects. A normal version-checked open is already bounded
  // for an empty representation and still proves existence before conditional/bodyless replies.
  const obj = await doc.openBody(primary.sizeBytes === 0 ? undefined : { maxBytes: textual && !tooLarge ? limit : 1 });
  if (!obj) return missingResponse();
  let body: string;
  if (request.method === "HEAD") {
    await obj.body.cancel();
    return new Response(null, { headers });
  }
  if (!textual || tooLarge) {
    await obj.body.cancel();
    body = tooLarge ? fallback(doc.summary, `Preview limit is ${formatBytes(limit)}. Download the original for the full file.`)
      : nativeBody(doc.summary, format);
  } else {
    // A byte prefix is intentional only for plain text. Markdown/data must be complete to avoid
    // presenting a silently altered parse. Enforce bounds again even if a storage adapter misbehaves.
    try {
      const prefix = format === "text" && primary.sizeBytes > TEXT_BYTES;
      const bytes = await readBounded(obj.body, limit, request.signal);
      const text = format === "docx" ? docxText(bytes) : decodeText(bytes, prefix);
      if (format === "docx") {
        const encoded = new TextEncoder().encode(text), truncated = encoded.length > TEXT_BYTES;
        body = `<p class="notice">Main document text only. Word layout, images, headers and embedded objects are not reproduced.</p>${text ? linesBody(decodeText(encoded.subarray(0, TEXT_BYTES), truncated), truncated) : '<p class="notice">No readable main-document text was found.</p>'}`;
      }
      else if (format === "markdown") body = `<article class="prose">${markdown.render(text)}</article>`;
      else if (format === "csv" || format === "tsv") body = tableBody(text, format === "csv" ? "," : "\t");
      else if (format === "json") body = linesBody(prettyJson(text), false);
      else body = linesBody(text, prefix);
    } catch (error) {
      if (request.signal.aborted || !(error instanceof PreviewFailure)) throw error;
      body = fallback(doc.summary, error instanceof PreviewFailure ? error.message : "This file could not be previewed. Download the original.");
    }
  }
  // These static scripts/styles are self-hosted inside the page; document strings only enter
  // escaped HTML or markdown-it's HTML-disabled renderer, never a JavaScript string literal.
  headers.set("Content-Security-Policy", "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' https: http: data:; media-src 'self'; frame-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; object-src 'none'");
  // No source-derived page ETag: runtime/renderer changes can change HTML without an object update.
  return enhanceHtml(new Response(viewerPage(doc.summary, format, body), { headers }), identity);
}

/** Bounded parsing takes ownership of a stream; cancellation (including request abort) releases
 * the R2 connection on every early exit. The raw/download path never buffers through this helper.
 */
async function readBounded(body: ReadableStream<Uint8Array>, limit: number, signal: AbortSignal): Promise<Uint8Array> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0, complete = false;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    if (signal.aborted) throw new Error("Request aborted");
    while (true) {
      const { value, done } = await reader.read();
      if (signal.aborted) throw new Error("Request aborted");
      if (done) { complete = true; break; }
      size += value.byteLength;
      if (size > limit) throw new PreviewFailure("The file exceeds the preview byte limit. Download the original.");
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return bytes;
  } finally {
    signal.removeEventListener("abort", abort);
    if (!complete) await reader.cancel();
    reader.releaseLock();
  }
}

function decodeText(bytes: Uint8Array, prefix = false): string {
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes, { stream: prefix }); }
  catch { throw new PreviewFailure("This file is not valid UTF-8 text. Download the original."); }
  if (/[\x00-\x08\x0b\x0e-\x1f]/.test(text)) throw new PreviewFailure("This file contains binary data. Download the original.");
  return text;
}

// Extensions take precedence over upload-supplied MIME. Unknown active types are never reflected
// as HTML, SVG or XML. A finite native allowlist still supports legacy extensionless media objects.
const MIME: Record<string, string> = {
  html: "text/html", htm: "text/html", md: "text/markdown; charset=utf-8", markdown: "text/markdown; charset=utf-8",
  txt: "text/plain; charset=utf-8", log: "text/plain; charset=utf-8", csv: "text/csv; charset=utf-8", tsv: "text/tab-separated-values; charset=utf-8",
  json: "application/json", pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", avif: "image/avif", svg: "image/svg+xml", ico: "image/x-icon", bmp: "image/bmp",
  mp3: "audio/mpeg", m4a: "audio/mp4", aac: "audio/aac", wav: "audio/wav", flac: "audio/flac", oga: "audio/ogg", ogg: "audio/ogg", opus: "audio/ogg",
  mp4: "video/mp4", m4v: "video/mp4", webm: "video/webm", ogv: "video/ogg", mov: "video/quicktime",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", zip: "application/zip",
};
const TEXT_EXTENSIONS = new Set("txt text log out err xml yaml yml toml ini cfg conf env css js mjs cjs ts tsx jsx py rb go rs c h cpp hpp java sh bash zsh fish sql graphql gql diff patch dockerfile makefile r lua vue svelte swift kt kts cs php pl ex exs erl tex rst org adoc properties gitignore gitconfig editorconfig".split(" "));
function fileExt(filename: string): string { return filename.split(".").pop()?.toLowerCase() || ""; }
function originalMime(filename: string, supplied = ""): string {
  const ext = fileExt(filename);
  if (ext === "html" || ext === "htm") return htmlMime(supplied);
  if (Object.hasOwn(MIME, ext)) return MIME[ext];
  if (TEXT_EXTENSIONS.has(ext)) return "text/plain; charset=utf-8";
  const media = Object.values(MIME).find((mime) => /^(image|audio|video)\//.test(mime) && mime === supplied);
  return media || "application/octet-stream";
}

/** Keep authored decoding without allowing arbitrary upload MIME or header syntax through. */
function htmlMime(supplied: string): string {
  if (!/^\s*text\/html(?:\s*;|\s*$)/i.test(supplied)) return "text/html";
  const charset = /;\s*charset\s*=\s*(?:"([a-z0-9._:-]{1,40})"|([a-z0-9._:-]{1,40}))\s*(?:;|$)/i.exec(supplied);
  return charset ? `text/html; charset=${charset[1] || charset[2]}` : "text/html";
}
function formatOf(filename: string, supplied: string): Format {
  const ext = fileExt(filename);
  if (ext === "html" || ext === "htm") return "html";
  if (ext === "md" || ext === "markdown") return "markdown";
  if (["json", "csv", "tsv", "pdf", "docx"].includes(ext)) return ext as Format;
  const mime = originalMime(filename, supplied);
  for (const kind of ["image", "audio", "video"] as const) if (mime.startsWith(`${kind}/`)) return kind;
  if (TEXT_EXTENSIONS.has(ext) || supplied.split(";")[0].trim().toLowerCase() === "text/plain") return "text";
  return "unsupported";
}
function publicHeaders(): Headers {
  return new Headers({ "Cache-Control": "public, max-age=0, must-revalidate", "X-Content-Type-Options": "nosniff" });
}

function missingResponse(): Response {
  return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
}

/** Original bytes never pass through enhanceHtml or a text decoder. Even a conditional hit
 * opens the version-checked body before returning 304, so a delete between resolve/open is 404.
 */
async function originalResponse(doc: ResolvedDocument, variant: "raw" | "download", request: Request): Promise<Response> {
  const primary = doc.objects[0];
  const etag = `"${primary.etag}"`;
  const headers = publicHeaders();
  headers.set("Content-Type", originalMime(doc.summary.filename, doc.summary.mime));
  headers.set("Content-Disposition", contentDisposition(variant === "download" ? "attachment" : "inline", doc.summary.filename));
  headers.set("ETag", etag);
  headers.set("Last-Modified", new Date(primary.uploadedAt).toUTCString());
  headers.set("Accept-Ranges", "bytes");
  if (originalMime(doc.summary.filename, doc.summary.mime) === "image/svg+xml") headers.set("Content-Security-Policy", "sandbox; default-src 'none'; style-src 'unsafe-inline'");
  const conditional = request.headers.get("If-None-Match");
  const unchanged = conditional !== null && conditional.split(",").some((tag) => tag.trim() === "*" || tag.trim().replace(/^W\//, "") === etag);
  const ifRange = request.headers.get("If-Range");
  // Date If-Range is conservatively ignored: R2 upload times have finer precision than HTTP dates.
  // A weak tag cannot validate a byte range. Mismatch returns the complete representation.
  const range = !ifRange || ifRange === etag ? parseRange(request.headers.get("Range"), primary.sizeBytes) : null;
  const noBody = unchanged || range === "unsatisfiable" || request.method === "HEAD";
  const obj = await doc.openBody(primary.sizeBytes === 0 ? undefined : noBody ? { maxBytes: 1 } : range ? { range } : undefined);
  if (!obj) return missingResponse();
  if (noBody) await obj.body.cancel();
  if (unchanged) return new Response(null, { status: 304, headers });
  if (range === "unsatisfiable") {
    headers.set("Content-Range", `bytes */${primary.sizeBytes}`);
    return new Response(null, { status: 416, headers });
  }
  if (range) {
    headers.set("Content-Range", `bytes ${range.offset}-${range.offset + range.length - 1}/${primary.sizeBytes}`);
    headers.set("Content-Length", String(range.length));
  } else headers.set("Content-Length", String(primary.sizeBytes));
  return new Response(request.method === "HEAD" ? null : obj.body, { status: range ? 206 : 200, headers });
}

/** Single byte ranges are streamed by R2. Malformed/multipart/unknown units fall back to 200;
 * a syntactically valid range outside the representation is 416, including an empty object.
 */
function parseRange(value: string | null, size: number): { offset: number; length: number } | "unsatisfiable" | null {
  if (!value) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match || (!match[1] && !match[2])) return null;
  const start = Number(match[1]), end = Number(match[2]);
  if (!size) return "unsatisfiable";
  if (!match[1]) {
    if (end === 0) return "unsatisfiable";
    const length = Math.min(end, size);
    return { offset: size - length, length };
  }
  if (!Number.isSafeInteger(start) || start >= size || (match[2] && start > end)) return "unsatisfiable";
  return { offset: start, length: (match[2] ? Math.min(end, size - 1) : size - 1) - start + 1 };
}


function escapeHtml(value: string): string { return value.replace(/[<>&"']/g, (char) => `&#${char.charCodeAt(0)};`); }
function contentDisposition(disposition: "inline" | "attachment", filename: string): string {
  return `${disposition}; filename="${filename.replace(/[^\w.\-]/g, "_")}"`;
}
function formatBytes(size: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit++; }
  return `${unit ? size.toFixed(size < 10 ? 1 : 0) : size} ${units[unit]}`;
}

function linesBody(text: string, prefix: boolean): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const shown = lines.slice(0, MAX_LINES);
  const notice = prefix ? `Showing the first ${shown.length} lines from a ${formatBytes(TEXT_BYTES)} prefix. Raw has the full file.`
    : lines.length > shown.length ? `Showing the first ${shown.length} lines of ${lines.length}. Raw has the full file.` : `${shown.length} lines`;
  return `<section class="lines"><nav class="view-options"><button type="button" data-wrap aria-pressed="false">Wrap lines</button><p>${notice}</p></nav>
<pre class="line-view">${shown.map((line, index) => `<span class="line" id="L${index + 1}"><span class="line-number" aria-hidden="true">${index + 1}</span><span class="line-text">${escapeHtml(line) || " "}</span></span>`).join("\n")}</pre></section>`;
}

/** JSON.parse validates grammar only: its numeric values are never used for display. Preserve
 * original tokens so large integers, exponent ranges, negative zero and duplicate keys survive.
 * Check depth/token/output budgets before indentation can expand a small input quadratically.
 */
function prettyJson(text: string): string {
  try { JSON.parse(text); }
  catch { throw new PreviewFailure("This file is not valid JSON. Download the original to inspect it."); }
  const lexer = /"(?:[^"\\\x00-\x1f]|\\(?:["\\/bfnrt]|u[\da-fA-F]{4}))*"|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null|[{}\[\],:]/gy;
  const tokens: string[] = [];
  let offset = 0;
  while (offset < text.length) {
    if (/[ \t\r\n]/.test(text[offset])) { offset++; continue; }
    lexer.lastIndex = offset;
    const match = lexer.exec(text);
    if (!match || tokens.length >= 10000) throw new PreviewFailure("This JSON exceeds the token preview limit. Download the original.");
    tokens.push(match[0]); offset = lexer.lastIndex;
  }
  const output: string[] = [], encoder = new TextEncoder();
  let depth = 0, bytes = 0;
  const append = (part: string) => {
    bytes += encoder.encode(part).length;
    if (bytes > TEXT_BYTES) throw new PreviewFailure("This JSON exceeds the formatted preview limit. Download the original.");
    output.push(part);
  };
  const newline = () => append("\n" + "  ".repeat(depth));
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token === "{" || token === "[") {
      if (++depth > 32) throw new PreviewFailure("This JSON exceeds the nesting preview limit. Download the original.");
      append(token);
      if (tokens[index + 1] !== (token === "{" ? "}" : "]")) newline();
    } else if (token === "}" || token === "]") {
      depth--;
      if (tokens[index - 1] !== (token === "}" ? "{" : "[")) newline();
      append(token);
    } else if (token === ",") { append(token); newline(); }
    else append(token === ":" ? ": " : token);
  }
  return output.join("");
}

/** RFC-style quoted fields include escaped quotes, delimiters and embedded newlines. Input is
 * byte-bounded before parsing; only the first MAX_ROWS data rows are retained, but totals are exact.
 */
function tableBody(text: string, delimiter: string): string {
  const kept: string[][] = [];
  let row: string[] = [], field = "", quoted = false, closed = false, started = false, total = 0;
  const cell = () => {
    if (new TextEncoder().encode(field).length > 8192) throw new PreviewFailure("This table exceeds the 8192-byte cell preview limit. Download the original.");
    row.push(field); field = ""; closed = false;
    if (row.length > MAX_COLUMNS) throw new PreviewFailure(`This table exceeds the ${MAX_COLUMNS}-column preview limit. Download the original.`);
  };
  const record = () => { cell(); if (kept.length <= MAX_ROWS) kept.push(row); total++; row = []; started = false; };
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') { field += '"'; index++; }
        else { quoted = false; closed = true; }
      } else field += char;
    } else if (char === delimiter) { cell(); started = true; }
    else if (char === "\r" || char === "\n") { record(); if (char === "\r" && text[index + 1] === "\n") index++; }
    else if (closed) throw new PreviewFailure("This table has invalid quoted fields. Download the original.");
    else if (char === '"') {
      if (field) throw new PreviewFailure("This table has invalid quoted fields. Download the original.");
      quoted = true; started = true;
    } else { field += char; started = true; }
  }
  if (quoted) throw new PreviewFailure("This table has an unterminated quoted field. Download the original.");
  if (started || row.length || closed) record();
  const header = kept.shift() ?? [];
  const columns = Math.max(header.length, ...kept.map((cells) => cells.length));
  const numeric = Array.from({ length: columns }, (_, index) => kept.length > 0 && kept.every((cells) => /^[-+]?(?:\d+(?:\.\d+)?|\.\d+)(?:e[-+]?\d+)?$/i.test(cells[index] ?? "")));
  const cells = (values: string[], tag: "th" | "td") => Array.from({ length: columns }, (_, index) => `<${tag}${tag === "th" ? ' scope="col"' : ""}${numeric[index] ? ' class="numeric"' : ""}>${escapeHtml(values[index] ?? "")}</${tag}>`).join("");
  return `<section class="table-view"><p>Showing ${kept.length} of ${Math.max(0, total - 1)} rows.</p><div class="table-scroll" tabindex="0" role="region" aria-label="Data table"><table><thead><tr>${cells(header, "th")}</tr></thead><tbody>${kept.map((values) => `<tr>${cells(values, "td")}</tr>`).join("")}</tbody></table></div></section>`;
}

function nativeBody(doc: DocumentSummary, format: Format): string {
  const raw = escapeHtml(doc.rawUrl), title = escapeHtml(doc.title), ext = escapeHtml(fileExt(doc.filename).toUpperCase());
  if (format === "pdf") return `<section class="pdf-view"><p class="notice">If the PDF doesn't appear, <a href="${raw}">open it directly</a>. <a href="${escapeHtml(doc.downloadUrl)}">Download PDF</a>.</p><iframe src="${raw}" title="${title} · PDF"></iframe></section>`;
  if (format === "image") return `<section class="media-stage"><nav class="view-options"><button type="button" data-actual aria-pressed="false">Actual size</button></nav><img src="${raw}" alt="${title}" data-image><p class="notice" data-media-error hidden>This browser can't display this image. Download the original.</p></section>`;
  if (format === "audio" || format === "video") {
    const element = format === "audio" ? `<audio controls preload="metadata" src="${raw}"></audio>` : `<video controls preload="metadata" playsinline src="${raw}"></video>`;
    return `<section class="media-stage ${format}"><p class="extension">${ext}</p>${element}<p class="notice" data-media-error hidden>This browser can't play ${ext} ${format}. Download it.</p><p class="notice">Playback depends on this browser's codec support. <a href="${escapeHtml(doc.downloadUrl)}">Download the original</a>.</p></section>`;
  }
  return fallback(doc, `No preview for ${format === "docx" ? "this DOCX" : doc.kind} files.`);
}

function fallback(doc: DocumentSummary, reason: string): string {
  const metadata = [["File", doc.filename], ["Type", doc.mime], ["Size", formatBytes(doc.sizeBytes)], ["Uploaded", doc.uploadedAt], ["ID", doc.id]];
  return `<section class="download-card"><p class="extension">${escapeHtml(fileExt(doc.filename).toUpperCase() || "FILE")}</p><h2>${escapeHtml(doc.title)}</h2><p>${escapeHtml(reason)}</p><dl>${metadata.map(([label, value]) => `<dt>${label}</dt><dd>${escapeHtml(value)}</dd>`).join("")}</dl><a class="pill primary" href="${escapeHtml(doc.downloadUrl)}">Download</a></section>`;
}

function viewerPage(doc: DocumentSummary, format: Format, body: string): string {
  const title = escapeHtml(doc.title), description = escapeHtml(`${doc.filename} · ${formatBytes(doc.sizeBytes)}`);
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${title}</title>
<meta property="og:title" content="${title}"><meta property="og:description" content="${description}"><meta property="og:url" content="${escapeHtml(doc.publicUrl)}"><meta property="og:type" content="article"><meta name="twitter:card" content="summary"><meta name="twitter:title" content="${title}"><meta name="twitter:description" content="${description}"><meta name="description" content="${description}">
<style>${VIEWER_CSS}</style></head><body><nav class="viewer-bar" aria-label="Document"><div class="viewer-top"><h1 title="${title}">${title}</h1><a href="${escapeHtml(doc.rawUrl)}">Raw</a><a class="pill primary" href="${escapeHtml(doc.downloadUrl)}">Download</a><button type="button" data-theme-toggle aria-label="Switch to dark theme">☾</button></div><p class="viewer-meta">${escapeHtml(format.toUpperCase())} · ${formatBytes(doc.sizeBytes)} · Uploaded <time datetime="${escapeHtml(doc.uploadedAt)}" data-uploaded>${escapeHtml(doc.uploadedAt)}</time></p></nav><main>${body}</main><script data-docs-viewer>${VIEWER_SCRIPT}</script></body></html>`;
}

// Shared X Business tokens are inlined because public previews cannot depend on private catalog
// assets. A later visual polish can change these styles without touching format or byte semantics.
const VIEWER_CSS = `
:root{--bg:#fff;--well:#f2f2f2;--rule:#e5e5e5;--control:#8f8f8f;--text:#111;--text-2:#555;--text-3:#767676;--accent:#2458e6;--mark:#e6edfd;color-scheme:light}
:root[data-theme=dark]{--bg:#0e0e0e;--well:#1a1a1a;--rule:#2a2a2a;--control:#6b6b6b;--text:#f2f2f2;--text-2:#b3b3b3;--text-3:#8c8c8c;--accent:#7ea2ff;--mark:#1e2a4a;color-scheme:dark}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/22px Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif}a{color:var(--accent);text-underline-offset:3px}button{font:inherit;cursor:pointer}button:focus-visible,a:focus-visible,[tabindex]:focus-visible{outline:2px solid var(--accent);outline-offset:3px}.viewer-bar{position:sticky;top:0;z-index:5;background:var(--bg);border-bottom:1px solid var(--rule);padding:0 24px 12px}.viewer-top{display:flex;align-items:center;gap:16px;min-height:56px}.viewer-top>a{display:inline-flex;align-items:center;min-height:32px;min-width:24px}.viewer-top h1{flex:1;min-width:0;margin:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:15px;line-height:22px;font-weight:500}.pill,button{display:inline-flex;align-items:center;justify-content:center;min-height:32px;padding:0 14px;border:0;border-radius:999px;text-decoration:none;background:var(--well);color:var(--text);font-size:13px;font-weight:500}.primary{background:var(--text);color:var(--bg)}.viewer-meta{margin:0;color:var(--accent);font:13px/20px "Geist Mono",ui-monospace,"SF Mono",Menlo,Consolas,monospace;overflow-wrap:anywhere}.view-options{display:flex;align-items:center;gap:16px;padding:16px 24px;color:var(--text-2)}.view-options p{margin:0}.prose{max-width:68ch;padding:32px 24px 96px;margin:auto;font-size:17px;line-height:28px;overflow-wrap:anywhere}.prose h1{font-size:32px;line-height:38px;font-weight:600;letter-spacing:-.02em}.prose h2{font-size:24px;line-height:30px;font-weight:600;margin-top:48px}.prose h3{font-size:19px;line-height:26px;font-weight:600}.prose pre{background:var(--well);padding:16px 20px;overflow:auto;font:14px/22px ui-monospace,monospace}.prose code{background:var(--well);font-family:ui-monospace,monospace}.prose img{max-width:100%;height:auto}.prose blockquote{margin-left:0;border-left:2px solid var(--rule);padding-left:20px;color:var(--text-2)}table{border-collapse:collapse;width:100%}th,td{padding:12px 16px;border-bottom:1px solid var(--rule);text-align:left;vertical-align:top;white-space:pre-wrap;overflow-wrap:anywhere}.numeric{text-align:right;font-variant-numeric:tabular-nums}.table-view{padding:16px 24px}.table-scroll{overflow:auto;max-height:calc(100vh - 180px)}thead{position:sticky;top:0;background:var(--bg)}.table-scroll table{min-width:500px}.line-view{margin:0;padding:0 24px 48px;overflow:auto;font:13px/20px "Geist Mono",ui-monospace,"SF Mono",Menlo,Consolas,monospace}.line{display:inline-flex;min-width:100%}.line-number{display:inline-block;flex:none;width:5ch;margin-right:20px;text-align:right;color:var(--text-3);user-select:none}.line-text{white-space:pre}.line:target{background:var(--mark)}.wrap .line-text{white-space:pre-wrap;overflow-wrap:anywhere;min-width:0}.wrap .line-view{white-space:normal}.notice{color:var(--text-2);padding:12px 24px;margin:0}.pdf-view iframe{display:block;border:0;width:100%;height:calc(100vh - 150px);min-height:400px}.media-stage{background:var(--well);min-height:calc(100vh - 100px);padding:24px;text-align:center;overflow:auto}.media-stage img{max-width:100%;max-height:calc(100vh - 220px);object-fit:contain}.media-stage.actual img{max-width:none;max-height:none}.media-stage video{display:block;margin:auto;max-width:100%;width:1120px;max-height:calc(100vh - 220px)}.media-stage.audio{max-width:640px;min-height:0;margin:48px auto}.media-stage audio{width:100%}.extension{font-size:64px;line-height:1.2;font-weight:300;margin:24px 0;color:var(--text-2)}.download-card{max-width:600px;margin:48px auto;padding:24px}.download-card h2{font-size:28px;line-height:36px;font-weight:600;overflow-wrap:anywhere}.download-card dl{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:8px 24px;margin:24px 0}.download-card dt{color:var(--text-2)}.download-card dd{margin:0;overflow-wrap:anywhere}[hidden]{display:none!important}@media(max-width:600px){.viewer-bar{padding-left:16px;padding-right:16px}.viewer-top{gap:10px}.prose{padding:24px 16px 64px}.view-options{padding:12px 16px;flex-wrap:wrap}.line-view{padding-left:8px;padding-right:16px}.download-card{margin:16px auto}.media-stage{padding:16px}}@media(pointer:coarse){button,.pill,.viewer-top a,.notice a{min-width:44px;min-height:44px}.viewer-top a,.notice a{display:inline-flex;align-items:center;justify-content:center}}`;

// Static program: never interpolate source text, filenames, metadata or URLs into this script.
const VIEWER_SCRIPT = `(()=>{
const root=document.documentElement,theme=document.querySelector('[data-theme-toggle]');
function setTheme(value){root.dataset.theme=value;theme.textContent=value==='dark'?'☀':'☾';theme.setAttribute('aria-label',value==='dark'?'Switch to light theme':'Switch to dark theme');try{localStorage.setItem('docs-theme',value)}catch{}}
let saved='light';try{saved=localStorage.getItem('docs-theme')==='dark'?'dark':'light'}catch{}setTheme(saved);
theme.addEventListener('click',()=>setTheme(root.dataset.theme==='dark'?'light':'dark'));
const wrap=document.querySelector('[data-wrap]');if(wrap)wrap.addEventListener('click',()=>{const on=wrap.getAttribute('aria-pressed')!=='true';wrap.setAttribute('aria-pressed',String(on));document.querySelector('.lines').classList.toggle('wrap',on)});
const actual=document.querySelector('[data-actual]');if(actual)actual.addEventListener('click',()=>{const on=actual.getAttribute('aria-pressed')!=='true';actual.setAttribute('aria-pressed',String(on));document.querySelector('.media-stage').classList.toggle('actual',on)});
const image=document.querySelector('[data-image]');if(image)image.addEventListener('click',()=>actual.click());
const media=document.querySelector('audio,video,[data-image]'),error=document.querySelector('[data-media-error]');if(media&&error){const fail=()=>{error.hidden=false};media.addEventListener('error',fail);if(media.error||(media.tagName==='IMG'&&media.complete&&media.naturalWidth===0))fail()}
for(const node of document.querySelectorAll('[data-uploaded]')){const date=new Date(node.dateTime);if(!Number.isNaN(date.getTime())){const days=Math.floor((Date.now()-date.getTime())/86400000);node.textContent=date.toLocaleString()+(days>=0?' · '+(days===0?'today':days+'d ago'):'');node.title=date.toISOString()}}
})();`;

/** Read only word/document.xml, never package relationships, images, macros or external files.
 * The ZIP directory is bounded/validated before opening the selected local entry. Raw DEFLATE is
 * fed in 256-byte steps so a lying size header cannot allocate an archive's entire expansion in
 * one inflate call. Both declared and actual XML size, checksum, entry count and XML depth are capped.
 */
function docxText(bytes: Uint8Array): string {
  const invalid = () => new PreviewFailure("This DOCX is invalid or uses an unsupported ZIP structure. Download the original.");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65557); offset--) {
    if (view.getUint32(offset, true) === 0x06054b50 && offset + 22 + view.getUint16(offset + 20, true) === bytes.length) { end = offset; break; }
  }
  if (end < 0 || view.getUint16(end + 4, true) || view.getUint16(end + 6, true)) throw invalid();
  const count = view.getUint16(end + 10, true), directorySize = view.getUint32(end + 12, true), directory = view.getUint32(end + 16, true);
  if (!count || count > 256 || count !== view.getUint16(end + 8, true) || directory + directorySize !== end) throw invalid();
  let cursor = directory;
  let selected: { offset: number; size: number; expanded: number; method: number; flags: number; crc: number } | undefined;
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > end || view.getUint32(cursor, true) !== 0x02014b50) throw invalid();
    const nameLength = view.getUint16(cursor + 28, true), extraLength = view.getUint16(cursor + 30, true), commentLength = view.getUint16(cursor + 32, true);
    const next = cursor + 46 + nameLength + extraLength + commentLength;
    if (next > end || view.getUint16(cursor + 34, true)) throw invalid();
    const name = decodeText(bytes.subarray(cursor + 46, cursor + 46 + nameLength));
    if (name === "word/document.xml") {
      if (selected) throw invalid();
      selected = { offset: view.getUint32(cursor + 42, true), size: view.getUint32(cursor + 20, true), expanded: view.getUint32(cursor + 24, true), method: view.getUint16(cursor + 10, true), flags: view.getUint16(cursor + 8, true), crc: view.getUint32(cursor + 16, true) };
    }
    cursor = next;
  }
  if (cursor !== end || !selected) throw invalid();
  const entry = selected;
  if (entry.expanded > DOCX_XML_BYTES) throw new PreviewFailure("This DOCX exceeds the 1 MB expanded XML preview limit. Download the original.");
  if (entry.flags & 1 || ![0, 8].includes(entry.method) || entry.offset + 30 > directory) throw invalid();
  if (view.getUint32(entry.offset, true) !== 0x04034b50 || view.getUint16(entry.offset + 6, true) !== entry.flags || view.getUint16(entry.offset + 8, true) !== entry.method) throw invalid();
  const nameLength = view.getUint16(entry.offset + 26, true), extraLength = view.getUint16(entry.offset + 28, true);
  const start = entry.offset + 30 + nameLength + extraLength;
  if (start + entry.size > directory || decodeText(bytes.subarray(entry.offset + 30, entry.offset + 30 + nameLength)) !== "word/document.xml") throw invalid();
  const compressed = bytes.subarray(start, start + entry.size);
  let xml: Uint8Array;
  if (entry.method === 0) {
    if (compressed.length > DOCX_XML_BYTES) throw new PreviewFailure("This DOCX exceeds the expanded XML preview limit. Download the original.");
    xml = compressed;
  } else {
    const chunks: Uint8Array[] = [];
    let size = 0, complete = false;
    const inflate = new Inflate((chunk, final) => {
      size += chunk.length;
      if (size > DOCX_XML_BYTES) throw new PreviewFailure("This DOCX exceeds the expanded XML preview limit. Download the original.");
      chunks.push(chunk); complete = final;
    });
    try {
      for (let offset = 0; offset < compressed.length; offset += 256) inflate.push(compressed.subarray(offset, offset + 256), offset + 256 >= compressed.length);
    } catch (error) { if (error instanceof PreviewFailure) throw error; throw invalid(); }
    if (!complete) throw invalid();
    xml = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { xml.set(chunk, offset); offset += chunk.length; }
  }
  if (xml.length !== entry.expanded || crc32(xml) !== entry.crc) throw invalid();
  return wordText(decodeText(xml));
}

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Conservative WordprocessingML text reader: no DOM, entity expansion, relationship resolution
 * or HTML conversion. Only w:t and paragraph/table separators are emitted, then HTML-escaped by
 * linesBody. Unsupported/malformed XML fails closed to the original download, never partial markup.
 */
function wordText(xml: string): string {
  const invalid = () => new PreviewFailure("This DOCX has invalid or unsupported document XML. Download the original.");
  const tokens = /<!--[\s\S]*?-->|<\?xml\s[\s\S]*?\?>|<(?:[^<>"']|"[^"]*"|'[^']*')*>|[^<]+/gy;
  const stack: string[] = [], output: string[] = [];
  let offset = 0, nodes = 0, root = false, body = false;
  while (offset < xml.length) {
    tokens.lastIndex = offset;
    const match = tokens.exec(xml);
    if (!match || ++nodes > 50000) throw invalid();
    const token = match[0]; offset = tokens.lastIndex;
    if (token.startsWith("<!--")) continue;
    if (token.startsWith("<?xml")) { if (root) throw invalid(); continue; }
    if (!token.startsWith("<")) {
      if (stack[stack.length - 1] === "w:t") output.push(xmlEntities(token));
      else if (!stack.length && token.trim()) throw invalid();
      continue;
    }
    if (token.startsWith("</")) {
      const closing = /^<\/([\w:.-]+)\s*>$/.exec(token);
      if (!closing || stack.pop() !== closing[1]) throw invalid();
      if (closing[1] === "w:p" || closing[1] === "w:tr") output.push("\n");
      else if (closing[1] === "w:tc") output.push("\t");
      continue;
    }
    const opening = /^<([A-Za-z_][\w:.-]*)(?:\s|\/?\>)/.exec(token);
    if (!opening) throw invalid(); // Includes DTDs, entity declarations, CDATA and processing instructions.
    const name = opening[1], selfClosing = token.endsWith("/>");
    if (!stack.length) {
      if (root || name !== "w:document" || !/\sxmlns:w\s*=\s*(["'])(?:http:\/\/schemas\.openxmlformats\.org\/wordprocessingml\/2006\/main|http:\/\/purl\.oclc\.org\/ooxml\/wordprocessingml\/main)\1/.test(token)) throw invalid();
      root = true;
    }
    if (name === "w:body") body = true;
    if (name === "w:tab") output.push("\t");
    if (name === "w:br" || name === "w:cr") output.push("\n");
    if (!selfClosing) stack.push(name);
    if (stack.length > 64) throw invalid();
  }
  if (stack.length || !root || !body) throw invalid();
  return output.join("").trim();
}
function xmlEntities(text: string): string {
  return text.replace(/&([^&;]*);|&/g, (_entity, name: string | undefined) => {
    const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
    if (name && Object.hasOwn(named, name)) return named[name];
    if (name && /^#(?:x[\da-f]+|\d+)$/i.test(name)) {
      const code = name[1].toLowerCase() === "x" ? parseInt(name.slice(2), 16) : Number(name.slice(1));
      if (code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) && (code >= 32 || [9, 10, 13].includes(code))) return String.fromCodePoint(code);
    }
    throw new PreviewFailure("This DOCX has an invalid XML entity. Download the original.");
  });
}
