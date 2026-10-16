<div align="center">

# 📎 docs

**Share files with short, clean URLs.**

*One command. File or folder uploaded, link in your clipboard.*

</div>

Upload any regular file, HTML page, Markdown file, PDF, or folder and get a short URL. Renderable documents open directly in the browser; everything else gets a clean download page.

- **One command** — `docs upload report.pdf` → short URL copied to clipboard
- **Renders when it can** — native PDF/image/media viewers, authored HTML with vim keys, and safe self-hosted Markdown
- **Downloads when it should** — unknown file types show a download page instead of raw bytes
- **Folder uploads** — point at a folder to publish one downloadable zip archive
- **Safe deletion** — remove a shared upload and its matching local history with `docs delete <id>`
- **Short URLs** — `https://your-domain.com/xK9mRt2p` — clean and shareable
- **Fast & global** — served from Cloudflare's edge network via R2 + Workers
- **Simple auth** — bearer token for uploads and deletion, public read for viewing

---

## Install

Requires Go 1.22+.

```sh
git clone <repo>
cd docs
make install
```

## Setup

### 1. Set up the deployment

Requires Node **22.16+ on macOS/Linux**, npm, and the locally installed Wrangler
from the lockfile. The public Worker is `https://docs.shadowfax92.workers.dev`;
the private catalog is `https://docs-library.shadowfax92.workers.dev/all-docs`.
Keep these origins distinct in their existing Wrangler configs.

```sh
cd worker
npm ci
npx --no-install wrangler login  # explicit, only if not already logged in
cp -n .env.example .env          # preserves an existing .env
chmod 600 .env
vi .env                         # set ALL_DOCS_PASSWORD locally
```

The existing `docs-cli` R2 bucket and public `AUTH_TOKEN` must already be
provisioned. For a new account, create the bucket and provision that bearer
secret explicitly on **`wrangler.toml` only** before using the CLI. The recipe
does not create buckets, change R2 rules, set public secrets, log in, or prompt.

`ALL_DOCS_PASSWORD` must be 1..1024 UTF-8 bytes. Use literal dotenv assignments;
quote values containing `#` or leading/trailing spaces. Quoted multiline values
work; shell expansion and escaped quotes are not supported. Duplicate catalog
secret assignments and malformed files fail before deployment. Leave the
`CATALOG_SESSION_KEY` assignment absent initially: a live run generates 32 random
bytes, stores their hex encoding in the same ignored `.env`, and reuses it on
every later run. An existing key must be independent of the password and
32..1024 UTF-8 bytes; an empty assignment is an error. Unrelated entries and
comments stay intact. Keep the file private, back it up securely, and edit it
only when no deployment is running. Never commit or paste its contents.

Before enabling catalog deletion, the operator must deploy the immutable public
reservation writer, verify all public traffic uses it, finish old in-flight
uploads, and stop any mutable out-of-band/S3 writers. Start that migration with
`npm run deploy:public`. The recipe's ordering does **not** prove writer drainage.
R2 has no conditional delete, so reviewed deletion depends on this coordination.

Before sustained catalog use, the deployment mediator must add and read back
**one-day expiration only for `__docs_internal/catalog/v1/throttle/`**, preserving
every existing rule, including **Default Multipart Abort Rule** (abort incomplete
uploads after 7 days). Keep upload claims/tombstones permanent. Never set
bucket-wide document expiry. This is an operator prerequisite, not an action the
recipe silently performs.

### 2. Deploy or redeploy

From `worker`, inspect a read-only plan, then explicitly execute it:

```sh
npm run deploy:all -- --plan
npm run deploy:all
```

The live order is public source → catalog source/bootstrap → catalog secret bulk
upload → final catalog source deployment. The bootstrap gives a new catalog a
fail-closed source before secrets exist; an existing catalog keeps its secrets.
Only `ALL_DOCS_PASSWORD` and `CATALOG_SESSION_KEY` enter catalog provisioning, via
JSON stdin. Passwords/keys never enter command arguments or output. Public
`AUTH_TOKEN` is retained. Each source deploy uses its explicit existing config
and runs its configured build through logged-in local `npx --no-install wrangler`.

After changing the password with `vi .env`, repeat those same two `deploy:all`
commands. Plain `wrangler deploy` does not upload `.env` values as secrets. Keep
`CATALOG_SESSION_KEY` unchanged when changing the password; both password changes
and intentional key rotation invalidate existing catalog sessions/cursors.

Explicit choices:

