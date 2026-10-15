/** Headless proof of the hosted dC clear-all key on enhanced, generated and
 * recognized baked pages, typed through Playwright's trusted keyboard events.
 * Each fixture gets its own disposable browser profile and loopback server; no
 * owner browser, storage or document is touched, and nothing is deployed.
 * Run from worker: node src/vendor/vim-html/clear-browser-proof.mjs <output-dir>.
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { bake, enhanceHtml, startProofServer } from "./proof-server.mjs";

const output = resolve(process.argv[2] || "../.scratch/docs-vim-clear/browser");
await mkdir(output, { recursive: true });
// Thirty filler lines keep the far comment out of the viewport, and the second
// heading gives zM a fold to hide it in: dC must not be limited to what is visible.
const fillers = Array.from({ length: 30 }, (_, i) => `Filler line ${i + 1} keeps the far target away.`);
const authored = `<!doctype html><html><head><meta charset="utf-8"><title>Clear fixture</title>
<style>body{margin:0;background:rgb(248,245,239);font:18px Georgia}main{margin:40px auto;width:620px}</style></head><body><main>
<h1>Clear fixture</h1><p>Alpha line comment target.</p><p>Bravo range comment target.</p>
<form><label>Notes <input id="notes"></label></form>
<h2>Later section</h2>${fillers.map(line => `<p>${line}</p>`).join("")}<p>Zulu far comment target.</p></main></body></html>`;
const markdown = ["# Clear fixture", "Alpha line comment target.", "Bravo range comment target.",
  "## Later section", ...fillers, "Zulu far comment target."].join("\n\n");
const baked = bake(authored, "/synthetic/clear.html", "clear-baked");
const sources = {
  "/authored": authored, "/authored-repeat": authored, "/preview": { markdown },
  "/baked": baked, "/baked-repeat": baked, "/other": authored.replace(/Clear fixture/g, "Other fixture"),
};
const DESC = "delete all comments in this document (u undoes)";

let server;
let browser;
const result = { complete: false, checks: [], errors: [], serverErrors: [] };
const check = (name, detail = {}) => { result.checks.push({ name, ...detail }); console.log("PASS " + name); };
try {
  server = await startProofServer({ sources, id: "Clear123", title: "Clear fixture", route: async ({ path, variant, render }) => {
    if (variant !== "page" || !path.endsWith("-repeat")) return;
    // A second pass over already-served output must neither add a runtime or
    // hook nor, therefore, register dC a second time.
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

  const booted = page => page.waitForFunction(() => document.documentElement.hasAttribute("data-vh-booted"));
  const comments = page => page.evaluate(() => window.__VH.comments.all());
  const toast = (page, text) => page.waitForFunction(t => document.querySelector(".vh-toast.vh-show")?.textContent === t, text);
  const storage = page => page.evaluate(() => Object.fromEntries(Object.keys(localStorage).map(k => [k, localStorage.getItem(k)])));
  const stored = page => page.evaluate(() => JSON.parse(localStorage.getItem(window.__VH.store.key) || "{}").comments);
  const painted = page => page.evaluate(() => ({
    count: window.__VH.comments.all().length,
    highlighted: CSS.highlights.get("vh-comment")?.size ?? 0,
    signs: document.querySelectorAll(".vh-ln.vh-ln-c").length,
    status: document.querySelector(".vh-st-count").classList.contains("vh-zero") ? 0 : Number(document.querySelector(".vh-st-n").textContent),
  }));
  const search = async (page, text) => {
    await page.keyboard.press("/"); await page.keyboard.type(text); await page.keyboard.press("Enter");
  };
  // The comment editor owns insert mode: every printable key, dC included, is note text.
  const note = async (page, text, total) => {
    await page.getByRole("textbox", { name: "Comment", exact: true }).waitFor();
    await page.keyboard.type(text); await page.keyboard.press("Enter");
    await page.waitForFunction(n => window.__VH.comments.all().length === n, total);
  };
  const sidebar = async page => {
    await page.keyboard.press("Space"); await page.keyboard.press("e");
    await page.locator("#vh-panel").waitFor({ state: "visible" });
    const rows = await page.evaluate(() => ({ rows: document.querySelectorAll("#vh-panel .vh-pi").length,
      detached: document.querySelectorAll("#vh-panel .vh-pi.vh-detached").length,
      empty: !document.querySelector("#vh-panel .vh-panel-empty").hidden }));
    await page.keyboard.press("q");
    return rows;
  };
  const clearKeys = async page => { await page.keyboard.press("d"); await page.keyboard.press("Shift+KeyC"); };

  for (const { path, dock, field } of [
    { path: "/authored", dock: true, field: true },
    { path: "/preview", dock: true, field: false },
    { path: "/baked", dock: false, field: false },
  ]) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, permissions: ["clipboard-read", "clipboard-write"] });
    context.setDefaultTimeout(10000);
    const page = await context.newPage();
    page.on("pageerror", error => result.errors.push(path + ": " + String(error)));

    // Another document on the same origin and profile must keep its comment.
    await page.goto(origin + "/other"); await booted(page);
    await search(page, "Alpha"); await page.keyboard.type("gcc"); await note(page, "Other document note", 1);

    await page.goto(origin + path); await booted(page);
    const key = await page.evaluate(() => window.__VH.store.key);
    if (path === "/baked") {
      assert.equal(key, "vim-html:v1:clear-baked");
      assert.equal(await page.locator("[data-docs-vim-quiet]").count(), 1);
      assert.equal(await page.locator('script[data-vh="runtime"]').count(), 1);
    } else assert.equal(key, "vim-html:v1:docs:" + origin + path);
    assert.equal(await page.locator(".docs-vim-controls").count(), dock ? 1 : 0);
    assert.equal(await page.evaluate(() => window.__VH.gutter.numbers()), false);

    await search(page, "Alpha"); await page.keyboard.type("gcc"); await note(page, "Alpha note typed with dC", 1);
    await search(page, "Bravo"); await page.keyboard.type("vee"); await page.keyboard.press("Enter"); await note(page, "Bravo range note", 2);
    await search(page, "Filler line 1 keeps"); await page.keyboard.type("Vj"); await page.keyboard.press("Enter"); await note(page, "Two-line range note", 3);
    await search(page, "Zulu"); await page.keyboard.type("gcc"); await note(page, "Far note", 4);
    const created = await comments(page);
    assert(created.some(c => c.note === "Alpha note typed with dC" && c.anchor.whole));
    assert(created.some(c => c.note === "Bravo range note" && !c.anchor.whole && c.anchor.quote.length < "Bravo range comment target.".length));
    assert(created.some(c => c.note === "Two-line range note" && c.anchor.endLine === c.anchor.startLine + 1));
    // A comment whose text has since left the page, as after an author's edit.
    await page.evaluate(storageKey => {
      const bucket = JSON.parse(localStorage.getItem(storageKey));
      bucket.comments.push({ id: "stale-proof", note: "Note on removed text", created: 1, updated: 1,
        anchor: { startLine: 3, endLine: 3, quote: "This sentence was removed from the page.", prefix: "", suffix: "", whole: true } });
      localStorage.setItem(storageKey, JSON.stringify(bucket));
    }, key);
    await page.reload(); await booted(page);
    const before = await comments(page);
    assert.equal(before.length, 5);
    assert.deepEqual(before.filter(c => c.detached).map(c => c.id), ["stale-proof"]);
    assert.deepEqual(await painted(page), { count: 5, highlighted: 4, signs: 5, status: 5 });
    assert.deepEqual(await sidebar(page), { rows: 5, detached: 1, empty: false });
    check(path + " has line, character-range, line-range, far and detached comments", { comments: before.length });

    // dC is only a normal-mode key: fields, the editor, the command line and Vim off keep it.
    if (field) {
      await page.locator("#notes").focus(); await page.keyboard.type("dC dc");
      assert.equal(await page.locator("#notes").inputValue(), "dC dc");
      await page.evaluate(() => document.activeElement.blur()); await page.keyboard.press("Escape");
    }
    await page.keyboard.press(":"); await page.keyboard.type("dC");
    assert.equal(await page.evaluate(() => document.activeElement.value), "dC");
    await page.keyboard.press("Escape");
    if (dock) {
      await page.getByRole("button", { name: "Vim off", exact: true }).click();
      await clearKeys(page);
      await page.getByRole("button", { name: "Vim on", exact: true }).click();
      // A focused dock button keeps native Space/Enter activation; leave it.
      await page.evaluate(() => document.activeElement.blur());
    }
    assert.equal((await comments(page)).length, 5);
    check(path + " typing dC in " + [field && "a page field", "the comment editor", "the command line", dock && "Vim off"].filter(Boolean).join(", ") + " deletes nothing");

    await page.keyboard.press("Space"); await page.keyboard.press("?");
    await page.locator("#vh-help").waitFor({ state: "visible" });
    const helpText = await page.locator("#vh-help").innerText();
    assert.equal(helpText.split(DESC).length - 1, 1);
    await page.keyboard.press("Escape");
    assert.deepEqual(await page.evaluate(() => window.__VH.keys.list().filter(k => k.seq === "dC")),
      [{ modes: ["normal"], seq: "dC", desc: DESC, group: "comments" }]);
    check(path + " lists dC once in help under comments");

    // A reader's manual numbers choice must survive the clear and its undo.
    await page.keyboard.press("Space"); await page.keyboard.type("ul");
    assert.equal(await page.evaluate(() => window.__VH.gutter.numbers()), true);
    const storageBefore = await storage(page);
    await page.keyboard.type("ggzM");
    // Paragraphs only: the sidebar's hidden rows repeat the quoted text.
    assert.equal(await page.locator("p", { hasText: "Zulu far comment target." }).isVisible(), false);
    // Let the numbers toast fade so the which-key screenshot shows only the d popup.
    await page.waitForFunction(() => !document.querySelector(".vh-toast.vh-show"));
    await page.keyboard.press("d");
    await page.locator("#vh-whichkey:not([hidden])").waitFor();
    const whichKey = await page.locator('#vh-whichkey [data-vh-key="C"]').innerText();
    assert(whichKey.includes(DESC) && (await page.locator('#vh-whichkey [data-vh-key="c"]').innerText()).includes("cursor line"));
    // The docs dock shares this corner; it must not cover the dC row or the toast.
    // The toast ignores pointer events, so it is compared by stacking order instead.
    assert(await page.evaluate(() => {
      const row = document.querySelector('#vh-whichkey [data-vh-key="C"]').getBoundingClientRect();
      return [row.left + 4, (row.left + row.right) / 2, row.right - 4].every(x =>
        document.querySelector("#vh-whichkey").contains(document.elementFromPoint(x, (row.top + row.bottom) / 2)));
    }));
    await page.screenshot({ path: resolve(output, path.slice(1) + "-which-key.png") });
    await page.keyboard.press("Shift+KeyC");
    await toast(page, "Cleared 5 comments — u to undo");
    if (dock) assert(await page.evaluate(() => Number(getComputedStyle(document.querySelector(".docs-vim-controls")).zIndex) <
      Number(getComputedStyle(document.querySelector(".vh-toast")).zIndex)));
    assert.deepEqual(await painted(page), { count: 0, highlighted: 0, signs: 0, status: 0 });
    assert.deepEqual(await stored(page), []);
    const storageAfter = await storage(page);
    assert.deepEqual(Object.keys(storageAfter).filter(k => storageAfter[k] !== storageBefore[k]), [key]);
    assert.equal(await page.evaluate(() => window.__VH.gutter.numbers()), true);
    await page.screenshot({ path: resolve(output, path.slice(1) + "-cleared.png") });
    await page.keyboard.type("zR");
    assert.deepEqual(await sidebar(page), { rows: 0, detached: 0, empty: true });
    check(path + " d Shift-C clears all five, folded/off-screen/detached included; count, highlights, signs, sidebar and storage refresh", { whichKey });

    await page.keyboard.press("u");
    await toast(page, "Undo: clear 5 comments");
    assert.deepEqual(await comments(page), before);
    assert.deepEqual(await painted(page), { count: 5, highlighted: 4, signs: 5, status: 5 });
    assert.equal((await stored(page)).length, 5);
    await page.keyboard.press("Control+r");
    await toast(page, "Redo: clear 5 comments");
    assert.deepEqual(await stored(page), []);
    check(path + " u restores all five as one change and Ctrl-r clears them again");

    await clearKeys(page);
    await toast(page, "No comments to clear");
    await page.keyboard.press("u");
    await toast(page, "Undo: clear 5 comments");
    assert.deepEqual(await comments(page), before);
    check(path + " dC with nothing to clear adds no history entry: the next u restores the earlier clear");

    await search(page, "Alpha"); await page.keyboard.type("dc");
    await toast(page, "Deleted 1 comment — u to undo");
    assert.equal((await comments(page)).length, 4);
    await page.keyboard.press("u");
    assert.deepEqual(await comments(page), before);
    await page.keyboard.type("gy");
    await page.waitForFunction(() => window.__VH.clip.last?.includes("Far note"));
    const exported = await page.evaluate(() => window.__VH.clip.last);
    assert.equal(exported.split("\n> ").length - 1, 5);
    assert(exported.includes("(detached; was #L3)"));
    check(path + " dc still deletes only the cursor line and gy exports every restored comment");

    await clearKeys(page);
    await toast(page, "Cleared 5 comments \u2014 u to undo");
    await page.reload(); await booted(page);
    assert.deepEqual(await comments(page), []);
    assert.deepEqual(await stored(page), []);
    assert.equal(await page.evaluate(() => window.__VH.gutter.numbers()), false);
    await page.goto(origin + "/other"); await booted(page);
    assert.deepEqual((await comments(page)).map(c => c.note), ["Other document note"]);
    check(path + " the clear persists across reload and leaves the other document, preferences and quiet default alone");
    await context.close();
  }

  for (const path of ["/authored-repeat", "/baked-repeat"]) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    page.on("pageerror", error => result.errors.push(path + ": " + String(error)));
    await page.goto(origin + path); await booted(page);
    assert.equal(await page.locator('script[data-vh="runtime"]').count(), 1);
    assert.equal(await page.locator("[data-docs-vim-quiet]").count(), path === "/baked-repeat" ? 1 : 0);
    assert.equal(await page.evaluate(() => window.__VH.keys.list().filter(k => k.seq === "dC").length), 1);
    await search(page, "Alpha"); await page.keyboard.type("gcc"); await note(page, "Repeat note", 1);
    await clearKeys(page);
    await toast(page, "Cleared 1 comment — u to undo");
    await page.keyboard.press("u");
    assert.equal((await comments(page)).length, 1);
    check(path + " twice-enhanced output is unchanged and has one dC binding");
    await context.close();
  }

  for (const variant of ["raw", "download"]) {
    assert.equal(await (await fetch(origin + "/baked/" + variant)).text(), baked);
    check("baked " + variant + " returns exact stored bytes without the hook");
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
    await writeFile(resolve(output, "clear-browser-proof.json"), JSON.stringify(result, null, 2) + "\n");
  }
}
