import { describe, expect, it } from "vitest";
import type { ContentState } from "./catalog-client";
import { REASON_DISPLAY_CHARS, coverageNote } from "./coverage-note";

// Reason strings as the catalog extractor writes them; the UI must show them verbatim, not guess.
const SOURCE_CAP = "Only the first 2 MiB of source bytes were read.";
const TEXT_CAP = "Extracted text was limited to 512 KiB UTF-8.";
const DOCX_SCOPE = "Only DOCX main-document text was extracted; headers, images, embedded objects and Word layout are not included.";
const PRIMARY_ONLY = "Only the primary object of this multi-object document was extracted.";
const PDF = "PDF text extraction is not enabled: bounded stream expansion and page parsing are not yet verified. No OCR is performed.";
const PARSE = "DOCX could not be parsed within the bounded ZIP/XML limits.";

function indexed(coverage: "full" | "truncated" | "metadata-only" | "error", reason: unknown, indexedBytes = 0): ContentState {
  return { status: "indexed", coverage, indexedBytes, reason } as ContentState;
}

describe("coverageNote", () => {
  it("labels partial text by the amount searched and keeps the extractor's DOCX scope reason", () => {
    expect(coverageNote(indexed("truncated", DOCX_SCOPE, 145_408))).toEqual({ label: "142 KB of text searched", reason: DOCX_SCOPE });
  });

  it("never claims a source prefix was searched", () => {
    for (const reason of [DOCX_SCOPE, PRIMARY_ONLY, `${SOURCE_CAP} ${TEXT_CAP}`]) {
      const note = coverageNote(indexed("truncated", reason, 524_288));
      expect(note?.label).toBe("512 KB of text searched");
      expect(note?.label).not.toMatch(/first|%/);
    }
  });

  it("shows every combined extractor reason uncut", () => {
    const combined = [SOURCE_CAP, TEXT_CAP, DOCX_SCOPE, PRIMARY_ONLY].join(" ");
    expect(combined.length).toBeLessThan(REASON_DISPLAY_CHARS);
    expect(coverageNote(indexed("truncated", combined, 1))?.reason).toBe(combined);
  });

  it("keeps the name-only and unreadable labels and adds their reasons", () => {
    expect(coverageNote(indexed("metadata-only", PDF))).toEqual({ label: "name match only", reason: PDF });
    expect(coverageNote(indexed("error", PARSE))).toEqual({ label: "content unreadable · name only", reason: PARSE });
  });

  it("leaves full coverage and unsettled documents without a note", () => {
    expect(coverageNote(indexed("full", null, 2048))).toBeNull();
    expect(coverageNote(indexed("full", "unexpected", 2048))).toBeNull();
    expect(coverageNote(null)).toBeNull();
    for (const status of ["pending", "fetching", "indexing"] as const) expect(coverageNote({ status })).toBeNull();
    expect(coverageNote({ status: "failed", reason: "Couldn't reach storage." })).toBeNull();
    expect(coverageNote({ status: "skipped", reason: "Over this tab's search budget." })).toBeNull();
  });

  it("has no reason for null, empty, blank or non-string values", () => {
    for (const reason of [null, "", " \n\t ", 42, { html: "<b>x</b>" }, undefined]) {
      expect(coverageNote(indexed("metadata-only", reason))).toEqual({ label: "name match only", reason: null });
    }
  });

  it("keeps markup literal and collapses line breaks and control characters", () => {
    const hostile = `<img src=x onerror="alert(1)">\n\n<script>alert(2)</script>\u0000\u0007 &amp; tail`;
    expect(coverageNote(indexed("error", hostile))?.reason)
      .toBe(`<img src=x onerror="alert(1)"> <script>alert(2)</script> &amp; tail`);
  });

  it("caps long reasons by code point without splitting a surrogate pair", () => {
    const long = "😀".repeat(REASON_DISPLAY_CHARS * 3);
    const reason = coverageNote(indexed("metadata-only", long))?.reason ?? "";
    expect(Array.from(reason)).toHaveLength(REASON_DISPLAY_CHARS);
    expect(reason.endsWith("😀…")).toBe(true);
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(reason)).toBe(false);
  });

  it("reads only a bounded prefix of huge reasons and still marks them as cut", () => {
    // Collapsing the scanned prefix leaves a short string; the ellipsis must still disclose the cut.
    const huge = `Cap reason.${" ".repeat(5_000_000)}never shown`;
    expect(coverageNote(indexed("truncated", huge, 10))?.reason).toBe("Cap reason.…");
  });
});