```sh
npm run deploy:public -- --plan     # source only; needs no catalog .env
npm run deploy:public
npm run deploy:catalog -- --public-ready --plan
npm run deploy:catalog -- --public-ready
```

`--public-ready` acknowledges prior public-writer deployment/coordination; it does
not verify it. Catalog-only still deploys catalog source before secret upload
and again afterward. `npm run deploy` is an alias for `deploy:all`.

Plan mode starts no child process, changes no permissions/files, and makes no
cloud request. It prints ordered redacted commands and key names; a missing key
is generated only during execution. Live runs enforce `.env` mode 0600 and use
an empty `.env.deploy.lock` to serialize deployments. After a crash, remove a
stale lock only after checking no deployment remains active. Child output/debug
logs are discarded to prevent secret echoes. On failure, the recipe reports the
failed step and stops; earlier cloud changes remain. Check login/config/build
separately, then rerun the full recipe. Verify live behavior after completion;
this script does not perform production acceptance.

### 3. Configure the CLI

```sh
docs config
```

Enter your public worker URL and its existing bearer auth token.

Config stored at `~/.config/docs/config.yaml`:

```yaml
url: https://docs.yourdomain.workers.dev
token: your-auth-token
```

## Usage

```sh
docs upload report.pdf           # upload PDF, get short URL
docs upload page.html            # upload HTML page
docs upload notes.md             # upload Markdown (safe self-hosted renderer)
docs upload archive.zip          # upload any file with a download page
docs upload --folder ./guides    # upload folder as a zip archive
docs upload --folder ./guides --name Docs # set link preview title
docs list                        # show the last 10 uploads
docs list --days 30              # show uploads from the last 30 days
docs delete xK9mRt2p             # delete an upload by its short ID
```

The URL is printed and copied to your clipboard automatically. Regular file uploads
stream with an explicit remaining Content-Length, including zero-byte files.
Standard in-memory readers retain net/http length inference. Unknown-length streams
are not buffered: the native local R2 harness rejects them with HTTP 500. The
mediator verified that the original Go client works against the pre-rollout
production Worker; local emulation failure alone is not a production regression.
The mediator owns before/after live compatibility proof and any global CLI install.

When uploading a directory with `--folder`, `docs` recursively packages regular files into a zip archive and uploads that archive. Folder uploads are limited to 200 MB total across all regular files before compression.

Uploads are also recorded locally at `~/.config/docs/uploads.json`. The history file stores the upload time, display name, URL, ID, and source path. If history recording fails, the upload still succeeds.

`docs delete <id>` authenticates to the Worker, resolves the stored filename from the ID, deletes every object belonging to that upload, and removes only exact matching IDs from local history. If the remote upload is already missing, the command says so and still cleans stale matching history. Authentication, network, or storage errors leave local history unchanged. If remote deletion succeeds but the local history update fails, the error explicitly reports that partial outcome.

A successful deletion makes subsequent requests return `404 Not Found`, including conditional requests with an old ETag. Fresh public responses use `public, max-age=0, must-revalidate`; generated pages have no source-derived ETag. Open tabs, downloaded copies, and old responses cached under the former one-year immutable policy cannot be remotely revoked.

## Preview and search capabilities

The public origin serves documents and bearer uploads/deletes. The separate catalog
origin serves only the trusted `/all-docs` app/assets and authenticated inert JSON.
The catalog never hosts uploaded HTML, raw files, thumbnails or upload fallback.
Password sessions last 12 hours; locking clears this browser's cookie. Copied
stateless credentials expire after 12 hours or password/key rotation.

| Input | Public page | Catalog body search |
| --- | --- | --- |
| HTML | Authored scripts/forms/styles plus default offline vim-html | Static visible text; scripts/styles/template/noscript excluded |
| Already built vim-html | Original runtime/config/comment identity stays single | Same bounded static extraction |
| Markdown | Self-hosted renderer, HTML disabled, safe links | UTF-8 source text |
| UTF-8 text/code/log/XML | Escaped lines, anchors and wrap control | Source text |
| JSON | Lossless token pretty view (large numbers/duplicate keys retained) | Source text |
| CSV/TSV | Quoted cells, embedded newlines, numeric columns, exact row count | Source text |
| DOCX | Main-document text; escaped line view | Bounded main-document text; labelled partial coverage |
| PDF | Browser's native viewer and direct/download links | **Metadata only**; no PDF text extraction or OCR |
| PNG/JPEG/GIF/WebP/AVIF/ICO/SVG | Native image; SVG only an image, raw SVG sandboxed | Metadata only |
| WAV/MP3/OGG/FLAC/M4A, MP4/WebM/MOV | Native controls, codec error and download fallback | Metadata only |
| XLSX/PPTX/legacy Office/ODT | Metadata/download fallback | Metadata only |
| ZIP/TAR/GZ/7Z and unknown binary | Metadata/download fallback | Metadata only |
| Folder with `--folder` | One downloadable ZIP (up to 200 MB before compression) | Archive metadata only |

