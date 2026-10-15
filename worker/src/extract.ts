import type { TextRecord } from "./contracts";
import type { ResolvedDocument } from "./documents";

/** Future bounded, in-process parser seam. Never executes uploads or calls external converters.
 * Unsupported/limited/error coverage is data, not an empty full-text success. The skeleton reads no body.
 */
export async function extractText(doc: ResolvedDocument): Promise<TextRecord> {
  return {
    version: 1, id: doc.summary.id, documentVersion: doc.summary.version,
    coverage: "metadata-only", reason: "Content extraction is unavailable in this skeleton.",
    text: "", sourceBytes: doc.summary.sizeBytes, indexedBytes: 0, extractorVersion: 1,
  };
}
