/** Owned loopback fixtures exercise the actual Preview -> enhanceHtml -> skill
 * runtime flow in an isolated headless browser. No R2, owner data or deployment.
 * Run from worker: node src/vendor/vim-html/quiet-browser-proof.mjs <output-dir>.
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { bake, enhanceHtml, startProofServer } from "./proof-server.mjs";

const output = resolve(process.argv[2] || "../.scratch/docs-vim-quiet/browser");
await mkdir(output, { recursive: true });
const authored = `<!doctype html><html><head><meta charset="utf-8"><title>Quiet fixture</title>
<style>body{margin:0;background:rgb(248,245,239);font:18px Georgia}main{margin:40px auto;width:620px}body::after{content:"Authored footer"}</style></head><body><main>
<h1>Quiet fixture</h1><p>Alpha point.</p><p>Needle search point.</p><p>Final comment target.</p>
<form><label>Notes <input id="notes"></label><button>Save notes</button><output></output></form></main>
<script>document.querySelector('form').onsubmit=e=>{e.preventDefault();document.querySelector('output').textContent=document.querySelector('input').value;};</script></body></html>`;
const baked = bake(authored, "/synthetic/quiet.html", "quiet-baked");
// An explicit config (even without a baked runtime) remains the author's choice.
const configured = authored.replace("</head>", '<script>window.VIM_HTML={source:"/authored/config.html",storageKey:"authored-config"};</script></head>');
// Matching public method names do not make a second, unknown core compatible.
// HTML accepts both unquoted and entity-encoded data-vh attribute values.
const replacement = "window.extraNumbers=true;window.__VH={version:1,booted:false,init:function(fn){fn();},gutter:{numbers:function(){return window.extraNumbers;},toggleNumbers:function(){window.extraNumbers=!window.extraNumbers;}}};";
const sources = {
  "/authored": authored, "/baked": baked, "/baked-repeat": baked,
  "/baked-crlf": baked.replace(/\n/g, "\r\n"),
  "/baked-later": baked + "<script>window.__VH.on('ready',function(){if(!window.__VH.gutter.numbers())window.__VH.gutter.toggleNumbers();});</script>",
  "/baked-unknown": baked.replace("VH.version = 1;", "VH.version = 2;"),
  "/baked-async": baked.replace('<script data-vh="runtime">', '<script type="module" data-vh="runtime">'),
  "/baked-csp": baked,
  "/baked-meta": baked.replace("</head>", '<meta http-equiv="Content-Security-Policy" content="script-src \'unsafe-inline\'; style-src \'unsafe-inline\'"></head>'),
  "/baked-inert": "<template>" + baked + "</template>",
  "/baked-unclosed": baked + "<template>",
  "/baked-duplicate-unquoted": baked + "<script data-vh=runtime>" + replacement + "</script>",
  "/baked-duplicate-encoded": baked + '<script data-vh="runt&#105;me">' + replacement + "</script>",
  "/configured": configured,
  "/preview": { markdown: "# Generated fixture\n\nAlpha point.\n\nNeedle search point.\n\nFinal comment target." },
};
let server;
let browser;
const result = { complete: false, checks: [], errors: [], serverErrors: [] };
const check = (name, detail = {}) => { result.checks.push({ name, ...detail }); console.log("PASS " + name); };
try {
  server = await startProofServer({ sources, id: "Quiet123", title: "Quiet fixture", route: async ({ path, variant, summary, render }) => {
    if (variant !== "page") return;
    // Preview intentionally owns authored headers. Cross the enhancement seam
    // directly for header-CSP rejection without discarding an opened response.
    if (path === "/baked-csp") return enhanceHtml(new Response(baked, { headers: { "Content-Type": "text/html", "Content-Security-Policy": "script-src 'none'" } }), summary);
    if (path !== "/baked-repeat") return;
    // Cross the same production seam with already-enhanced source. Exact
    // equality guards against two startup hooks as well as two runtime cores.
    const response = await render();
    const once = await response.text();
    const twice = await (await enhanceHtml(new Response(once, response), { id: "Other123", title: "Do not replace", publicUrl: "https://wrong.example" })).text();
    assert.equal(twice, once);
    return new Response(twice, response);
  } });
  result.serverErrors = server.serverErrors;
  const origin = server.origin;
  browser = await chromium.launch({ headless: true, channel: "chromium" });
  result.browser = browser.version();
  const newContext = () => browser.newContext({ viewport: { width: 1280, height: 900 }, permissions: ["clipboard-read", "clipboard-write"] });
  for (const path of ["/authored", "/preview", "/baked", "/baked-repeat", "/baked-crlf"]) {
    // Baked routes intentionally share a source key; isolated profiles prevent
    // comments/preferences from a previous fixture from contaminating the next.
    const context = await newContext();
    context.setDefaultTimeout(10000);
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
    const served = await (await fetch(origin + path)).text();
    if (path.startsWith("/baked")) {
      assert(served.startsWith(sources[path]));
      assert.equal(await page.locator("[data-docs-vim-quiet]").count(), 1);
      assert.equal(await page.locator('script[data-vh="runtime"]').count(), 1);
      assert.equal(await page.locator('script[data-vh="config"]').count(), 1);
      assert.equal(await page.locator(".docs-vim-controls").count(), 0);
      assert.deepEqual(await page.evaluate(() => ({ source: window.__VH.cfg.source, key: window.__VH.cfg.storageKey, theme: window.__VH.cfg.theme })), { source: "/synthetic/quiet.html", key: "quiet-baked", theme: "none" });
      check(path + " preserves original source prefix, runtime/config/theme/comment identity and has exactly one hook");
    }
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
    const sourceIdentity = path.startsWith("/baked") ? "/synthetic/quiet.html" : origin + path;
    assert(exported.includes("@" + sourceIdentity + "#L3") && exported.includes("#L1-2"));
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
    await context.close();
  }
  for (const path of ["/configured", "/baked-unknown", "/baked-async", "/baked-csp", "/baked-meta", "/baked-inert", "/baked-unclosed", "/baked-duplicate-unquoted", "/baked-duplicate-encoded"]) {
    assert.equal(await (await fetch(origin + path)).text(), sources[path]);
    check(path + " unsupported source remains byte-identical");
    if (path.startsWith("/baked-duplicate")) {
      const context = await newContext();
      const page = await context.newPage();
      await page.goto(origin + path);
      assert.equal(await page.evaluate(() => window.extraNumbers), true);
      assert.equal(await page.locator("[data-docs-vim-quiet]").count(), 0);
      check(path + " does not initialize or change the incompatible live runtime");
      await context.close();
    }
  }
  for (const variant of ["raw", "download"]) {
    assert.equal(await (await fetch(origin + "/baked/" + variant)).text(), baked);
    check("baked " + variant + " returns exact stored bytes without the startup hook");
  }
  const laterContext = await newContext();
  const later = await laterContext.newPage();
  await later.goto(origin + "/baked-later");
  await later.waitForFunction(() => window.__VH?.booted);
  assert.equal(await later.locator("[data-docs-vim-quiet]").count(), 1);
  assert.equal(await later.evaluate(() => window.__VH.gutter.numbers()), true);
  await later.keyboard.press("Space"); await later.keyboard.type("ul");
  assert.equal(await later.evaluate(() => window.__VH.gutter.numbers()), false);
  check("later authored ready handler and manual toggle can override startup default");
  await laterContext.close();
  assert.deepEqual(result.errors, []);
  assert.deepEqual(server.serverErrors, []);
  result.complete = true;
} finally {
  // Only resources created by this process are closed. Persist a failing proof
  // too, so an interrupted run cannot be mistaken for browser acceptance.
  try { if (browser) await browser.close(); }
  finally {
    if (server) await server.close();
    await writeFile(resolve(output, "quiet-browser-proof.json"), JSON.stringify(result, null, 2) + "\n");
  }
}