Body search also recognizes common source filenames even when old uploads used
`application/octet-stream`. Invalid UTF-8, unsupported encodings, parser failures,
limits and primary-only extraction of multi-object IDs have explicit coverage;
files remain visible by metadata. Coverage is full/truncated/metadata-only/error,
never a claim of arbitrary binary fulltext. DOCX omits Word layout, headers,
images, relationships and embedded objects. No file goes to a conversion service.

Preview limits: 256 KiB text/Markdown/data input; only plain text permits a labelled
prefix. Text display stops at 2,000 lines. JSON has 32 nesting levels, 10,000 tokens
and 256 KiB formatted output. CSV/TSV retain 200 data rows, at most 64 columns and
8,192 UTF-8 bytes per cell; full bounded input determines the total row count.
DOCX accepts at most 2 MiB compressed input and 256 directory entries, reads only
`word/document.xml`, checks ZIP structure/CRC/actual expansion, caps XML at 1 MiB,
64 levels and 50,000 lexical tokens. Its preview shows at most 256 KiB UTF-8/2,000
lines. Stored/DEFLATE packages are supported; ZIP64/multi-disk/encrypted or
unsupported XML structures fall back honestly.

Search is a persistent, rebuildable D1 index over authoritative R2 objects. Uploads
publish names before returning where D1 is available, then extract each version in
`waitUntil`. A failed derived-index write preserves a successful R2 upload for
reconciliation. Search/reload never extract documents. The browser holds metadata,
compact exact counts and bounded plaintext snippets; it does not download or
persist the body corpus or instantiate a search Worker. The retired `/text` route
and browser search-worker asset return 404.

Literal search uses quoted FTS5 trigram candidates and exact non-overlapping
counts. Regex and Unicode cases use the same RE2 matcher in bounded progressive
server scans. Aa, exact counts, UTF-16 snippet ranges, type/date filters and frozen
ID/version deletion remain available. Partial scans and pending/failed coverage
stay visible. All-matching selection requires complete discovery and search at the
same generation, with no pending/failed rows in filter scope. Limit errors remain
explicit; they never become complete empty results.

Extraction reads at most 2 MiB source and stores at most 512 KiB UTF-8 text per
version. Metadata pages contain at most 500 rows; body statements at most eight
rows/4 MiB; scans and snippets stop at 16 MiB or one second and resume. Queries
admit at most 256 UTF-8 bytes and 10,000 hits. One invocation shares a conservative
40-operation SQL/R2 work allowance plus 10 cleanup operations. Large or costly
queries can fail with an explicit budget error and must be narrowed. Neither
local acceptance nor these limits establish deployed CPU/p95 latency.

Both roles bind the same D1 database, but only the authenticated catalog exposes
pages, search, snippets, retry and maintenance. POSTs require the signed session,
exact Origin, same-origin Fetch Metadata, catalog header and CSRF. Responses are
no-store/noindex; uploaded HTML cannot read the index. Deletes hide behind durable
D1 tombstones before R2 removal; failed R2 deletion stays hidden for later repair.
Deleted markers and upload reservations are permanent. Unsupported out-of-band
R2 recreation is reported as an anomaly and never silently indexed.

### Persistent index rollout and backfill (operator only)

Do this from the final merged, verified tree. The deployment mediator owns all
remote commands, account inspection and rollout. The dedicated database is
`docs-library-index` (`8517827e-bcf4-4a9a-93d6-b23b7f62e259`); confirm both configs
bind that exact ID as `LIBRARY_DB`, both bind the existing R2 bucket, and only the
catalog has cron triggers. At the 2026-10-16 pre-rollout checkpoint migration
`0001_library_index.sql` was already applied to the empty, unbound database and
trigram/contentless FTS plus disposable Time Travel restoration passed. Recheck
current state before deployment; that checkpoint is not proof of a live rollout.

