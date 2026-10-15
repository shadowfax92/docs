import type { UploadId } from "./contracts";
import { runtimeScript, runtimeStyle } from "./vendor/vim-html/generated";

/** Stable public identity; baked vim-html source/storage identity always takes precedence. */
export interface DocumentIdentity { id: UploadId; title: string; publicUrl: string }

// Bounded inspection is necessary before any injection: a baked runtime or CSP
// can appear at the very end. Never tee a large R2 body (an unread tee buffers it).
const MAX_HTML_BYTES = 4 * 1024 * 1024;
const encoder = new TextEncoder();

/** Add the offline skill runtime behind Preview's HTML-only seam.
 * Dependencies are in-process vendored strings and a one-shot response stream.
 * Inspect at most 4 MiB before choosing; larger/unsupported pages replay exactly,
 * cancellation reaches the source, and read errors propagate without truncation.
 * Raw/download callers must bypass this module. No CSP is weakened to add keys.
 */
export async function enhanceHtml(response: Response, identity: DocumentIdentity): Promise<Response> {
  const headers = response.headers;
  if (!response.body || response.status !== 200 ||
      !/^text\/html(?:\s*;|$)/i.test(headers.get("Content-Type") || "") ||
      /charset\s*=\s*["']?(?!utf-8\b|utf8\b)[\w-]+/i.test(headers.get("Content-Type") || "") ||
      !permitsInlineLayer(headers.get("Content-Security-Policy")) || headers.has("Content-Range") ||
      /attachment/i.test(headers.get("Content-Disposition") || "") ||
      /\bno-transform\b/i.test(headers.get("Cache-Control") || "") ||
      (headers.has("Content-Encoding") && headers.get("Content-Encoding") !== "identity")) return response;

  const reader = response.body.getReader();
  let buffer = new Uint8Array(64 * 1024);
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      if (size + next.value.byteLength > MAX_HTML_BYTES) {
        // Only two chunks are retained regardless of source chunk granularity.
        // An array of millions of tiny chunks can exceed the byte budget itself.
        const prefix = [buffer.subarray(0, size), next.value];
        return new Response(new ReadableStream<Uint8Array>({
          async pull(controller) {
            const chunk = prefix.shift();
            if (chunk) { controller.enqueue(chunk); return; }
            try {
              const rest = await reader.read();
              if (rest.done) { reader.releaseLock(); controller.close(); }
              else controller.enqueue(rest.value);
            } catch (error) { reader.releaseLock(); controller.error(error); }
          },
          cancel(reason) { prefix.length = 0; return reader.cancel(reason); },
        }), response);
      }
      if (size + next.value.byteLength > buffer.length) {
        const grown = new Uint8Array(Math.min(MAX_HTML_BYTES, Math.max(size + next.value.byteLength, buffer.length * 2)));
        grown.set(buffer.subarray(0, size));
        buffer = grown;
      }
      buffer.set(next.value, size);
      size += next.value.byteLength;
    }
  } catch (error) { reader.releaseLock(); throw error; }
  reader.releaseLock();
  const bytes = buffer.subarray(0, size);

  let html: string;
  try { html = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes); }
  catch { return new Response(bytes, response); }
  if (!canEnhance(html)) return new Response(bytes, response);

  // JSON is script data, never markup. Escaping every '<' also prevents the HTML
  // parser's comment/double-escaped script states, not just literal end tags.
  const config = JSON.stringify({
    source: identity.publicUrl,
    storageKey: `docs:${identity.publicUrl}`,
    docTitle: identity.title,
    theme: "none", scheme: "light", debug: false,
  }).replace(/</g, "\\u003c")
    .replace(/[\u007f-\uffff]/g, ch => "\\u" + ch.charCodeAt(0).toString(16).padStart(4, "0"));
  const suffix = encoder.encode(`\n<!-- vim-html:head:begin -->\n<style data-vh="theme">${runtimeStyle}</style>\n<!-- vim-html:head:end -->\n<!-- vim-html:body:begin -->\n<script data-vh="config">window.VIM_HTML=Object.assign(${config},window.VIM_HTML||{});</script>\n<script data-vh="runtime">${runtimeScript}</script>\n<!-- vim-html:body:end -->`);
  const updated = new Headers(headers);
  // Validators describe source bytes. Reusing them for an altered representation
  // can produce a false 304 or truncate a response at the old Content-Length.
  for (const name of ["Content-Length", "ETag", "Content-MD5", "Digest", "Content-Digest", "Accept-Ranges"]) updated.delete(name);
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(bytes); controller.enqueue(suffix); controller.close(); },
  }), { status: response.status, statusText: response.statusText, headers: updated });
}

