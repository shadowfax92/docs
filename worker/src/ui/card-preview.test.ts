import { describe, expect, it } from "vitest";
import type { DocumentSummary } from "../contracts";
import { PREVIEW_MAX_BYTES, previewKey, previewSource } from "./card-preview";

const PUBLIC = "https://docs.example";
const CATALOG = "https://library.example";

// Shaped like the catalog's own summaries: Documents builds every URL from PUBLIC_DOCS_ORIGIN.
function doc(patch: Partial<DocumentSummary> = {}): DocumentSummary {
  return {
    id: "Ab12Cd34", version: "v1", title: "Brief", filename: "brief.html", kind: "html", mime: "text/html",
    sizeBytes: 2_600, uploadedAt: "2026-10-14T00:00:00Z", timeSource: "r2", createdAt: null,
    publicUrl: `${PUBLIC}/Ab12Cd34`, rawUrl: `${PUBLIC}/Ab12Cd34/raw`, downloadUrl: `${PUBLIC}/Ab12Cd34/download`,
    objectCount: 1, warnings: [], ...patch,
  };
}

describe("previewSource", () => {
  it("frames exactly the document's own public raw route", () => {
    expect(previewSource(doc(), CATALOG)).toBe(`${PUBLIC}/Ab12Cd34/raw`);
    expect(previewSource(doc({ filename: "page.HTM" }), CATALOG)).toBe(`${PUBLIC}/Ab12Cd34/raw`);
  });

  it("keeps compact cards for non-HTML, empty and oversized documents", () => {
    for (const kind of ["markdown", "text", "data", "pdf", "image", "archive", "office", "binary"] as const) {
      expect(previewSource(doc({ kind }), CATALOG)).toBeNull();
    }
    // Kind and extension must agree: the raw route picks its Content-Type from the extension.
    expect(previewSource(doc({ filename: "brief.txt" }), CATALOG)).toBeNull();
    expect(previewSource(doc({ sizeBytes: 0 }), CATALOG)).toBeNull();
    expect(previewSource(doc({ sizeBytes: PREVIEW_MAX_BYTES }), CATALOG)).toBe(`${PUBLIC}/Ab12Cd34/raw`);
    expect(previewSource(doc({ sizeBytes: PREVIEW_MAX_BYTES + 1 }), CATALOG)).toBeNull();
    expect(previewSource(doc({ sizeBytes: Number.NaN }), CATALOG)).toBeNull();
  });

  it("refuses any URL that is not the expected raw identity", () => {
    const rejected: Partial<DocumentSummary>[] = [
      { rawUrl: `${PUBLIC}/Ab12Cd34` },                          // the vim-enhanced page route
      { rawUrl: `${PUBLIC}/Ab12Cd34/download` },
      { rawUrl: `${PUBLIC}/Zz99Yy88/raw` },                      // another document's bytes
      { rawUrl: `${PUBLIC}/Ab12Cd34/raw?x=1` },
      { rawUrl: `${PUBLIC}/Ab12Cd34/raw#top` },
      { rawUrl: `${PUBLIC}/Ab12Cd34/raw#` },
      { rawUrl: `${PUBLIC}/Ab12Cd34/raw/` },
      { rawUrl: `${PUBLIC}/x/../Ab12Cd34/raw` },                 // normalizes, but is not what Documents writes
      { rawUrl: "https://user:pass@docs.example/Ab12Cd34/raw" },
      { rawUrl: "https://evil.example/Ab12Cd34/raw" },           // origin differs from the public page
      { rawUrl: `${CATALOG}/Ab12Cd34/raw`, publicUrl: `${CATALOG}/Ab12Cd34` }, // never the catalog itself
      { rawUrl: "javascript:alert(1)//Ab12Cd34/raw" },
      { rawUrl: "data:text/html,<p>x</p>" },
      { rawUrl: "not a url" },
      { publicUrl: "not a url" },
      { publicUrl: `${PUBLIC}/Ab12Cd34/` },                     // page URL must be exact too
      { publicUrl: `${PUBLIC.toUpperCase()}/Ab12Cd34`, rawUrl: `${PUBLIC.toUpperCase()}/Ab12Cd34/raw` },
      { publicUrl: "javascript:x/Ab12Cd34", rawUrl: "javascript:x/Ab12Cd34/raw" },
      { id: "../../x", rawUrl: `${PUBLIC}/../../x/raw` },
      { id: "short", rawUrl: `${PUBLIC}/short/raw` },
    ];
    for (const patch of rejected) expect(previewSource(doc(patch), CATALOG), JSON.stringify(patch)).toBeNull();
  });

  it("keys cached preview nodes by document version", () => {
    expect(previewKey(doc())).toBe("Ab12Cd34:v1");
    expect(previewKey(doc({ version: "v2" }))).not.toBe(previewKey(doc()));
  });
});