```sh
cd worker
npm ci
npm run typecheck
npm test
npm run test:operator
npm run build                    # two role dry runs
npx --no-install wrangler d1 migrations list docs-library-index --remote --config wrangler.catalog.toml
# Apply ONLY if the reviewed migration is pending on the exact target database:
npx --no-install wrangler d1 migrations apply docs-library-index --remote --config wrangler.catalog.toml
npm run deploy:public -- --plan
npm run deploy:public
# Verify immutable writer traffic and finish prior in-flight uploads before catalog:
npm run deploy:catalog -- --public-ready --plan
npm run deploy:catalog -- --public-ready
npm run index:maintain -- --plan --max-batches 1000 --deadline-seconds 300
# After actual auth/role/migration/capacity preflight:
npm run index:maintain -- --max-batches 1000 --deadline-seconds 300
```

Use the existing ignored 0600 `worker/.env`; do not print it, pass passwords in
argv, rotate the session key incidentally, or substitute production credentials
into fixture tests. The existing deployment recipe uses logged-in local `npx`
Wrangler and secret JSON stdin with suppressed child/debug logs. Public source
must precede catalog source. Before backfill verify the real account plan, D1
capabilities/schema, session/Origin/CSRF/no-store/noindex behavior, public index
read refusal, and source count/versions against a fresh metadata baseline. Keep
the default 400,000,000-byte storage budget until an owner explicitly approves a
capacity change; never upgrade billing automatically.

`index:maintain` defaults to the literal HTTPS catalog origin in
`wrangler.catalog.toml`. `--plan`/`--dry-run` prints exact endpoint/options without
opening `.env` or making requests. Execution reads the private password only at
invocation, keeps cookie/CSRF in memory, starts/resumes one reconcile, then sends
bounded resume batches with `reconcile:false`. Server checkpoints survive process
exit; rerun the same command to resume. It shares the cron lease. Progress includes
only sanitized counts/outcome/timing. Exit 0 requires a newly completed reconcile,
a complete result, zero pending/failed/anomalies and unpaused storage. Exit 2 is
busy, 3 paused, 4 HTTP/protocol/failed/anomaly, 5 no visible progress, 6 batch/time
cap; other local/network failures exit 1. A partial result or zero discovered rows
never proves completion. It does not reset retries, unhide tombstones, raise a
budget or repair a blocked listing automatically.

Inspect failures before manually retrying exact failed versions through the
catalog's explicit retry control. A storage pause requires owner capacity review;
names remain searchable while pending text remains disclosed. Default five-minute
drains and daily difference-only reconciliation do not guarantee a backfill time.
Record mean indexed bytes, actual database growth/projection, query p95/SQL rows
read/written and extraction/regex CPU on the deployed account before declaring
production acceptance. D1 Time Travel retention depends on the account plan; an
FTS-bearing database cannot use ordinary D1 export as a complete backup. Keep the
migration and rebuild path. Restore/rebuild and any R2 inconsistency require owner
review: do not delete the database, clear tombstones, or roll back to a mutable
writer. A prior public release lacking D1 upkeep needs a coordinated rollout and
reconcile rather than an unreviewed source rollback.

Uploaded dates come from R2 storage time, never a legacy client creation date.
Discovery follows every cursor and keeps multi-object IDs together. It observes
concurrent storage rather than an atomic snapshot. Selection/review freezes
explicit ID/version refs and the age cutoff; deletion commits at most 100 IDs per
batch and preserves changed/failed/unprocessed selections. Coordinated immutable
writers and permanent claims are prerequisites described above.

Public raw/download bytes stay exact and support single byte ranges, ETag/If-Range
and revalidation, including zero-byte files. Native playback depends on browser
codecs. Local acceptance validates PNG, PCM WAV and VP9 WebM, a real text PDF
fixture and DOCX, with honest unsupported-media fallback; it does not establish
other codecs/devices, scanned PDF OCR, legacy Office parsing, or deployed-tier CPU.

Default vim-html keeps authored appearance with theme-none behavior and supplies
j/k, search, visual selection, comments/export, insert mode and help/off controls.
Existing baked documents keep their identity/runtime. Conservative handling leaves
restrictive CSP, invalid encodings, ambiguous parser contexts and HTML over 4 MiB
unchanged. Previously cached pages cannot be retrofitted remotely. Raw/download
and catalog inputs never receive the runtime.

## Local integration acceptance

No account, production bucket, `.env`, global installation or deployment is used.
Requires Node 22.16+, Python 3, ffmpeg, Go, and Playwright Chromium installed locally
(`cd worker && npx playwright install chromium` if absent).

