/** Owned loopback fixtures exercise the actual Preview -> enhanceHtml -> skill
 * runtime flow in an isolated headless browser. No R2, owner data or deployment.
 * Run from worker: node src/vendor/vim-html/quiet-browser-proof.mjs <output-dir>.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";

const output = resolve(process.argv[2] || "../.scratch/docs-vim-quiet/browser");
await mkdir(output, { recursive: true });
const bundle = await build({
  entryPoints: [fileURLToPath(new URL("../../preview.ts", import.meta.url))],
  bundle: true, write: false, platform: "node", format: "esm", target: "es2022",
});
const { renderDocument } = await import("data:text/javascript;base64," + Buffer.from(bundle.outputFiles[0].text).toString("base64"));
const authored = `<!doctype html><html><head><meta charset="utf-8"><title>Quiet fixture</title>
<style>body{margin:0;background:rgb(248,245,239);font:18px Georgia}main{margin:40px auto;width:620px}body::after{content:"Authored footer"}</style></head><body><main>
<h1>Quiet fixture</h1><p>Alpha point.</p><p>Needle search point.</p><p>Final comment target.</p>
<form><label>Notes <input id="notes"></label><button>Save notes</button><output></output></form></main>
<script>document.querySelector('form').onsubmit=e=>{e.preventDefault();document.querySelector('output').textContent=document.querySelector('input').value;};</script></body></html>`;
const baked = execFileSync("python3", ["-B", "-c",
  "import sys;sys.path.insert(0,sys.argv[1]);import build;print(build.build(sys.stdin.read(),theme='none',source='/synthetic/quiet.html',key='quiet-baked')[0])",
  fileURLToPath(new URL("upstream/scripts", import.meta.url)),
], { input: authored, encoding: "utf8" });
// An explicit config (even without a baked runtime) remains the author's choice.
const configured = authored.replace("</head>", '<script>window.VIM_HTML={source:"/authored/config.html",storageKey:"authored-config"};</script></head>');
const sources = { "/authored": authored, "/baked": baked, "/configured": configured, "/preview": "# Generated fixture\n\nAlpha point.\n\nNeedle search point.\n\nFinal comment target." };
const serverErrors = [];
const server = createServer(async (req, res) => {
  try {
    const path = new URL(req.url, origin).pathname;
    if (!(path in sources)) { res.writeHead(404); res.end(); return; }
    const generated = path === "/preview";
    const source = sources[path];
    const bytes = new TextEncoder().encode(source);
    const summary = {
      id: "Quiet123", version: "fixture-v1", title: "Quiet fixture", filename: generated ? "quiet.md" : "quiet.html",
      kind: generated ? "markdown" : "html", mime: generated ? "text/markdown" : "text/html",
      sizeBytes: bytes.length, uploadedAt: "2026-10-15T00:00:00.000Z", timeSource: "r2", createdAt: null,
      publicUrl: origin + path, rawUrl: origin + path + "/raw", downloadUrl: origin + path + "/download", objectCount: 1, warnings: [],
    };
    const response = await renderDocument({
      summary, objects: [{ sizeBytes: bytes.length }],
      // Preview opens once, exactly as it would at the Documents seam; every
      // request gets a fresh disposable stream instead of an R2 dependency.
      openBody: async () => ({ body: new Response(bytes).body }),
    }, "page", new Request(origin + path));
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) { serverErrors.push(String(error)); res.writeHead(500); res.end("Fixture failed"); }
});
let origin;
let browser;
const result = { complete: false, checks: [], errors: [], serverErrors };
const check = (name, detail = {}) => { result.checks.push({ name, ...detail }); console.log("PASS " + name); };
try {
  await new Promise((ok, fail) => { server.once("error", fail); server.listen(0, "127.0.0.1", ok); });
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true, channel: "chromium" });
  result.browser = browser.version();
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, permissions: ["clipboard-read", "clipboard-write"] });
  context.setDefaultTimeout(10000);
  for (const path of ["/authored", "/preview"]) {
    const page = await context.newPage();
    page.on("pageerror", error => result.errors.push(String(error)));
    await page.addInitScript(() => {
      // Observe every render opportunity from before parsing through runtime
      // startup. A mutation sample also catches a visible gutter left between
      // tasks; transient DOM writes in one synchronous task cannot paint.
      window.quietProof = { samples: 0, visibleSamples: 0, stopped: false };
      const sample = () => {
        const proof = window.quietProof;
        if (proof.stopped || !document.querySelector(".vh-n")) return;
        proof.samples++;
        if (Array.from(document.querySelectorAll(".vh-ln")).some(row => {
          const n = row.querySelector(".vh-n");
          const after = getComputedStyle(row, "::after");
          return row.getClientRects().length && ((n && getComputedStyle(n).display !== "none") ||
            (after.display !== "none" && !["none", "normal", '""'].includes(after.content)));
        })) proof.visibleSamples++;
      };
      new MutationObserver(sample).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "style"] });
      const frame = () => { sample(); if (!window.quietProof.stopped) requestAnimationFrame(frame); };
      requestAnimationFrame(frame);
    });
    await page.goto(origin + path);
    await page.waitForFunction(() => document.documentElement.hasAttribute("data-vh-booted"));
    await page.evaluate(() => new Promise(ok => requestAnimationFrame(() => requestAnimationFrame(ok))));
    const initial = await page.evaluate(() => {
      window.quietProof.stopped = true;
      return { ...window.quietProof, numbers: window.__VH.gutter.numbers(), lines: window.__VH.lines.count(),
        hidden: document.querySelector(".vh-gutter").classList.contains("vh-nonu"),
        numberDisplay: getComputedStyle(document.querySelector(".vh-n")).display,
        relativeDisplay: getComputedStyle(document.querySelector(".vh-ln"), "::after").display };
    });
    assert.equal(initial.numbers, false, path + " defaults to numbers off");
    assert(initial.hidden && initial.lines >= 4 && initial.samples > 0);
    assert.equal(initial.visibleSamples, 0, "no visible number sample before first settled paint");
    assert.equal(initial.numberDisplay, "none");
    assert.equal(initial.relativeDisplay, "none");
    check(path + " starts quiet without number flash and retains line model", initial);
    await page.screenshot({ path: resolve(output, path.slice(1) + "-quiet.png") });

    const initialPrefs = await page.evaluate(() => localStorage.getItem("vim-html:prefs"));
    await page.keyboard.press("Space"); await page.keyboard.type("ul");
    assert.equal(await page.evaluate(() => window.__VH.gutter.numbers()), true);
    assert.notEqual(await page.locator(".vh-n").first().evaluate(el => getComputedStyle(el).display), "none");
    await page.screenshot({ path: resolve(output, path.slice(1) + "-numbers-on.png") });
    await page.keyboard.press("Space"); await page.keyboard.type("ul");
    assert.equal(await page.evaluate(() => window.__VH.gutter.numbers()), false);
    assert.equal(await page.evaluate(() => localStorage.getItem("vim-html:prefs")), initialPrefs);
    check(path + " Space u l enables and disables visible numbers");

    await page.keyboard.type("ggjk");
    assert.equal(await page.evaluate(() => window.__VH.cursor.get()), 1);
    await page.keyboard.press("/"); await page.keyboard.type("Needle"); await page.keyboard.press("Enter");
    const target = await page.evaluate(() => window.__VH.cursor.get());
    assert.equal(target, 3);
    await page.keyboard.type("gcc"); await page.getByRole("textbox", { name: "Comment", exact: true }).fill("Quiet line comment");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => window.__VH.comments.all().length === 1);
    assert.equal(await page.evaluate(() => window.__VH.comments.all()[0].anchor.startLine), target);
    await page.keyboard.type("ma");
    const signs = await page.locator(".vh-ln").nth(target - 1).evaluate(el => ({ comment: el.classList.contains("vh-ln-c"), mark: el.dataset.mark, background: getComputedStyle(el).backgroundImage, markContent: getComputedStyle(el, "::before").content }));
    assert(signs.comment && signs.mark === "a" && signs.background !== "none" && signs.markContent.includes("a"));
    await page.keyboard.type("ggVj"); await page.keyboard.press("Enter");
    await page.getByRole("textbox", { name: "Comment", exact: true }).fill("Quiet selection comment"); await page.keyboard.press("Enter");
    await page.waitForFunction(() => window.__VH.comments.all().length === 2);
    await page.keyboard.type("gy");
    await page.waitForFunction(() => window.__VH.clip.last.includes("Quiet selection comment"));
    const exported = await page.evaluate(() => window.__VH.clip.last);
    assert(exported.includes("@" + origin + path + "#L3") && exported.includes("#L1-2"));
    await page.keyboard.press("Space"); await page.keyboard.press("?");
    await page.locator("#vh-help").waitFor({ state: "visible" });
    assert((await page.locator("#vh-help").innerText()).includes("toggle line numbers"));
    await page.keyboard.press("Escape");
    assert.equal(await page.evaluate(() => window.__VH.gutter.numbers()), false);
    check(path + " navigation/search/selection/comments/export/help and gutter signs work while quiet", { target, signs });

    if (path === "/authored") {
      assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), "rgb(248, 245, 239)");
      assert.equal(await page.evaluate(() => getComputedStyle(document.body, "::after").content), '"Authored footer"');
      assert.equal(await page.locator("main").evaluate(el => el.getBoundingClientRect().width), 620);
      await page.getByLabel("Notes", { exact: true }).pressSequentially("j k search comments");
      await page.getByRole("button", { name: "Save notes", exact: true }).click();
      assert.equal(await page.locator("output").textContent(), "j k search comments");
      check("authored styles, layout, pseudo-content and native form typing/submission preserved");
    }
    // The default belongs to each hosted page load, while comments retain the
    // stable document storage key across reloads. A manual toggle writes no prefs.
    await page.evaluate(() => document.activeElement.blur());
    await page.keyboard.press("Escape");
    const prefsBeforeReload = await page.evaluate(() => localStorage.getItem("vim-html:prefs"));
    await page.keyboard.press("Space"); await page.keyboard.type("ul");
    assert.equal(await page.evaluate(() => window.__VH.gutter.numbers()), true);
    await page.reload();
    await page.waitForFunction(() => window.__VH?.comments?.all().length === 2);
    assert.equal(await page.evaluate(() => window.__VH.gutter.numbers()), false);
    assert.equal(await page.evaluate(() => localStorage.getItem("vim-html:prefs")), prefsBeforeReload);
    check(path + " reload restores quiet default and stored comments without global preferences");
    await page.close();
  }
  for (const path of ["/baked", "/configured"]) {
    assert.equal(await (await fetch(origin + path)).text(), sources[path]);
    const page = await context.newPage();
    page.on("pageerror", error => result.errors.push(String(error)));
    await page.goto(origin + path);
    if (path === "/baked") {
      assert.equal(await page.locator('script[data-vh="runtime"]').count(), 1);
      assert.equal(await page.locator('script[data-vh="config"]').count(), 1);
      assert.deepEqual(await page.evaluate(() => ({ source: window.__VH.cfg.source, key: window.__VH.cfg.storageKey, numbers: window.__VH.gutter.numbers() })), { source: "/synthetic/quiet.html", key: "quiet-baked", numbers: true });
      assert.equal(await page.locator(".docs-vim-controls").count(), 0);
      await page.keyboard.type("gggcc");
      await page.getByRole("textbox", { name: "Comment", exact: true }).fill("Baked identity comment"); await page.keyboard.press("Enter");
      await page.keyboard.type("gy");
      await page.waitForFunction(() => window.__VH.clip.last.includes("@/synthetic/quiet.html#L1"));
    } else {
      assert.equal(await page.locator('script[data-vh="runtime"]').count(), 0);
      assert.equal(await page.evaluate(() => window.VIM_HTML.storageKey), "authored-config");
    }
    check(path + " bytes and authored runtime/config identity unchanged");
    await page.close();
  }
  assert.deepEqual(result.errors, []);
  assert.deepEqual(serverErrors, []);
  result.complete = true;
} finally {
  // Only resources created by this process are closed. Persist a failing proof
  // too, so an interrupted run cannot be mistaken for browser acceptance.
  try { if (browser) await browser.close(); }
  finally {
    await new Promise(ok => server.close(ok));
    await writeFile(resolve(output, "quiet-browser-proof.json"), JSON.stringify(result, null, 2) + "\n");
  }
}
