import { Inflate } from "fflate";

export const DOCX_SOURCE_LIMIT = 2 * 1024 * 1024;
const DOCX_XML_BYTES = 1024 * 1024;

/** Expected bounded-parser rejection; callers retain metadata and original-byte access. */
export class DocumentTextFailure extends Error {}

/** Read only word/document.xml, never package relationships, images, macros or external files.
 * The ZIP directory is bounded/validated before opening the selected local entry. Raw DEFLATE is
 * fed in 256-byte steps so a lying size header cannot allocate an archive's entire expansion in
 * one inflate call. Both declared and actual XML size, checksum, entry count and XML depth are capped.
 */
export function docxText(bytes: Uint8Array): string {
  if (bytes.length > DOCX_SOURCE_LIMIT) throw new DocumentTextFailure("This DOCX exceeds the 2 MiB source limit. Download the original.");
  const invalid = () => new DocumentTextFailure("This DOCX is invalid or uses an unsupported ZIP structure. Download the original.");
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
  if (entry.expanded > DOCX_XML_BYTES) throw new DocumentTextFailure("This DOCX exceeds the 1 MB expanded XML preview limit. Download the original.");
  if (entry.flags & 1 || ![0, 8].includes(entry.method) || entry.offset + 30 > directory) throw invalid();
  if (view.getUint32(entry.offset, true) !== 0x04034b50 || view.getUint16(entry.offset + 6, true) !== entry.flags || view.getUint16(entry.offset + 8, true) !== entry.method) throw invalid();
  const nameLength = view.getUint16(entry.offset + 26, true), extraLength = view.getUint16(entry.offset + 28, true);
  const start = entry.offset + 30 + nameLength + extraLength;
  if (start + entry.size > directory || decodeText(bytes.subarray(entry.offset + 30, entry.offset + 30 + nameLength)) !== "word/document.xml") throw invalid();
  const compressed = bytes.subarray(start, start + entry.size);
  let xml: Uint8Array;
  if (entry.method === 0) {
    if (compressed.length > DOCX_XML_BYTES) throw new DocumentTextFailure("This DOCX exceeds the expanded XML preview limit. Download the original.");
    xml = compressed;
  } else {
    const chunks: Uint8Array[] = [];
    let size = 0, complete = false;
    const inflate = new Inflate((chunk, final) => {
      size += chunk.length;
      if (size > DOCX_XML_BYTES) throw new DocumentTextFailure("This DOCX exceeds the expanded XML preview limit. Download the original.");
      chunks.push(chunk); complete = final;
    });
    try {
      for (let offset = 0; offset < compressed.length; offset += 256) inflate.push(compressed.subarray(offset, offset + 256), offset + 256 >= compressed.length);
    } catch (error) { if (error instanceof DocumentTextFailure) throw error; throw invalid(); }
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
  const invalid = () => new DocumentTextFailure("This DOCX has invalid or unsupported document XML. Download the original.");
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
    throw new DocumentTextFailure("This DOCX has an invalid XML entity. Download the original.");
  });
}

// ZIP names and XML must be strict UTF-8. No decoding fallback or binary replacement can turn an
// invalid package into successful partial text. Preview and search share this validation contract.
function decodeText(bytes: Uint8Array): string {
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes); }
  catch { throw new DocumentTextFailure("This DOCX contains invalid UTF-8. Download the original."); }
  if (/[\x00-\x08\x0b\x0e-\x1f]/.test(text)) throw new DocumentTextFailure("This DOCX contains binary XML. Download the original.");
  return text;
}
