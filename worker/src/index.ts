interface Env {
  DOCS_BUCKET: R2Bucket;
  AUTH_TOKEN: string;
}

function generateId(): string {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);
  let result = "";
  for (const b of bytes) {
    if (b < 248 && result.length < 8) {
      result += chars[b % chars.length];
    }
  }
  while (result.length < 8) {
    const extra = new Uint8Array(1);
    crypto.getRandomValues(extra);
    if (extra[0] < 248) result += chars[extra[0] % chars.length];
  }
  return result;
}

function getContentType(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() || "";
  const types: Record<string, string> = {
    pdf: "application/pdf",
    html: "text/html",
    htm: "text/html",
    md: "text/markdown",
    markdown: "text/markdown",
  };
  return types[ext] || "application/octet-stream";
}

function fileExt(filename: string): string {
  return filename.split(".").pop()?.toLowerCase() || "";
}

function isMarkdown(filename: string): boolean {
  const ext = fileExt(filename);
  return ext === "md" || ext === "markdown";
}

function isPdf(filename: string): boolean {
  return fileExt(filename) === "pdf";
}

function sanitizeFilename(name: string): string {
  return name.replace(/[^\w.\-]/g, "_");
}

function escapeHtml(s: string): string {
  return s.replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function titleFromFilename(filename: string): string {
  return filename.replace(/\.[^.]+$/, "").replace(/[_-]/g, " ");
}

async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const aBytes = encoder.encode(a.padEnd(256));
  const bBytes = encoder.encode(b.padEnd(256));
  if (aBytes.length !== bBytes.length) return false;
  let result = 0;
  for (let i = 0; i < aBytes.length; i++) {
    result |= aBytes[i] ^ bBytes[i];
  }
  return result === 0;
}

function ogTags(url: string, title: string, description: string, type: string): string {
  const t = escapeHtml(title);
  const d = escapeHtml(description);
  const u = escapeHtml(url);
  return `  <meta property="og:title" content="${t}">
  <meta property="og:description" content="${d}">
  <meta property="og:url" content="${u}">
  <meta property="og:type" content="article">
  <meta name="twitter:card" content="summary">
  <meta name="twitter:title" content="${t}">
  <meta name="twitter:description" content="${d}">
  <meta name="description" content="${d}">`;
}

function pdfWrapper(pdfUrl: string, title: string, pageUrl: string): string {
  const safeTitle = escapeHtml(title);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${safeTitle}</title>
${ogTags(pageUrl, title, `PDF — ${title}`, "article")}
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; background: #f6f8fa; }
    .header { padding: 12px 20px; background: #fff; border-bottom: 1px solid #d0d7de; display: flex; align-items: center; justify-content: space-between; }
    .header h1 { font-size: 16px; font-weight: 600; color: #1f2328; }
    .header a { font-size: 13px; color: #0969da; text-decoration: none; }
    .header a:hover { text-decoration: underline; }
    embed { width: 100%; height: calc(100vh - 49px); display: block; }
  </style>
</head>
<body>
  <div class="header">
    <h1>${safeTitle}</h1>
    <a href="${escapeHtml(pdfUrl)}" download>Download PDF</a>
  </div>
  <embed src="${escapeHtml(pdfUrl)}" type="application/pdf">
</body>
</html>`;
}

function markdownWrapper(markdown: string, title: string, pageUrl: string): string {
  const safeTitle = escapeHtml(title);
  const desc = markdown.replace(/[#*`>\[\]!_~\n\r]+/g, " ").trim().slice(0, 200);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${safeTitle}</title>
${ogTags(pageUrl, title, desc, "article")}
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/github-markdown-css/5.6.1/github-markdown-light.min.css">
  <style>
    body {
      box-sizing: border-box;
      min-width: 200px;
      max-width: 980px;
      margin: 0 auto;
      padding: 45px;
      background: #ffffff;
    }
    .markdown-body { font-size: 16px; }
    @media (max-width: 767px) {
      body { padding: 15px; }
    }
  </style>
</head>
<body>
  <article class="markdown-body" id="content"></article>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/marked/12.0.2/marked.min.js"></script>
  <script>
    const raw = ${JSON.stringify(markdown)};
    marked.setOptions({ breaks: true, gfm: true });
    document.getElementById('content').innerHTML = marked.parse(raw);
  </script>
</body>
</html>`;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.slice(1);

    if (request.method === "PUT" && path === "upload") {
      return handleUpload(request, env);
    }

    if (request.method === "GET" && !path) {
      return new Response("docs — document sharing", { status: 200 });
    }

    if (request.method !== "GET" || !path) {
      return new Response("Not found", { status: 404 });
    }

    const parts = path.split("/");
    const id = parts[0];
    const isRaw = parts[1] === "raw";

    return handleGet(id, isRaw, url.origin, env);
  },
} satisfies ExportedHandler<Env>;

async function handleUpload(request: Request, env: Env): Promise<Response> {
  const auth = request.headers.get("Authorization");
  const expected = `Bearer ${env.AUTH_TOKEN}`;
  if (!auth || !(await timingSafeEqual(auth, expected))) {
    return new Response("Unauthorized", { status: 401 });
  }

  const rawFilename = request.headers.get("X-Filename") || "file";
  const filename = sanitizeFilename(rawFilename);
  const contentType = request.headers.get("Content-Type") || getContentType(filename);
  const docName = request.headers.get("X-Doc-Name") || "";
  const id = generateId();
  const key = `${id}/${filename}`;

  try {
    await env.DOCS_BUCKET.put(key, request.body, {
      customMetadata: {
        filename,
        contentType,
        docName,
        uploadedAt: new Date().toISOString(),
      },
    });
  } catch {
    return new Response("Storage error", { status: 500 });
  }

  const baseUrl = new URL(request.url).origin;
  return Response.json({
    url: `${baseUrl}/${id}`,
    id,
  });
}

async function handleGet(id: string, raw: boolean, origin: string, env: Env): Promise<Response> {
  let list;
  try {
    list = await env.DOCS_BUCKET.list({ prefix: `${id}/` });
  } catch {
    return new Response("Storage error", { status: 500 });
  }
  if (!list.objects.length) {
    return new Response("Not found", { status: 404 });
  }

  const obj = await env.DOCS_BUCKET.get(list.objects[0].key);
  if (!obj) {
    return new Response("Not found", { status: 404 });
  }

  const meta = obj.customMetadata ?? {};
  const filename = meta.filename || list.objects[0].key.split("/").pop() || "file";
  const contentType = meta.contentType || getContentType(filename);
  const title = meta.docName || titleFromFilename(filename);
  const pageUrl = `${origin}/${id}`;

  if (raw) {
    const headers = new Headers();
    headers.set("Content-Type", contentType);
    headers.set("Cache-Control", "public, max-age=31536000, immutable");
    if (isPdf(filename)) {
      headers.set("Content-Disposition", `inline; filename="${sanitizeFilename(filename)}"`);
    }
    return new Response(obj.body, { headers });
  }

  if (isMarkdown(filename)) {
    const text = await obj.text();
    const html = markdownWrapper(text, title, pageUrl);
    return new Response(html, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  }

  if (isPdf(filename)) {
    const rawUrl = `${origin}/${id}/raw`;
    const html = pdfWrapper(rawUrl, title, pageUrl);
    return new Response(html, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  }

  // HTML and other files: serve as-is
  const headers = new Headers();
  headers.set("Content-Type", contentType);
  headers.set("Cache-Control", "public, max-age=31536000, immutable");
  return new Response(obj.body, { headers });
}
