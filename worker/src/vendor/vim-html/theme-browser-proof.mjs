/** Headless proof that a generated viewer has one working light/dark control with
 * the hosted Vim layer on or off: real mouse clicks, touch taps and trusted keys
 * change the computed document, toolbar and runtime-chrome colors together, and
 * the choice survives reload. Standalone viewers keep working; authored and baked
 * pages keep their own theme and the skill's. Every fixture crosses the real
 * Preview -> enhanceHtml -> runtime path in a disposable profile on a loopback
 * server; no owner browser, storage or document is touched, nothing is deployed.
 * Run from worker: node src/vendor/vim-html/theme-browser-proof.mjs <output-dir>.
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { bake, enhanceHtml, startProofServer } from "./proof-server.mjs";

const output = resolve(process.argv[2] || "../.scratch/docs-theme-toggle/browser");
await mkdir(output, { recursive: true });

// The owner's page: a generated Markdown viewer with headings, a table and code.
const markdown = ["# Voice for outreach", "Adapted text with `inline code` and a [link](https://example.com).",
  "| # | What we did | What Nikhil does |\n|---|---|---|\n| 1 | Never said who he is | `i'm a founder` |",
  "## 1. The eight shifts", ...Array.from({ length: 24 }, (_, i) => `Paragraph ${i + 1} keeps the page scrollable.`)].join("\n\n");
// An authored page that reuses the viewer's markup names for its OWN theme. Its
// toggle sits left so a real click reaches it beside the skill's corner toggle.
const authored = `<!doctype html><html data-theme="light"><head><meta charset="utf-8"><title>Authored theme</title>
<style>:root{--bg:rgb(250,240,220)}:root[data-theme=dark]{--bg:rgb(20,30,40)}body{margin:0;background:var(--bg);font:18px Georgia}
nav{display:flex;padding:12px 16px}main{margin:24px auto;width:620px}</style></head><body>
<nav class="viewer-bar"><button type="button" data-theme-toggle>Authored theme</button></nav><main><h1>Authored theme</h1><p>Alpha.</p><p>Bravo.</p></main>
<script>document.querySelector('[data-theme-toggle]').onclick=function(){var d=document.documentElement;d.dataset.theme=d.dataset.theme==='dark'?'light':'dark';localStorage.setItem('authored-theme',d.dataset.theme);};</script></body></html>`;
const baked = bake(authored, "/synthetic/theme.html", "theme-baked");
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
const formats = {
  "/markdown": { markdown },
  "/text": { filename: "notes.txt", mime: "text/plain", body: Array.from({ length: 40 }, (_, i) => `log line ${i + 1}`).join("\n") },
  "/json": { filename: "data.json", mime: "application/json", body: '{"name":"voice","shifts":[1,2,3],"nested":{"ok":true}}' },
  "/csv": { filename: "table.csv", mime: "text/csv", body: "shift,before,after\n1,never said,founder\n2,great connecting,thanks" },
  "/image": { filename: "pixel.png", mime: "image/png", body: png },
  "/audio": { filename: "clip.mp3", mime: "audio/mpeg", body: "not really audio" },
  "/unsupported": { filename: "bundle.zip", mime: "application/zip", body: "PK fixture" },
};
const sources = { ...formats, "/standalone": { markdown }, "/repeat": { markdown }, "/authored": authored, "/baked": baked };

const LIGHT_BG = "rgb(255, 255, 255)", DARK_BG = "rgb(14, 14, 14)";
const ICON = { light: "☾", dark: "☀" };
const LABEL = { light: "Switch to dark theme", dark: "Switch to light theme" };
const flip = scheme => (scheme === "dark" ? "light" : "dark");
const luminance = rgb => { const [r, g, b] = rgb.match(/\d+/g).map(Number); return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255; };

let server;
let browser;
const result = { complete: false, checks: [], errors: [], serverErrors: [] };
const check = (name, detail = {}) => { result.checks.push({ name, ...detail }); console.log("PASS " + name); };

try {
  server = await startProofServer({ sources, id: "Theme123", title: "Voice", route: async ({ path, variant, render }) => {
    if (variant !== "page") return;
    if (path === "/standalone") {
      // The viewer as served when injection is unavailable (size/CSP gates):
      // Preview's own bytes, i.e. everything before enhanceHtml's suffix.
      const html = await (await render()).text();
      const cut = html.indexOf("\n<!-- vim-html:head:begin -->");
      assert(cut > 0);
      return new Response(html.slice(0, cut), { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }
    if (path === "/repeat") {
      // A second pass, flagged or not, must not add a runtime or a second adapter.
      const response = await render();
      const once = await response.text();
      for (const page of [{}, { generatedViewer: true }]) {
        assert.equal(await (await enhanceHtml(new Response(once, response), { id: "Other123", title: "Other", publicUrl: "https://wrong.example" }, page)).text(), once);
      }
      return new Response(once, response);
    }
  } });
  result.serverErrors = server.serverErrors;
  const origin = server.origin;
  browser = await chromium.launch({ headless: true, channel: "chromium" });
  result.browser = browser.version();

  const DESKTOP = { viewport: { width: 1280, height: 900 } };
  const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };
  async function open(path, options = DESKTOP, { vim = true } = {}) {
    const context = await browser.newContext(options);
    context.setDefaultTimeout(10000);
    const page = await context.newPage();
    page.on("pageerror", error => result.errors.push(path + ": " + String(error)));
    // Sample every rendering opportunity from before parsing: a dark reader must
    // never get a light document frame or a light status line on load.
    await page.addInitScript(() => {
      const seen = window.themeFrames = { frames: 0, bodies: [], statuses: [] };
      const frame = () => {
        if (document.body) {
          seen.frames++;
          const body = getComputedStyle(document.body).backgroundColor;
          if (!seen.bodies.includes(body)) seen.bodies.push(body);
          const status = document.getElementById("vh-status");
          if (status && status.getClientRects().length) {
            const color = getComputedStyle(status).backgroundColor;
            if (!seen.statuses.includes(color)) seen.statuses.push(color);
          }
        }
        if (seen.frames < 40) requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    });
    await page.goto(origin + path);
    if (vim) await page.waitForFunction(() => document.documentElement.hasAttribute("data-vh-booted"));
    return { context, page };
  }
  const reload = async (page, vim = true) => {
    await page.reload();
    if (vim) await page.waitForFunction(() => document.documentElement.hasAttribute("data-vh-booted"));
  };
  // Frame samples since navigation; wait for a few so an early read is never vacuous.
  const frames = async page => {
    await page.waitForFunction(() => window.themeFrames && window.themeFrames.frames >= 3);
    return page.evaluate(() => window.themeFrames);
  };

  // Everything a reader can see or reach about the theme, measured from the page.
  const look = page => page.evaluate(() => {
    const root = document.documentElement;
    const shown = el => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
    const candidates = new Set(document.querySelectorAll("[data-theme-toggle], #vh-theme, .vh-st-theme, button[aria-label*='theme' i], button[title*='theme' i]"));
    const controls = [...candidates].filter(shown).map(el => {
      const r = el.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2;
      const top = document.elementFromPoint(x, y);
      return { name: el.matches("[data-theme-toggle]") ? "viewer" : el.id || el.className, x, y,
        rect: [r.left, r.top, r.right, r.bottom], hit: !!top && (top === el || el.contains(top)) };
    });
    const toggle = document.querySelector("[data-theme-toggle]");
    const status = document.getElementById("vh-status");
    const bar = document.querySelector(".viewer-bar");
    const download = document.querySelector(".viewer-top .pill");
    return {
      theme: root.getAttribute("data-theme"), vhScheme: root.getAttribute("data-vh-scheme"),
      body: getComputedStyle(document.body).backgroundColor,
      text: getComputedStyle(document.querySelector("main") || document.body).color,
      bar: bar ? getComputedStyle(bar).backgroundColor : null,
      status: shown(status) ? getComputedStyle(status).backgroundColor : null,
      icon: toggle ? toggle.innerText.trim() : null, // rendered glyph only
      label: toggle && toggle.getAttribute("aria-label"), title: toggle && toggle.title,
      controls, focused: document.activeElement === toggle ? "toggle" : document.activeElement.tagName,
      downloadRect: download ? [download.getBoundingClientRect().left, download.getBoundingClientRect().right] : null,
      width: innerWidth, scrollWidth: document.documentElement.scrollWidth,
      docsTheme: localStorage.getItem("docs-theme"), prefs: localStorage.getItem("vim-html:prefs"),
      vimOff: root.hasAttribute("data-docs-vim-off"),
    };
  });
  // A generated viewer in `scheme`: document, toolbar, text, icon, label and
  // (when Vim shows) runtime chrome agree, with exactly one reachable control.
  function expectViewer(state, scheme, where) {
    assert.equal(state.controls.length, 1, where + " visible theme controls " + JSON.stringify(state.controls.map(c => c.name)));
    assert.equal(state.controls[0].name, "viewer", where + " the one control is the toolbar toggle");
    assert(state.controls[0].hit, where + " toggle is not covered");
    assert.equal(state.theme, scheme, where + " data-theme");
    assert.equal(state.body, scheme === "dark" ? DARK_BG : LIGHT_BG, where + " document background");
    assert.equal(state.bar, state.body, where + " toolbar background");
    assert(scheme === "dark" ? luminance(state.text) > 0.8 : luminance(state.text) < 0.2, where + " text contrast " + state.text);
    assert.equal(state.icon, ICON[scheme], where + " icon");
    assert.equal(state.label, LABEL[scheme], where + " accessible label");
    assert.equal(state.title, LABEL[scheme], where + " tooltip");
    if (state.status !== null) {
      assert.equal(state.vhScheme, scheme, where + " runtime scheme mirrors the viewer");
      assert(scheme === "dark" ? luminance(state.status) < 0.2 : luminance(state.status) > 0.8, where + " status line " + state.status);
    }
  }
  const click = async (page, state) => page.mouse.click(state.controls[0].x, state.controls[0].y);
  const command = async (page, text) => { await page.keyboard.press(":"); await page.keyboard.type(text); await page.keyboard.press("Enter"); };
  const leaderUb = async page => { await page.keyboard.press("Space"); await page.keyboard.type("ub"); };

  // 1. The owner's case: generated Markdown, Vim on, desktop, every input path.
  {
    const { context, page } = await open("/markdown");
    let state = await look(page);
    expectViewer(state, "light", "markdown fresh");
    assert(state.scrollWidth <= state.width, "no horizontal page scroll");
    assert.equal(state.docsTheme, null, "loading never writes docs-theme");
    const prefs = state.prefs;
    assert.equal(await page.evaluate(() => document.documentElement.hasAttribute("data-docs-viewer-theme")), true);
    assert.equal(await page.locator('script[data-vh="runtime"]').count(), 1);
    await page.screenshot({ path: resolve(output, "markdown-vim-on-light.png") });

    await click(page, state);
    state = await look(page);
    expectViewer(state, "dark", "markdown after mouse click");
    assert.equal(state.docsTheme, "dark");
    assert.notEqual(state.focused, "toggle", "a pointer click hands keys back to the page");
    await page.screenshot({ path: resolve(output, "markdown-vim-on-dark.png") });
    check("generated Markdown with Vim on: one uncovered toolbar toggle; a mouse click darkens document, toolbar and Vim chrome together", { light: LIGHT_BG, dark: state.body, status: state.status });

    const line = await page.evaluate(() => window.__VH.cursor.get());
    await page.keyboard.press("j");
    assert.equal(await page.evaluate(() => window.__VH.cursor.get()), line + 1, "j moves the cursor after a theme click");
    await leaderUb(page);
    state = await look(page);
    expectViewer(state, "light", "markdown after Space u b");
    assert.equal(state.docsTheme, "light");
    await leaderUb(page);
    expectViewer(await look(page), "dark", "markdown after second Space u b");
    check("after a click, Vim keys reach the page and Space u b flips the same theme exactly once each time (dark -> light -> dark)");

    await command(page, "theme light"); expectViewer(await look(page), "light", ":theme light");
    await command(page, "theme light"); expectViewer(await look(page), "light", ":theme light again");
    await command(page, "theme dark"); expectViewer(await look(page), "dark", ":theme dark");
    await command(page, "theme"); expectViewer(await look(page), "light", ":theme toggle");
    assert.equal(await page.evaluate(() => window.__VH.scheme.get()), "light");
    check(":theme light|dark|toggle drive the viewer's theme, label and storage");

    // Keyboard on the toggle itself: native activation, never a Vim leader.
    await page.focus(".viewer-top .pill");
    await page.keyboard.press("Tab");
    assert.equal((await look(page)).focused, "toggle", "Tab reaches the toggle with Vim on");
    await page.keyboard.press("Enter");
    state = await look(page);
    expectViewer(state, "dark", "Enter on focused toggle");
    assert.equal(state.focused, "toggle", "keyboard activation keeps focus");
    await page.keyboard.press("Space");
    await page.waitForTimeout(400); // past which-key's 300 ms delay: no leader popup may appear
    state = await look(page);
    expectViewer(state, "light", "Space on focused toggle");
    assert.equal(await page.evaluate(() => window.__VH.mode.get()), "normal");
    assert.equal(await page.locator(".vh-wk").evaluate(el => el.getClientRects().length > 0).catch(() => false), false, "Space on the button opened no which-key");
    check("Tab, Enter and Space operate the focused toggle natively once each, without Vim capturing them");

    // The skill keeps its : history in prefs; only the scheme belongs to another authority.
    assert.equal(JSON.parse(prefs).scheme, undefined);
    assert.equal(JSON.parse((await look(page)).prefs).scheme, undefined, "generated pages never write the global vim-html:prefs scheme");
    assert.equal(await page.evaluate(() => window.__VH.gutter.numbers()), false, "quiet numbers default kept");
    assert.equal(await page.evaluate(() => window.__VH.keys.list().filter(k => k.seq === "dC").length), 1, "dC kept");
    assert(await page.evaluate(() => window.__VH.keys.list().some(k => /toggle light \/ dark/.test(k.desc))), "help still lists Space u b");
    check("vim-html:prefs, quiet numbers, dC and the Space u b help row are unchanged");

    // Focus is still on the toggle after keyboard use, where keys stay native;
    // a reader clicks back into the text before typing a Vim command.
    await page.locator("main p").first().click();
    await command(page, "theme dark");
    await reload(page);
    const sampled = await frames(page);
    state = await look(page);
    expectViewer(state, "dark", "markdown after reload");
    assert.deepEqual(sampled.bodies, [DARK_BG], "no light document frame on reload " + JSON.stringify(sampled));
    assert(sampled.statuses.length && sampled.statuses.every(color => luminance(color) < 0.2), "no light status-line frame on reload " + JSON.stringify(sampled));
    check("a stored dark choice paints dark from the first frame on reload, chrome included", sampled);
    await context.close();
  }

  // 2. Vim off and on transitions, persisted across reload.
  {
    const { context, page } = await open("/markdown");
    await page.getByRole("button", { name: "Vim off" }).click();
    let state = await look(page);
    assert(state.vimOff && state.status === null);
    expectViewer(state, "light", "Vim off");
    await click(page, state);
    expectViewer(await look(page), "dark", "Vim off click");
    await page.screenshot({ path: resolve(output, "markdown-vim-off-dark.png") });
    await leaderUb(page);
    expectViewer(await look(page), "dark", "Vim off ignores Space u b");
    await reload(page);
    state = await look(page);
    assert(state.vimOff);
    expectViewer(state, "dark", "Vim off reload");
    await click(page, state);
    expectViewer(await look(page), "light", "Vim off click after reload");
    await click(page, await look(page));
    await page.getByRole("button", { name: "Vim on" }).click();
    state = await look(page);
    assert(!state.vimOff && state.status !== null);
    expectViewer(state, "dark", "Vim back on shows chrome matching the dark choice made while off");
    await leaderUb(page);
    expectViewer(await look(page), "light", "Space u b after Vim back on");
    check("with Vim off the toolbar toggle works and persists; turning Vim on shows matching chrome and Space u b works again");
    await context.close();
  }

  // 3. Conflicting saved choices: the viewer's docs-theme wins over the skill's global scheme.
  for (const [docsTheme, scheme] of [["dark", "light"], ["light", "dark"]]) {
    const { context, page } = await open("/markdown");
    await page.evaluate(([d, s]) => { localStorage.setItem("docs-theme", d); localStorage.setItem("vim-html:prefs", JSON.stringify({ hinted: true, scheme: s })); }, [docsTheme, scheme]);
    await reload(page);
    const state = await look(page);
    expectViewer(state, docsTheme, `docs-theme=${docsTheme} vs vim-html:prefs scheme=${scheme}`);
    // The owner's screenshot state (dark document, light Vim chrome) is now one dark page.
    if (docsTheme === "dark") await page.screenshot({ path: resolve(output, "conflict-owner-state.png") });
    await click(page, state);
    expectViewer(await look(page), flip(docsTheme), "conflict then click");
    assert.equal(JSON.parse((await look(page)).prefs).scheme, scheme, "the skill's stored scheme is left for authored/baked pages");
    check(`saved docs-theme=${docsTheme} beats vim-html:prefs scheme=${scheme}; document and chrome agree, the global pref is untouched`);
    await context.close();
  }

  // 4. Every generated viewer wrapper.
  for (const path of Object.keys(formats)) {
    const { context, page } = await open(path);
    let state = await look(page);
    expectViewer(state, "light", path);
    await click(page, state);
    expectViewer(await look(page), "dark", path + " click");
    await leaderUb(page);
    expectViewer(await look(page), "light", path + " Space u b");
    check(path + " generated viewer: one control, mouse and Space u b both recolor document and chrome");
    await context.close();
  }

  // 5. Narrow phone: the status line's toggle no longer competes with the toolbar's.
  {
    const { context, page } = await open("/markdown", PHONE);
    let state = await look(page);
    expectViewer(state, "light", "phone");
    assert(state.scrollWidth <= state.width, "no horizontal page scroll at phone width");
    assert(state.controls[0].rect[2] <= state.width, "toggle inside the viewport");
    assert(state.downloadRect[1] <= state.controls[0].rect[0], "toggle does not overlap Download");
    assert(state.controls[0].rect[3] - state.controls[0].rect[1] >= 44, "coarse-pointer target is at least 44px");
    await page.screenshot({ path: resolve(output, "phone-light.png") });
    await page.touchscreen.tap(state.controls[0].x, state.controls[0].y);
    state = await look(page);
    expectViewer(state, "dark", "phone tap");
    await page.waitForTimeout(500); // let the platform tap highlight fade before capturing
    await page.screenshot({ path: resolve(output, "phone-dark.png") });
    await reload(page);
    expectViewer(await look(page), "dark", "phone reload");
    check("phone width: one 44px toolbar toggle, tap recolors document and status line, choice persists", { rect: state.controls[0].rect });
    await context.close();
  }

  // 6. Standalone viewer (no runtime injected): unchanged and complete on its own.
  {
    const { context, page } = await open("/standalone", DESKTOP, { vim: false });
    assert.equal(await page.evaluate(() => "__VH" in window || !!document.getElementById("vh-ui")), false);
    let state = await look(page);
    expectViewer(state, "light", "standalone");
    await click(page, state);
    expectViewer(await look(page), "dark", "standalone click");
    await page.focus("[data-theme-toggle]");
    await page.keyboard.press("Enter");
    expectViewer(await look(page), "light", "standalone Enter");
    await page.keyboard.press("Space");
    expectViewer(await look(page), "dark", "standalone Space");
    await reload(page, false);
    const sampled = await frames(page);
    expectViewer(await look(page), "dark", "standalone reload");
    assert.deepEqual(sampled.bodies, [DARK_BG]);
    check("standalone viewer without Vim: mouse/keyboard toggle, storage and flash-free reload work alone");
    await context.close();
  }

  // 7. Twice-enhanced generated output stays single.
  {
    const { context, page } = await open("/repeat");
    assert.equal(await page.locator('script[data-vh="runtime"]').count(), 1);
    assert.equal(await page.locator('script[data-vh="config"]').count(), 1);
    const state = await look(page);
    expectViewer(state, "light", "repeat");
    await click(page, state);
    expectViewer(await look(page), "dark", "repeat click");
    check("a twice-enhanced generated page keeps one runtime and one working theme adapter");
    await context.close();
  }

  // 8. Negatives: authored and baked pages keep their own theme and the skill's.
  for (const path of ["/authored", "/baked"]) {
    const { context, page } = await open(path);
    const before = await page.evaluate(() => ({
      flagged: window.__VH.cfg.docsViewer, adopted: document.documentElement.hasAttribute("data-docs-viewer-theme"),
      skillToggle: !!document.getElementById("vh-theme") && document.getElementById("vh-theme").getClientRects().length > 0,
      theme: document.documentElement.dataset.theme, body: getComputedStyle(document.body).backgroundColor,
      cfg: { source: window.__VH.cfg.source, key: window.__VH.cfg.storageKey, theme: window.__VH.cfg.theme },
    }));
    assert.equal(before.flagged, undefined, path + " is not flagged as a generated viewer");
    assert.equal(before.adopted, false);
    assert.equal(before.skillToggle, true, path + " keeps the skill's own toggle");
    assert.equal(before.theme, "light");
    if (path === "/baked") {
      assert.deepEqual(before.cfg, { source: "/synthetic/theme.html", key: "theme-baked", theme: "none" });
      assert.equal(await page.locator("[data-docs-vim-quiet]").count(), 1);
      assert((await (await fetch(origin + path)).text()).startsWith(baked), "baked source bytes are an exact prefix");
    }
    // The skill's Space u b keeps its own semantics there: chrome scheme + global pref only.
    await leaderUb(page);
    const after = await page.evaluate(() => ({
      theme: document.documentElement.dataset.theme, vhScheme: document.documentElement.getAttribute("data-vh-scheme"),
      body: getComputedStyle(document.body).backgroundColor, prefs: JSON.parse(localStorage.getItem("vim-html:prefs") || "{}"),
      docsTheme: localStorage.getItem("docs-theme"), authoredTheme: localStorage.getItem("authored-theme"),
    }));
    assert.deepEqual(after, { theme: "light", vhScheme: "dark", body: before.body, prefs: { ...after.prefs, scheme: "dark" }, docsTheme: null, authoredTheme: null });
    // The authored toggle (same data-theme-toggle name) stays the author's and is not mirrored.
    const box = await page.locator("[data-theme-toggle]").boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    const own = await page.evaluate(() => ({ theme: document.documentElement.dataset.theme, vhScheme: document.documentElement.getAttribute("data-vh-scheme"), body: getComputedStyle(document.body).backgroundColor, docsTheme: localStorage.getItem("docs-theme") }));
    assert.deepEqual(own, { theme: "dark", vhScheme: "dark", body: "rgb(20, 30, 40)", docsTheme: null });
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    assert.equal(await page.evaluate(() => document.documentElement.getAttribute("data-vh-scheme")), "dark", path + " runtime scheme does not follow the authored toggle");
    await page.screenshot({ path: resolve(output, path.slice(1) + "-negative.png") });
    check(path + " keeps the skill's toggle and Space u b semantics; its own data-theme-toggle stays the author's; no docs-theme read or written");
    await context.close();
  }

  for (const variant of ["raw", "download"]) {
    assert.equal(await (await fetch(origin + "/markdown/" + variant)).text(), markdown);
    assert.equal(await (await fetch(origin + "/baked/" + variant)).text(), baked);
    check(variant + " returns exact stored bytes for generated and baked sources");
  }
  assert.deepEqual(result.errors, []);
  assert.deepEqual(server.serverErrors, []);
  result.complete = true;
} finally {
  // Only resources created by this process are closed. A failing run is
  // persisted too, so it cannot be mistaken for a passing proof.
  try { if (browser) await browser.close(); }
  finally {
    if (server) await server.close();
    await writeFile(resolve(output, "theme-browser-proof.json"), JSON.stringify(result, null, 2) + "\n");
  }
}
