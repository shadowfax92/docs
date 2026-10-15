import type { CatalogError, TextRecord } from "./contracts";
import type { Documents, ResolvedDocument } from "./documents";

export interface CatalogSecurity {
  catalogOrigin: string;
  publicOrigin: string;
  password: string;
  sessionKey: string;
}

/** HTTP-shaped seam owns future auth, private headers and bulk orchestration. R2 is external;
 * assets/extraction are in-process. Authenticate before R2, bound request work, preserve per-ID errors.
 * This skeleton rejects every route before reading storage, issuing cookies or serving any asset.
 */
export function createCatalog(_deps: {
  documents: Documents;
  bucket: R2Bucket;
  security: CatalogSecurity;
  extract: (doc: ResolvedDocument) => Promise<TextRecord>;
  assets: (path: string) => Response | null;
}): { fetch(request: Request): Promise<Response> } {
  return {
    async fetch() {
      return Response.json({
        version: 1,
        error: { code: "catalog_unavailable", message: "The private library is not available yet.", retryable: false },
      } satisfies CatalogError, {
        status: 503,
        headers: {
          "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow, noarchive",
          "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY",
          "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
        },
      });
    },
  };
}
