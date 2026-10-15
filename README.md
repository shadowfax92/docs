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

The URL is printed and copied to your clipboard automatically.

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

Search reads at most 2 MiB source and returns at most 512 KiB UTF-8 per document.
The browser's cancellable RE2 worker ranks by exact nonempty match count, then
upload time/ID. Literal is the default; regex/case switches are explicit. Index
limits are 10,000 documents and 32 MiB estimated retained memory. Query limits
include 256 pattern bytes, 4,096 instructions, 128 Mi instruction×UTF-16 work,
1,000,000 finds and a cooperative 1.5-second deadline. Limit errors do not become
successful partial rankings. No private index is stored in localStorage.

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
DOCS_LOCAL_RUN=acceptance npm run integration:serve
```

Leave that terminal running. In another terminal at the same source checkout:

```sh
cd worker
DOCS_LOCAL_RUN=acceptance npm run integration:http
DOCS_LOCAL_RUN=acceptance npm run integration:browser
cd ..
go test ./...
DOCS_NATIVE_ORIGIN=http://127.0.0.1:18787 go test ./internal/upload -run TestNativeR2Uploads -v
```

The literal origins are `http://127.0.0.1:18787` (public) and
`http://localhost:18788` (catalog); different hosts preserve cookie isolation as
well as origin isolation. The server prints its PID/stop command and saves it in
`worker/.wrangler/integration/acceptance/server.json`. Stop only that PID with
`kill -TERM <pid>`. All data, JSON results and screenshots live in that ignored
run directory. Use a fresh `DOCS_LOCAL_RUN` name for each full acceptance; tests
intentionally delete disposable cohort fixtures. The harness seeds legacy/group
and pagination cases through native R2. While workerd is stopped, it changes only
disposable native storage timestamps and adds a SQL failure trigger for one ID;
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
