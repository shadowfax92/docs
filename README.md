<div align="center">

# 📎 docs

**Share documents with short, clean URLs.**

*One command. File or Markdown folder uploaded, link in your clipboard.*

</div>

Upload a PDF, HTML file, Markdown file, or Markdown folder and get a short URL that renders directly in the browser. No login walls, no download prompts, no ugly Google Drive links.

- **One command** — `docs upload report.pdf` → short URL copied to clipboard
- **Renders in browser** — PDFs display inline, HTML served as-is, Markdown rendered with GitHub styling
- **Folder-friendly Markdown** — point at a docs folder to publish one combined page with a clickable table of contents
- **Short URLs** — `https://your-domain.com/xK9mRt2p` — clean and shareable
- **Fast & global** — served from Cloudflare's edge network via R2 + Workers
- **Simple auth** — bearer token for uploads, public read for viewing

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
docs upload ./guides             # combine Markdown files recursively
docs upload ./guides --name Docs # set link preview title
```

The URL is printed and copied to your clipboard automatically.

When uploading a directory, `docs` recursively collects `.md` and `.markdown` files, ignores other files, sorts by relative path, and uploads one generated Markdown document. The generated document starts with a table of contents that mirrors the folder hierarchy and links to each file section.

## Supported Uploads

| Input | Rendering |
|-------|-----------|
| `.pdf` | Displayed inline in browser's PDF viewer |
| `.html`, `.htm` | Served as-is with original formatting |
| `.md`, `.markdown` | Rendered with GitHub-flavored Markdown (light theme) |
| Directory containing `.md` / `.markdown` files | Combined into one Markdown page with a linked table of contents |

## How It Works

```
docs upload file.pdf
     │
     ▼
file path ───────────────┐
markdown folder ─ combine┤
                         ▼
┌─────────┐    PUT /upload     ┌──────────────────┐     put()    ┌─────────┐
│  CLI     │ ──────────────▶   │  Cloudflare       │ ──────────▶ │  R2     │
│  (Go)    │   Bearer token    │  Worker           │             │  Bucket │
└─────────┘                    └──────────────────┘             └─────────┘
     ▲                                │
     │                                │
     └── { url: "https://…/xK9mRt2p" }

Browser GET /xK9mRt2p  ──▶  Worker  ──▶  R2  ──▶  file served
```

- CLI sends the file, or generated Markdown folder document, to the Worker with a bearer token
- Worker generates an 8-character short ID, stores the file in R2
- Worker returns the short URL, CLI copies it to clipboard
- Anyone with the URL can view the document — no auth required

## Commands

| Command | Description |
|---------|-------------|
| `docs upload <file-or-markdown-folder>` | Upload a file or Markdown folder and get a short URL |
| `docs config` | Set worker URL and auth token |
| `docs help` | Show help |

## Custom Domain

To use your own domain instead of `*.workers.dev`:

1. Add a custom domain in the Cloudflare dashboard under Workers → your worker → Triggers → Custom Domains
2. Update your CLI config: `docs config` with the new URL

---

> Built for sharing docs fast between co-founders. No frills, just works.
