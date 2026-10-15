import type { ResolvedDocument } from "./documents";
import { enhanceHtml } from "./vim";

/** Public rendering owns legacy wrappers and stream handoff; it never receives catalog secrets. */
export async function renderDocument(
  doc: ResolvedDocument,
  variant: "page" | "raw" | "download",
  request: Request,
): Promise<Response> {
  const obj = await doc.openBody();
  if (!obj) return new Response("Not found", { status: 404 });
  const { filename, mime: contentType, title } = doc.summary;
  const identity = { id: doc.summary.id, title, publicUrl: doc.summary.publicUrl };
  const pageUrl = doc.summary.publicUrl;

  if (variant === "raw" || variant === "download") {
    const headers = new Headers();
    headers.set("Content-Type", contentType);
    headers.set("Cache-Control", "public, max-age=31536000, immutable");
    headers.set("Content-Disposition", contentDisposition(variant === "download" ? "attachment" : "inline", filename));
    return new Response(obj.body, { headers });
  }

  if (isMarkdown(filename)) {
    const text = await obj.text();
    const html = markdownWrapper(text, title, pageUrl);
    return enhanceHtml(new Response(html, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    }), identity);
  }

  if (isPdf(filename)) {
    // Wrapper pages do not consume the R2 payload; release its connection before returning HTML.
    await obj.body.cancel();
    const rawUrl = doc.summary.rawUrl;
    const html = pdfWrapper(rawUrl, title, pageUrl);
    return enhanceHtml(new Response(html, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    }), identity);
  }

  if (isHtml(filename)) {
    const headers = new Headers();
    headers.set("Content-Type", contentType);
    headers.set("Cache-Control", "public, max-age=31536000, immutable");
    return enhanceHtml(new Response(obj.body, { headers }), identity);
  }

  const downloadUrl = doc.summary.downloadUrl;
  await obj.body.cancel();
  const html = downloadWrapper(filename, title, pageUrl, contentType, obj.size, downloadUrl);
  return enhanceHtml(new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  }), identity);
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

function isHtml(filename: string): boolean {
  const ext = fileExt(filename);
  return ext === "html" || ext === "htm";
}

function escapeHtml(s: string): string {
  return s.replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function titleFromFilename(filename: string): string {
  return filename.replace(/\.[^.]+$/, "").replace(/[_-]/g, " ");
}

function formatBytes(size: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = size;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  if (unit === 0) return `${value} ${units[unit]}`;
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

function contentDisposition(disposition: "inline" | "attachment", filename: string): string {
  return `${disposition}; filename="${filename.replace(/[^\w.\-]/g, "_")}"`;
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

function downloadWrapper(filename: string, title: string, pageUrl: string, contentType: string, size: number, downloadUrl: string): string {
  const safeTitle = escapeHtml(title);
  const safeFilename = escapeHtml(filename);
  const safeType = escapeHtml(contentType);
  const safeSize = escapeHtml(formatBytes(size));
  const safeDownloadUrl = escapeHtml(downloadUrl);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${safeTitle}</title>
${ogTags(pageUrl, title, `Download ${filename}`, "article")}
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      padding: 24px;
      background: #f6f8fa;
      color: #1f2328;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
    }
    main {
      width: min(100%, 520px);
      padding: 28px;
      border: 1px solid #d0d7de;
      border-radius: 8px;
      background: #fff;
      box-shadow: 0 12px 32px rgba(31, 35, 40, 0.08);
    }
    h1 {
      margin: 0 0 16px;
      font-size: 20px;
      line-height: 1.3;
      font-weight: 650;
      overflow-wrap: anywhere;
    }
    dl {
      display: grid;
      grid-template-columns: max-content 1fr;
      gap: 8px 16px;
      margin: 0 0 24px;
      font-size: 14px;
    }
    dt { color: #59636e; }
    dd { margin: 0; overflow-wrap: anywhere; }
    a {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: 40px;
      padding: 0 16px;
      border-radius: 6px;
      background: #0969da;
      color: #fff;
      font-size: 14px;
      font-weight: 600;
      text-decoration: none;
    }
    a:hover { background: #0757b8; }
  </style>
</head>
<body>
  <main>
    <h1>${safeTitle}</h1>
    <dl>
      <dt>File</dt>
      <dd>${safeFilename}</dd>
      <dt>Type</dt>
      <dd>${safeType}</dd>
      <dt>Size</dt>
      <dd>${safeSize}</dd>
    </dl>
    <a href="${safeDownloadUrl}">Download</a>
  </main>
</body>
</html>`;
}