```sh
cd worker
npm ci
npm run typecheck
npm test
npm run build                    # both roles, dry-run only
DOCS_LOCAL_RUN=persistent-index-acceptance npm run integration:serve
```

Leave that terminal running. In another terminal at the same source checkout:

```sh
cd worker
DOCS_LOCAL_RUN=persistent-index-acceptance npm run integration:http
DOCS_LOCAL_RUN=persistent-index-acceptance npm run integration:browser
cd ..
go test ./...
```

The operator proof uses its own disposable 0600 credentials and 32 native R2
sources; it runs the shipped CLI through bounded backfill, held-lease refusal and
storage pause. The scale proof seeds 5,000 cached native D1/FTS rows once (48 have
native R2 sources), then drives the compiled UI/backend without HTTP data stubs:

```sh
npm run integration:persistent
# In a separate retained server terminal, choose unused loopback ports:
DOCS_LOCAL_RUN=persistent-index-scale DOCS_FIXTURE_MODE=scale DOCS_PUBLIC_PORT=19177 DOCS_CATALOG_PORT=19178 npm run integration:serve
# Same environment in the proof terminal:
DOCS_LOCAL_RUN=persistent-index-scale DOCS_PUBLIC_PORT=19177 DOCS_CATALOG_PORT=19178 npm run integration:scale
```

The literal origins are `http://127.0.0.1:18977` (public) and
`http://localhost:18978` (catalog); different hosts preserve cookie isolation as
well as origin isolation. The server prints its PID/stop command and saves it in
`worker/.wrangler/integration/persistent-index-acceptance/server.json`. Stop only that PID with
`kill -TERM <pid>`. All data, JSON results and screenshots live in that ignored
run directory. Use a fresh `DOCS_LOCAL_RUN` name for each full acceptance; tests
intentionally delete disposable cohort fixtures. The harness applies the committed migration to one real D1 shared by both roles
and seeds legacy/group cases through native R2. It refuses occupied ports or an
existing run manifest; choose a fresh run name and free ports (`DOCS_PUBLIC_PORT`,
`DOCS_CATALOG_PORT`) without reusing another campaign server. While workerd is stopped, it changes only
disposable native storage timestamps and adds SQL failure triggers for dedicated IDs;
product modules and their error paths remain real. SIGUSR1 changes only StaleDel
for the frozen-version refusal proof. Headless Chromium uses an isolated profile
and never activates an owner window. Local evidence is not live acceptance.

## How It Works

```
docs upload file.pdf
     │
     ▼
file path ───────────────┐
folder ─ zip archive ────┤
                         ▼
┌─────────┐    PUT /upload     ┌──────────────────┐     put()    ┌─────────┐
│  CLI     │ ──────────────▶   │  Cloudflare       │ ──────────▶ │  R2     │
│  (Go)    │   Bearer token    │  Worker           │             │  Bucket │
└─────────┘                    └──────────────────┘             └─────────┘
     ▲                                │
     │                                │
     └── { url: "https://…/xK9mRt2p" }

Browser GET /xK9mRt2p  ──▶  Worker  ──▶  R2  ──▶  file served

docs delete xK9mRt2p   ──▶  DELETE /upload/xK9mRt2p  ──▶  Worker resolves xK9mRt2p/*  ──▶  R2 delete
```

- CLI sends the file, or generated folder archive, to the Worker with a bearer token
- Worker generates an 8-character short ID, stores the file in R2
- Worker returns the short URL, CLI copies it to clipboard
- Anyone with the URL can view or download the file — no auth required
- `/raw` serves the stored object inline; `/download` serves it as an attachment
- Deletion requires the same bearer token as upload and accepts an ID, never a filename or R2 key

## Commands

| Command | Description |
|---------|-------------|
| `docs upload <file>` | Upload a file and get a short URL |
| `docs upload --folder <folder>` | Zip and upload a folder |
| `docs list` | Show the last 10 uploads |
| `docs list --days <n>` | Show uploads from the last `n` days |
| `docs delete <id>` | Delete a remote upload and reconcile matching local history |
| `docs config` | Set worker URL and auth token |
| `docs help` | Show help |

## Custom Domain

To use your own domain instead of `*.workers.dev`:

1. Add a custom domain in the Cloudflare dashboard under Workers → your worker → Triggers → Custom Domains
2. Set literal distinct public/catalog origins in both Worker configs, redeploy both roles and reverify isolation.
3. Update your CLI config: `docs config` with the new public URL

---

> Built for sharing docs fast between co-founders. No frills, just works.
