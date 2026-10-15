import { assets } from "../.wrangler/generated/catalog-assets";

/** Trusted build-time assets only; Catalog owns authorization before calling this allowlist.
 * No R2 fallback, pathname-to-file lookup, runtime CDN, or upload markup can enter this seam.
 */
export function catalogAssets(path: string): Response | null {
  const asset = Object.hasOwn(assets, path) ? assets[path] : undefined;
  if (!asset) return null;
  return new Response(asset.body, {
    headers: { "Content-Type": asset.type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });
}
