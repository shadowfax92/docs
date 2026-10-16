/**
 * What a search result card says about how much of a document's content the search covered.
 *
 * Only the extractor knows why coverage is partial: a source-prefix cap, an output-text cap, DOCX
 * main-document scope, primary-object-only extraction of a multi-object ID, an unsupported format
 * or a parse error. The library index stores that free text as `LibraryMetadata.reason`, beside
 * the document's index state, and catalog-client.ts keeps it in the metadata snapshot. The card
 * therefore pairs a neutral label (never "first N bytes" or a percentage of the source) with that
 * reason. Rows the index hasn't extracted yet (pending, including a paused size budget) or couldn't
 * extract (failed) were matched by title and filename only, and say so. app.ts uses this one
 * function both to render the card and to build the grid's re-render key, so a coverage or reason
 * update always rebuilds the card.
 */
import type { LibraryMetadata } from "../library-contracts";
import { formatBytes } from "./catalog-client";

export interface CoverageNote {
  /** Short status in the card's note style, e.g. "512 KB of text searched" or "name match only". */
  label: string;
  /** The extractor's explanation on one line, at most REASON_DISPLAY_CHARS; null when absent. */
  reason: string | null;
}

/** Room for every extractor reason combined, DOCX scope included (under 300 characters), uncut. */
export const REASON_DISPLAY_CHARS = 320;
// Normalizing work is bounded by the prefix scanned, however long a malformed reason is.
const REASON_SCAN_UNITS = REASON_DISPLAY_CHARS * 4;

/** Returns null for fully indexed text and for unknown documents: those cards stay unchanged. */
export function coverageNote(index: LibraryMetadata | null): CoverageNote | null {
  if (!index) return null;
  if (index.state === "pending") return { label: "content not indexed yet · name searched", reason: displayReason(index.reason) };
  if (index.state === "failed") return { label: "content couldn't be indexed · name searched", reason: displayReason(index.reason) };
  if (index.state !== "indexed") return null;
  switch (index.coverage) {
    case "truncated":
      // indexedBytes measures extracted UTF-8 text, not a share or prefix of the stored file.
      return { label: `${formatBytes(index.indexedBytes)} of text searched`, reason: displayReason(index.reason) };
    case "metadata-only":
      return { label: "name match only", reason: displayReason(index.reason) };
    case "error":
      return { label: "content unreadable · name only", reason: displayReason(index.reason) };
    default:
      return null;
  }
}

/**
 * Collapses whitespace and control characters to single spaces and caps the result by code point,
 * so a cut never leaves half a surrogate pair. The result is plain text for a text node; markup in a
 * reason stays literal characters. Non-string values (a malformed record) count as no reason.
 */
function displayReason(reason: unknown): string | null {
  if (typeof reason !== "string") return null;
  let cut = reason.length > REASON_SCAN_UNITS;
  let text = (cut ? reason.slice(0, REASON_SCAN_UNITS) : reason).replace(/[\s\p{Cc}]+/gu, " ").trim();
  const points = Array.from(text);
  if (points.length > REASON_DISPLAY_CHARS) {
    text = points.slice(0, REASON_DISPLAY_CHARS - 1).join("").trimEnd();
    cut = true;
  }
  if (cut) text = `${text.replace(/[\uD800-\uDBFF]$/, "")}…`;
  return text && text !== "…" ? text : null;
}