/** Recognize CSP permission, never grant it. Generated previews explicitly allow
 * inline scripts/styles; source policies may instead require a nonce/hash. CSP3
 * intersects comma-separated policies, takes the first duplicate directive, and
 * lets *-src-elem override *-src/default-src. Unknown restrictive mechanisms are
 * declined rather than minting nonces or changing the authored policy.
 * Reference: https://www.w3.org/TR/CSP/#allow-all-inline
 */
function permitsInlineLayer(csp: string | null): boolean {
  if (csp === null) return true;
  // CSP tokenization uses ASCII whitespace, unlike JavaScript's \s/trim. A
  // Unicode space must not turn an invalid directive into a permissive first
  // duplicate and hide the browser's effective restrictive directive.
  if (/[^\t\x20-\x7e]/.test(csp)) return false;
  return csp.split(",").every(policy => {
    const directives = new Map<string, string[]>();
    for (const directive of policy.split(";")) {
      const [name, ...values] = directive.trim().toLowerCase().split(/[ \t]+/);
      if (name && !directives.has(name)) directives.set(name, values);
    }
    if (directives.has("sandbox") || directives.has("require-trusted-types-for")) return false;
    return ["script", "style"].every(kind => {
      const values = directives.get(`${kind}-src-elem`) ?? directives.get(`${kind}-src`) ?? directives.get("default-src");
      return values === undefined || (values.includes("'unsafe-inline'") &&
        !values.some(value => /^'(?:nonce-|sha(?:256|384|512)-|strict-dynamic'|none')/.test(value)));
    });
  });
}

/** Conservative lexical inspection, not HTML sanitization. Source is never
 * rewritten: the ASCII layer follows EOF, which works with optional head/body
 * tags and fragments. Decline contexts that would swallow it as text or inert
 * content. False positives leave a page usable; false negatives risk two cores.
 */
function canEnhance(html: string): boolean {
  if (/vim-html:(?:head|body):(?:begin|end)|\bdata-vh\s*=|\b(?:window\.)?(?:VIM_HTML|__VH)\b/i.test(html)) return false;
  let at = 0;
  const inertTags: string[] = [];
  const token = /<!--|<!\[CDATA\[|<\/?[a-z][\w:-]*(?=[\s/>])|<!|<\?/ig;
  for (;;) {
    token.lastIndex = at;
    const match = token.exec(html);
    if (!match) return inertTags.length === 0 && html.lastIndexOf("<") <= html.lastIndexOf(">");
    const start = match.index;
    if (match[0] === "<!--") {
      const end = html.indexOf("-->", token.lastIndex);
      if (end < 0) return false;
      at = end + 3;
      continue;
    }
    // Attribute quotes can contain '>' and fake tags; do not scan inside them.
    let quote = "";
    let end = token.lastIndex;
    for (; end < html.length; end++) {
      const ch = html[end];
      if (quote) { if (ch === quote) quote = ""; }
      else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === ">") break;
    }
    if (end === html.length) return false;
    const tag = match[0].toLowerCase();
    if (tag === "<meta" && /content-security-policy/i.test(html.slice(start, end + 1))) return false;
    if (tag === "<plaintext" || tag === "<frameset" || tag === "<![cdata[") return false;
    // A legacy encoding declaration controls the browser even without an HTTP
    // charset. Leave it alone rather than append UTF-8 assumptions to that page.
    if (tag === "<meta" && /charset\s*=/i.test(html.slice(start, end + 1)) &&
        !/charset\s*=\s*["']?utf-?8\b/i.test(html.slice(start, end + 1))) return false;
    if (/^<\/?(?:template|svg|math|select)$/.test(tag)) {
      // Different inert contexts cannot balance one another. An unmatched
      // </svg>, for example, does not close an outstanding HTML <template>.
      if (tag.startsWith("</")) {
        if (inertTags.pop() !== tag.slice(2)) return false;
      } else inertTags.push(tag.slice(1));
    }
    at = end + 1;
    if (/^<(?:script|style|title|textarea|xmp|iframe|noembed|noframes|noscript)$/.test(tag)) {
      const close = new RegExp(`</${tag.slice(1)}\\s*>`, "ig");
      close.lastIndex = at;
      const closing = close.exec(html);
      if (!closing) return false;
      // In script's legacy double-escaped state an apparent </script> may only
      // leave that state, rather than close the element. Decline nested script
      // text instead of attempting the browser's full script tokenizer here.
      if (tag === "<script" && /<script(?=[\s/>])/i.test(html.slice(at, closing.index))) return false;
      at = close.lastIndex;
    }
  }
}
