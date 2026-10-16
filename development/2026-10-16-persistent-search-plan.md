# Persistent document search implementation

Owner approved the design on 2026-10-16 with "build it". This supersedes the
design-only endpoint in the earlier plan. Build through independently reviewed,
merged PRs, then deploy both Worker roles, backfill existing documents and verify
the live catalog. No billing-plan upgrade is authorized or required by this plan.

The accepted design, including Appendix H and mediator corrections, is at
`/Users/shadowfax/llm/code/side-projects/clis/docs/campaigns/2026-10-16-docs-search-design/design.md`.
Implementation coordination and reports live at
`/Users/shadowfax/llm/code/side-projects/clis/docs/campaigns/2026-10-16-docs-persistent-search/`.

## Decisions

- R2 remains authoritative for IDs, versions, original bytes and download/raw
  behavior. D1 is a rebuildable derived index of metadata, extracted text and
  FTS5 trigrams. Index once per version, never in response to a search.
- Keep literal, regex, Aa, exact non-overlapping counts, UTF-16 snippet ranges,
  filters and frozen ID/version deletion review. RE2 remains the authority.
  Regex and non-indexable Unicode queries use truthful bounded progressive scans.
- D1 is bound to both Worker roles. Only the authenticated catalog exposes index
  read routes and the maintenance cron. Query/snippet POSTs retain Origin, session,
  CSRF, no-store and noindex protections. Uploaded HTML never gains a D1 read route.
- Tombstone before R2 removal, including IDs absent from D1. Every insertion and
  late extraction checks permanent deleted-ID markers. Version-aware failure and
  restoration behavior must survive overlapping deletion and maintenance.
- Bounded five-minute drains and a daily difference-only R2 reconcile share a
  lease with operator backfill. Housekeeping never bumps visible generation.
  No per-row marking on every cron tick. Enforce row, byte, time and storage caps.
- Preserve the approved 400 MB default size budget, early growth projection and
  visible pause. Check real account capacity and deployed D1 capabilities before
  backfill. Never upgrade billing automatically or silently omit content.
- Keep the current elegant catalog layout, thumbnails, theme, keyboard support,
  metadata and deletion UI. Replace its per-tab extraction/index pipeline with
  metadata pages and coalesced latest-query HTTP search. No full-corpus browser
  persistence. Pending, failed, partial and stale-generation states stay visible.

## Waves and exclusive ownership

Every implementation worker uses ft-build through an independent review, fixes,
verified PR and merge. Workers rebase/merge current main without force pushing,
stashing, deleting worktrees or losing another owner's changes. cdxsx means
codex-sol-xhigh; cldox means claude-opus-xhigh. Apply ft-codebase-design and the
existing architecture findings proportionately at this seam, without a new
repository-wide design exercise. Explain lifecycle, persistence and race invariants
in concise architectural comments.

1. **Skeleton (cdxsx), alone first.** Own the D1 migration, new browser-safe
   library wire contracts, server-only LibraryIndex composition and private
   query/records/maintenance stubs, a real-Miniflare D1 fixture, and the narrow
   pure-matcher export/refactor in search.ts with semantic regression coverage.
   Freeze exact interfaces and the subsequent file ownership in the result report.
   The new module is not connected to production until later slices. No generic
   repository framework or second matcher.
2. **Parallel build wave after the skeleton merges:**
   - **Query (cdxsx):** private index query implementation and focused tests;
     candidates, exact counting, metadata pages/status, progressive cursors,
     snippets, query validation and memory bounds. Own search.ts follow-ups only
     if the frozen pure-matcher seam requires them. No HTTP/UI/lifecycle edits.
   - **Lifecycle (cdxsx):** private records implementation and focused tests;
     create/deferred extraction, metadata upsert, guarded version/text writes,
     deletion tombstone/finalize/restore and deterministic race proofs. No query,
     maintenance, HTTP or UI edits.
   - **Maintenance (cdxsx):** private maintenance implementation and tests;
     shared lease, bounded retries/drain/backfill, daily resumable difference-only
     reconcile, storage projection/pause and anomalies. Use the frozen records
     interface; no lifecycle/query/HTTP/UI edits.
   - **HTTP/wiring (cdxsx):** index.ts, catalog.ts, contracts.ts environment
     binding, their tests, both Wrangler configs and backend build adaptation;
     authenticated D1 routes, both decorated write paths and catalog-only cron.
     Retire /text, preserve public CLI behavior. Coordinate any frozen-contract
     amendment through the mediator. Database ID remains a deployment handoff.
   - **Catalog UI (cldox):** ui/catalog-client.ts, app.ts, coverage-note.ts and
     focused tests/proof; replace the Web Worker with the frozen HTTP protocol,
     latest-only/debounced requests, bounded snippets, progressive search and
     conservative selection. Retire search-worker source/asset via a coordinated
     narrow build allowlist edit. Preserve design and all unrelated behavior.
3. **Integration/deployment tooling (cdxsx).** After prerequisite merges, own
   cross-module proof scripts, real two-origin Miniflare+D1 fixture adaptation,
   safe migration/backfill/deploy recipe and any explicitly transferred glue.
   Prove a fresh 5k browser avoids per-document /text/R2 requests, warm reload,
   upload/delete/reconcile races, failure recovery and all relevant regressions.
   Re-run exact compiled Worker large-body and real-browser acceptance. Deliver
   deploy-ready main through ft-build; no production mutations by workers.
4. **Mediator production acceptance.** Provision/reuse only the dedicated D1
   resource, probe its required features, apply migration, bind both roles,
   coordinate writer rollout, deploy using logged-in local npx Wrangler, drive
   the leased operator backfill and verify live query latency/usage/coverage.
   Preserve existing secrets. Measure actual DB growth and stop truthfully on a
   real capacity/CPU blocker. Validate Time Travel on disposable acceptance data
   or a separate probe database; never restore production over newer writes.

## Acceptance

- Differential equality with the current RE2 matcher for case, Unicode, phrases,
  short terms, punctuation, zero-width/regex semantics and non-overlapping counts.
  FTS grammar input is inert. Do not trust FTS Unicode folding as exact matching.
- Bounded real-D1 scans over 100 x 512 KiB bodies and snippets for 48 such bodies,
  with memory evidence. Storage gate fails visibly before the configured limit.
- No resurrection after deletion by late extraction, stale reconcile or missing
  initial D1 rows. D1 hide failure leaves R2 untouched; partial failures repair.
- All new private endpoints enforce existing authentication/Origin/CSRF policies;
  public role cannot search/read D1. Raw/download bytes and statuses stay exact.
- A fresh 5k catalog opens with about 15 non-thumbnail requests and zero /text
  requests. Query edits read stored text/index only; latest replies cannot replace
  a newer query, session, snapshot or version. Full selection requires completion.
- Run meaningful Worker tests, both TypeScript targets, both role dry-run builds,
  Go checks and native/browser acceptance. Distinguish local from deployed results.
- Completion means merged code, deployed roles, existing-corpus backfill and live
  acceptance, with explicit resource, version, performance and limitation evidence.
