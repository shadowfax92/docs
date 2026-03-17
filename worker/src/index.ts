interface Env {
  DOCS_BUCKET: R2Bucket;
  AUTH_TOKEN: string;
}

function generateId(): string {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);
  // Use rejection sampling to avoid modulo bias
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

function isMarkdown(filename: string): boolean {
  const ext = filename.split(".").pop()?.toLowerCase() || "";
  return ext === "md" || ext === "markdown";
}

function sanitizeFilename(name: string): string {
  return name.replace(/[^\w.\-]/g, "_");
}

async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const keyData = encoder.encode(a);
  const key = await crypto.subtle.importKey("raw", keyData, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode("verify"));
  const check = await crypto.subtle.sign("HMAC", key, encoder.encode("verify"));
  // Compare using the actual values
  const aBytes = encoder.encode(a.padEnd(256));
  const bBytes = encoder.encode(b.padEnd(256));
  if (aBytes.length !== bBytes.length) return false;
  let result = 0;
  for (let i = 0; i < aBytes.length; i++) {
    result |= aBytes[i] ^ bBytes[i];
  }
  return result === 0;
}

function markdownWrapper(markdown: string, title: string): string {
  const safeTitle = title.replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${safeTitle}</title>
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

    if (request.method === "GET" && path) {
      return handleGet(path, env);
    }

    if (request.method === "GET" && !path) {
      return new Response("docs — document sharing", { status: 200 });
    }

    return new Response("Not found", { status: 404 });
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
  const id = generateId();
  const key = `${id}/${filename}`;

  try {
    await env.DOCS_BUCKET.put(key, request.body, {
      customMetadata: {
        filename,
        contentType,
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

async function handleGet(id: string, env: Env): Promise<Response> {
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

  if (isMarkdown(filename)) {
    const text = await obj.text();
    const html = markdownWrapper(text, filename.replace(/\.(md|markdown)$/i, ""));
    return new Response(html, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  }

  const headers = new Headers();
  headers.set("Content-Type", contentType);
  headers.set("Cache-Control", "public, max-age=31536000, immutable");
  if (contentType === "application/pdf") {
    headers.set("Content-Disposition", `inline; filename="${sanitizeFilename(filename)}"`);
  }

  return new Response(obj.body, { headers });
}
