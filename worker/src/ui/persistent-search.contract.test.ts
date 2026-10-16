import { describe, expect, it } from "vitest";
import { createLibraryFixture } from "../library-index.test-support";
import { querySummary, seedQueryRows, type QuerySeed } from "../library-index/query-test-support";
import { LibraryIndexError } from "../library-index";
import type { LibraryErrorCode } from "../library-contracts";
import { CatalogClient } from "./catalog-client";

/**
 * Contract check between the browser catalog client and the REAL LibraryIndex query module over
 * native Miniflare D1: the client's metadata, search and snippet requests are accepted, and every
 * reply passes its validators. HTTP (signed cursors, session, Origin, CSRF) belongs to catalog.ts;
 * this adapter calls the index directly and passes raw cursors where the catalog would sign them.
 */
const STATUS: Record<LibraryErrorCode, number> = {
  invalid_library_request: 400, invalid_search_request: 400, invalid_pattern: 400, invalid_cursor: 400,
  stale_generation: 409, search_budget_exceeded: 422, library_unavailable: 503,
};

function adapter(library: Awaited<ReturnType<typeof createLibraryFixture>>["library"]) {
  const calls = { paths: [] as string[], inFlight: 0, max: 0 };
  const fetch = async (input: string, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(input, "https://catalog.test");
    calls.paths.push(`${init.method ?? "GET"} ${url.pathname}${url.search}`);
    if (url.pathname === "/all-docs/session") {
      return Response.json({ version: 1, csrfToken: "csrf", expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
    }
    try {
      if (url.pathname === "/all-docs/api/documents") return Response.json(await library.page(url.searchParams.get("cursor") ?? undefined));
      const body = JSON.parse(String(init.body));
      calls.inFlight++;
      calls.max = Math.max(calls.max, calls.inFlight);
      try {
        if (url.pathname === "/all-docs/api/search") return Response.json(await library.search(body));
        if (url.pathname === "/all-docs/api/snippets") return Response.json(await library.snippets(body));
      } finally {
        calls.inFlight--;
      }
    } catch (error) {
      if (!(error instanceof LibraryIndexError)) throw error;
      return Response.json({ version: 1, error: { code: error.code, message: error.message, retryable: error.retryable } }, { status: STATUS[error.code] });
    }
    return new Response(null, { status: 404 });
  };
  return { fetch, calls };
}

async function until(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("catalog client against the real library index", () => {
  it("lists, searches, scans with regex, fetches snippets and gates select all over native D1", async () => {
    const fixture = await createLibraryFixture();
    try {
      const rows: QuerySeed[] = Array.from({ length: 620 }, (_, index) => {
        const uploadedAt = new Date(Date.UTC(2026, 9, 15) - index * 60_000).toISOString();
        if (index === 3) return { summary: querySummary(index, { uploadedAt, kind: "markdown", title: "Pending invoice" }), body: "", state: "pending", coverage: null };
        if (index === 7) return { summary: querySummary(index, { uploadedAt, kind: "markdown" }), body: "", state: "failed", coverage: null };
        return { summary: querySummary(index, { uploadedAt }), body: index % 5 === 0 ? `Invoice ${index}: <b>invoice</b> paid.` : `Note ${index}.` };
      });
      await seedQueryRows(fixture.db, rows);
      const { fetch, calls } = adapter(fixture.library);
      const client = new CatalogClient({ fetch, now: Date.now });
      await client.start();
      await until(() => client.scan.status !== "running" && client.scan.status !== "idle", "listing");

      expect(client.scan).toMatchObject({ status: "complete", generation: 0, pages: 2 });
      expect(client.observed()).toHaveLength(620);
      expect(client.indexOf("Q0000003")).toMatchObject({ state: "pending" });
      expect(client.indexOf("Q0000007")).toMatchObject({ state: "failed" });
      expect(client.library?.counts).toMatchObject({ documents: 620, pending: 1, failed: 1 });

      const invoices = rows.filter((row, index) => index % 5 === 0 && row.state === undefined).map((row) => row.summary.id);
      client.setFilters({ text: "invoice" });
      await until(() => client.searchState().complete || !!client.searchState().failure, "literal search");
      expect(client.searchState().failure).toBeNull();
      const matching = client.results().matching;
      expect(new Set(matching.map((doc) => doc.id))).toEqual(new Set([...invoices, "Q0000003"]));
      expect(client.hitFor(client.summary("Q0000005")!)?.matchCount).toBe(2);
      expect(client.selectAllGate()).toEqual({ ok: false, reason: "Unavailable: 1 document in these filters isn't indexed yet" });

      // Snippets for the rendered cards come from the real matcher, with exact UTF-16 ranges.
      await until(() => client.rendered().every((doc) => client.snippetFor(doc) !== null), "snippets");
      const preview = client.snippetFor(client.summary("Q0000005")!);
      expect(preview?.status).toBe("ready");
      if (preview?.status === "ready") {
        expect(preview.ranges.map(([start, end]) => preview.snippet.slice(start, end).toLowerCase())).toEqual(["invoice", "invoice"]);
        expect(preview.snippet).toContain("<b>invoice</b>"); // Markup arrives as plain text.
      }

      client.setFilters({ kinds: ["text"] }); // Pending and failed rows are markdown: a clean scope.
      expect(client.selectAllGate()).toEqual({ ok: true, count: invoices.length });

      client.setFilters({ regex: true, text: "inv[o]ice \\d+" });
      await until(() => client.searchState().complete || !!client.searchState().failure, "regex search");
      expect(client.searchState().failure).toBeNull();
      expect(client.results().matching.map((doc) => doc.id).sort()).toEqual([...invoices].sort());
      expect(client.selectAllGate()).toEqual({ ok: true, count: invoices.length });

      // A visible change elsewhere: the next search reports a newer generation and asks for Refresh.
      await fixture.db.prepare("UPDATE index_meta SET value = '5' WHERE key = 'generation'").run();
      client.setFilters({ regex: false, text: "paid" });
      await until(() => client.searchState().complete || !!client.searchState().failure, "search after change");
      expect(client.libraryChanged()).toBe(true);
      expect(client.selectAllGate()).toEqual({ ok: false, reason: "The library changed since it loaded — Refresh to select all matching" });
      client.refresh();
      await until(() => client.scan.status === "complete" && client.searchState().complete, "refresh");
      expect(client.scan.generation).toBe(5);
      expect(client.libraryChanged()).toBe(false);
      expect(client.selectAllGate()).toEqual({ ok: true, count: invoices.length });

      expect(calls.max).toBe(1);
      expect(calls.paths.some((path) => path.includes("/text"))).toBe(false);
    } finally {
      await fixture.dispose();
    }
  }, 60_000);
});
