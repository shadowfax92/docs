import type { TextRecord } from "./contracts";
import type { ResolvedDocument } from "./documents";
import { decodeHTML } from "entities";

const SOURCE_LIMIT = 2 * 1024 * 1024;
const TEXT_LIMIT = 512 * 1024;
const ELEMENT_LIMIT = 32768;
const encoder = new TextEncoder();

/** Extracts the immutable primary body for both legacy and new uploads, without execution or I/O
 * beyond Documents.openBody. Input is at most 2 MiB (+ one truncation sentinel); output is at most
 * 512 KiB UTF-8. Unsupported formats and parser/read failures retain metadata with explicit coverage.
 */
export async function extractText(doc: ResolvedDocument): Promise<TextRecord> {
  const record: TextRecord = {
    version: 1, id: doc.summary.id, documentVersion: doc.summary.version,
    coverage: "metadata-only", reason: null,
    text: "", sourceBytes: doc.summary.sizeBytes, indexedBytes: 0, extractorVersion: 1,
  };
  const { kind, mime, filename } = doc.summary;
  // Neither a compressed-byte cap nor a PDF page count bounds a parser's internal inflation.
  // Keep these seams honest until expansion/page/CPU limits are enforceable, not just a bundle smoke.
  if (kind === "pdf" || /\.pdf$/i.test(filename)) {
    return { ...record, reason: "PDF text extraction is not enabled: bounded stream expansion and page parsing are not yet verified. No OCR is performed." };
  }
  if (kind === "office" || /\.(?:docx?|xlsx?|pptx?|odt)$/i.test(filename)) {
    return { ...record, reason: "Office text extraction is not enabled: actual ZIP expansion and XML parser limits are not yet verified." };
  }
  const sourceFile = /\.(?:txt|md|markdown|mdx|html?|jsonl?|ndjson|csv|tsv|xml|ya?ml|toml|ini|conf|cfg|properties|log|sh|bash|zsh|fish|py|rb|go|rs|c|h|cpp|hpp|cs|fsx?|java|[cm]?js|jsx|[cm]?ts|tsx|css|scss|less|sql|graphql|vue|svelte|lua|vim|el|clj|exs?|erl|hrl|hs|ml|mli|php|pl|pm|r|jl|swift|kts?|scala|dart|tex|rst)$/i.test(filename)
    || /^(?:makefile|dockerfile|gemfile|rakefile|\.(?:gitignore|gitattributes|editorconfig|env))$/i.test(filename);
  const textMime = /^(?:text\/|application\/(?:json|[\w.+-]+\+json|xml|[\w.+-]+\+xml|javascript|x-javascript|typescript|sql|yaml|x-yaml)(?:;|$))/i.test(mime);
  if (!["html", "markdown", "text", "data"].includes(kind) && !sourceFile && !textMime) {
    return { ...record, reason: "This format is searched by name and title only; content extraction is unsupported." };
  }
  const charset = /charset\s*=\s*["']?([^\s;"']+)/i.exec(mime)?.[1]?.toLowerCase();
  if (charset && !["utf-8", "utf8", "us-ascii", "ascii"].includes(charset)) {
    return { ...record, reason: "Only UTF-8 source text is supported; the declared encoding is unsupported." };
  }
  try {
    const body = await doc.openBody({ maxBytes: SOURCE_LIMIT + 1 });
    if (!body) return { ...record, coverage: "error", reason: "The document was removed before its text could be read." };
    const input = await readPrefix(body.body, SOURCE_LIMIT + 1);
    const sourceTruncated = input.truncated || input.bytes.length > SOURCE_LIMIT
      || (doc.objects[0]?.sizeBytes ?? doc.summary.sizeBytes) > SOURCE_LIMIT;
    let source: string;
    try {
      // A source cutoff may bisect a UTF-8 code point: streaming decode drops only that unfinished
      // suffix. Invalid bytes anywhere before it still fail, rather than silently replacing text.
      source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(input.bytes.subarray(0, SOURCE_LIMIT), { stream: sourceTruncated });
    } catch {
      return { ...record, coverage: "error", reason: "The source is not valid UTF-8 text." };
    }
    if (/[\u0000-\u0008\u000b\u000e-\u001f]/u.test(source)) {
      return { ...record, reason: "The source contains binary control bytes; only its name and title are searchable." };
    }
    const html = kind === "html" || /^text\/html(?:;|$)/i.test(mime) || /\.html?$/i.test(filename);
    const text = html ? await htmlText(source) : source;
    const output = new Uint8Array(TEXT_LIMIT);
    // encodeInto never splits a Unicode scalar value; indexedBytes measures actual UTF-8 output.
    const { read, written } = encoder.encodeInto(text, output);
    const reasons: string[] = [];
    if (sourceTruncated) reasons.push("Only the first 2 MiB of source bytes were read.");
    if (read < text.length) reasons.push("Extracted text was limited to 512 KiB UTF-8.");
    if (doc.summary.objectCount > 1) reasons.push("Only the primary object of this multi-object document was extracted.");
    return {
      ...record, coverage: reasons.length ? "truncated" : "full", reason: reasons.join(" ") || null,
      text: new TextDecoder().decode(output.subarray(0, written)), indexedBytes: written,
    };
  } catch {
    // Object keys, parser stacks and storage details are private. Coverage still discloses failure.
    return { ...record, coverage: "error", reason: "The document could not be read or parsed within the extraction limits." };
  }
}

/** Owns reader cancellation at the body seam, including read failures and unexpected overlong data. */
async function readPrefix(stream: ReadableStream<Uint8Array>, limit: number): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  const reader = stream.getReader();
  const bytes = new Uint8Array(limit);
  let length = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) return { bytes: bytes.subarray(0, length), truncated: false };
      const remaining = limit - length;
      bytes.set(chunk.value.subarray(0, remaining), length);
      length += Math.min(remaining, chunk.value.length);
      if (length === limit) return { bytes, truncated: true };
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function htmlText(source: string): Promise<string> {
  let elements = 0;
  let suppressed = 0;
  const chunks: string[] = [];
  const excluded = new Set(["script", "style", "template", "noscript"]);
  const rewriter = new HTMLRewriter().on("*", {
    element(element) {
      if (++elements > ELEMENT_LIMIT) throw new Error("HTML element budget exceeded");
      if (excluded.has(element.tagName.toLowerCase())) {
        if (!suppressed) chunks.push(" ");
        suppressed++;
        element.onEndTag(() => { suppressed--; if (!suppressed) chunks.push(" "); });
        return;
      }
      // The parser owns nesting/end-tag correlation; no uploaded script executes. Separators at
      // both ends prevent adjacent elements from fusing words, without splitting streamed chunks.
      if (!suppressed) chunks.push(" ");
      element.onEndTag(() => { if (!suppressed) chunks.push(" "); });
    },
  }).onDocument({ text(chunk) { if (!suppressed) chunks.push(chunk.text); } });
  const transformed = rewriter.transform(new Response(source, { headers: { "Content-Type": "text/html; charset=utf-8" } }));
  // Pulling the transformed body drives native parsing. Discard serialized markup; only text
  // callbacks contribute to search. The collected text is bounded by source + two spaces/element.
  const reader = transformed.body!.getReader();
  try { while (!(await reader.read()).done) { /* Drain without retaining serialized uploads. */ } }
  finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  return decodeHTML(chunks.join("")).replace(/\s+/gu, " ").trim();
}
