<div align="center">

# 📎 docs

**Share files with short, clean URLs.**

*One command. File or folder uploaded, link in your clipboard.*

</div>

Upload any regular file, HTML page, Markdown file, PDF, or folder and get a short URL. Renderable documents open directly in the browser; everything else gets a clean download page.

- **One command** — `docs upload report.pdf` → short URL copied to clipboard
- **Renders when it can** — PDFs display inline, HTML serves as-is, Markdown renders with GitHub styling
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

### 1. Deploy the Worker

```sh
cd worker
npm install
npx wrangler login          # if not already logged in
npx wrangler r2 bucket create docs-cli
npx wrangler deploy
npx wrangler secret put AUTH_TOKEN
```

Generate a token with `openssl rand -hex 32` and paste when prompted.

### 2. Configure the CLI

```sh
docs config
```

Enter your worker URL (printed after `wrangler deploy`) and the same auth token.

Config stored at `~/.config/docs/config.yaml`:

```yaml
url: https://docs.yourdomain.workers.dev
token: your-auth-token
```

## Usage

```sh
docs upload report.pdf           # upload PDF, get short URL
docs upload page.html            # upload HTML page
docs upload notes.md             # upload Markdown (rendered with GitHub CSS)
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

A successful deletion guarantees that subsequent uncached requests for the ID return `404 Not Found`. Public responses currently use a one-year immutable cache, so HTML or other content already loaded in an open tab—or retained by a browser cache—may remain visible until that local cached copy is discarded.

## Supported Uploads

| Input | Rendering |
|-------|-----------|
| `.pdf` | Displayed inline in browser's PDF viewer |
| `.html`, `.htm` | Served as-is with original formatting |
| `.md`, `.markdown` | Rendered with GitHub-flavored Markdown (light theme) |
| Any other regular file | Download page with filename, type, and size |
| Any directory, with `--folder` | Uploaded as a downloadable zip archive, up to 200 MB before compression |

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
2. Update your CLI config: `docs config` with the new URL

---

> Built for sharing docs fast between co-founders. No frills, just works.
