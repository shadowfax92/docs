import type { UploadId } from "./contracts";

/** Stable public identity for the later vendored vim-html runtime; never pass catalog credentials. */
export interface DocumentIdentity { id: UploadId; title: string; publicUrl: string }

/** Pass-through until the runtime owner adds idempotent, self-hosted --theme none enhancement.
 * Preview calls this only for HTML pages. Raw/download bytes and existing baked identity stay intact.
 */
export async function enhanceHtml(response: Response, _documentIdentity: DocumentIdentity): Promise<Response> {
  return response;
}
