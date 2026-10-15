/** Headless proof of the Space s k keymap picker on enhanced, generated and
 * recognized baked pages, typed through Playwright's trusted keyboard events
 * over the production Preview -> enhanceHtml -> runtime path (proof-server.mjs,
 * reused read-only). Each fixture gets its own disposable browser context and
 * the run owns its loopback server; no owner browser, storage or document is
 * touched, and nothing is deployed.
 * Run from worker: node src/vendor/vim-html/keymap-search-browser-proof.mjs <output-dir>.
 */
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { bake, enhanceHtml, startProofServer } from "./proof-server.mjs";

const output = resolve(process.argv[2] || "../.scratch/docs-keymap-search/browser");
await mkdir(output, { recursive: true });

// The served layers must carry the module as it is on disk (generate.py ran).
const moduleText = await readFile(new URL("./keymap-search.js", import.meta.url), "utf8");
const generated = await readFile(new URL("./generated.ts", import.meta.url), "utf8");
for (const name of ["runtimeScript", "bakedHookScript"]) {
  const value = JSON.parse(generated.match(new RegExp(`export const ${name} = (".*");`))[1]);
  assert.equal(value.split(moduleText).length - 1, 1, `${name} carries keymap-search.js once`);
}

// Authored CSS deliberately styles bare elements the picker also uses; a
// focusable region, page fields and an authored modal cover keyboard ownership.
const authored = `<!doctype html><html><head><meta charset="utf-8"><title>Keymap fixture</title>
<style>body{margin:0;background:rgb(248,245,239);color:rgb(24,49,68);font:18px Georgia}main{margin:40px auto;max-width:620px;padding:0 16px}
input,textarea{border:6px solid rgb(200,0,0);padding:12px;font:inherit}div{margin:3px}span{letter-spacing:3px}mark{background:yellow}</style></head><body><main>
<h1>Keymap fixture</h1><p>Alpha line for a comment.</p><p>Bravo line.</p>
<div id="focus-target" tabindex="0">Focusable region</div>
<form><label>Notes <input id="notes"></label><label>Long notes <textarea id="long-notes"></textarea></label></form>
<p contenteditable="true" id="editable">Editable</p>
<dialog id="modal"><p>Authored modal</p><div id="modal-widget" tabindex="0">Widget</div></dialog>
${Array.from({ length: 24 }, (_, i) => `<p>Filler paragraph ${i + 1}.</p>`).join("")}
</main><script>window.authored={keys:[]};window.addEventListener('keydown',function(e){window.authored.keys.push(e.key)});</script></body></html>`;
const markdown = "# Keymap fixture\n\nAlpha line for a comment.\n\nBravo line.\n\n" +
  Array.from({ length: 24 }, (_, i) => `Filler paragraph ${i + 1}.`).join("\n\n");
const baked = bake(authored, "/synthetic/keymaps.html", "keymaps-baked");
const sources = { "/authored": authored, "/authored-repeat": authored, "/preview": { markdown }, "/baked": baked, "/baked-repeat": baked };
const HOSTILE = '<img src=x onerror="window.pwned=1"> hostile description';
const LONG = "a deliberately long description that keeps going " + "Supercalifragilisticexpialidocious".repeat(4) + " so it must wrap";

let server;
let browser;
const result = { complete: false, checks: [], errors: [], serverErrors: [], screenshots: [] };
const check = (name, detail = {}) => { result.checks.push({ name, ...detail }); console.log("PASS " + name); };
try {
  server = await startProofServer({ sources, id: "Keys1234", title: "Keymap fixture", route: async ({ path, variant, render }) => {
    if (variant !== "page" || !path.endsWith("-repeat")) return;
    // A second pass over served output adds no runtime, hook or binding.
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
  const openKeys = async page => {
    await page.keyboard.press("Space"); await page.keyboard.press("s"); await page.keyboard.press("k");
  };
  const state = page => page.evaluate(() => {
    const rows = [...document.querySelectorAll(".docs-ks-row")];
    return {
      open: document.querySelectorAll(".docs-ks").length,
      mode: window.__VH.mode.get(),
      focused: document.activeElement && document.activeElement.className,
      active: document.activeElement && (document.activeElement.id || document.activeElement.tagName),
      query: document.querySelector(".docs-ks-input")?.value ?? null,
      count: document.querySelector(".docs-ks-count")?.textContent ?? null,
      empty: document.querySelector(".docs-ks-empty")?.textContent ?? null,
      selected: rows.findIndex(r => r.getAttribute("aria-selected") === "true"),
      rows: rows.map(r => ({
        keys: [...r.querySelectorAll(".docs-ks-kbd")].map(k => k.textContent).join(" "),
        desc: r.querySelector(".docs-ks-desc").textContent,
        meta: [...r.querySelectorAll(".docs-ks-meta > span")].map(s => s.textContent).join(" "),
      })),
    };
  });
  // Ctrl-u is the picker's clear-to-start; the caret sits at the end.
  const query = async (page, text) => {
    await page.keyboard.press("Control+KeyU");
    await page.keyboard.type(text);
    return state(page);
  };
  const listed = page => page.evaluate(() => window.__VH.keys.list().length);

  for (const { path, kind } of [
    { path: "/authored", kind: "enhanced" },
    { path: "/preview", kind: "generated" },
    { path: "/baked", kind: "baked" },
  ]) {
    const context = await browser.newContext({ viewport: { width: 1180, height: 820 } });
    context.setDefaultTimeout(10000);
    const page = await context.newPage();
    page.on("pageerror", error => result.errors.push(path + ": " + String(error)));
    await page.goto(origin + path); await booted(page);

    // Identity: one runtime (baked: its own, plus one hook), quiet numbers, dC present.
    assert.equal(await page.locator('script[data-vh="runtime"]').count(), 1);
    assert.equal(await page.locator("[data-docs-vim-quiet]").count(), kind === "baked" ? 1 : 0);
    assert.equal(await page.evaluate(() => window.__VH.gutter.numbers()), false);
    const storeKey = await page.evaluate(() => window.__VH.store.key);
    assert.equal(storeKey, kind === "baked" ? "vim-html:v1:keymaps-baked" : "vim-html:v1:docs:" + origin + path);
    check(`${kind}: one runtime, quiet numbers, authored identity`, { storeKey });

    // A comment exists before searching, so query text cannot clear it unnoticed.
    await page.keyboard.press("/"); await page.keyboard.type("Alpha"); await page.keyboard.press("Enter");
    await page.keyboard.type("gcc");
    await page.getByRole("textbox", { name: "Comment", exact: true }).waitFor();
    await page.keyboard.type("Kept note"); await page.keyboard.press("Enter");
    await page.waitForFunction(() => window.__VH.comments.all().length === 1);

    // A registration made after boot is listed too: the picker reads the live list.
    await page.evaluate(([hostile, long]) => {
      window.ranHostile = 0;
      window.__VH.keys.map("normal", "gX", () => { window.ranHostile++; }, { desc: hostile, group: "<b>proof</b>" });
      window.__VH.keys.map("normal", "gL", () => {}, { desc: long, group: "proof" });
    }, [HOSTILE, LONG]);

    await openKeys(page);
    await page.locator(".docs-ks").waitFor();
    let s = await state(page);
    const total = await listed(page);
    assert.equal(s.open, 1);
    assert.equal(s.mode, "command");
    assert.equal(s.focused, "docs-ks-input");
    assert.equal(s.query, "");
    assert.equal(s.count, `${total}/${total}`);
    assert.equal(s.rows.length, total);
    assert(s.rows.some(r => r.keys === "dC" && r.desc === "delete all comments in this document (u undoes)" && r.meta === "n comments"));
    assert(s.rows.some(r => r.keys === "Space sk" && r.desc === "search keymaps" && r.meta === "n search"));
    assert(s.rows.some(r => r.keys === "gX"));
    check(`${kind}: Space s k opens one focused picker over the live list`, { total });
    await page.screenshot({ path: `${output}/${kind}-open.png`, animations: "disabled" }); result.screenshots.push(`${kind}-open.png`);

    // Space s k again is query text; the picker stays single.
    await page.keyboard.type(" sk");
    s = await state(page);
    assert.deepEqual([s.open, s.query, s.rows[0].keys], [1, " sk", "Space sk"]);
    check(`${kind}: typing Space s k inside the picker is query text`);

    // Searches: descriptions, partial keys, multiword, case, empty.
    s = await query(page, "delete");
    assert(s.rows.length >= 4 && s.rows.every(r => /delete/i.test(r.desc + r.keys)));
    assert(s.rows.some(r => r.keys === "dC"));
    assert.equal(s.count, `${s.rows.length}/${total}`);
    const deleteRows = s.rows.length;
    s = await query(page, "comment");
    assert(s.rows.length > 3 && s.rows.slice(0, 3).every(r => /comment/i.test(r.desc + r.meta)));
    s = await query(page, "fold");
    assert(s.rows.length >= 3 && s.rows.every(r => /fold/i.test(r.desc + r.meta + r.keys)));
    const foldRows = s.rows.map(r => r.keys);
    s = await query(page, "FOLD");
    assert.deepEqual(s.rows.map(r => r.keys), foldRows);
    s = await query(page, "<leader>s");
    assert(s.rows.length >= 3 && s.rows.every(r => r.keys.startsWith("Space s")));
    s = await query(page, "Space s");
    assert(s.rows.slice(0, 3).every(r => r.keys.startsWith("Space s")));
    s = await query(page, "dC");
    assert.deepEqual(s.rows.slice(0, 2).map(r => r.keys), ["dC", "dc"]);
    s = await query(page, "Delete Comments");
    assert(s.rows.length >= 2 && s.rows.length < deleteRows && s.rows.every(r => /delete/i.test(r.desc) && /comment/i.test(r.desc + r.meta)));
    s = await query(page, "zzqx nothing");
    assert.deepEqual([s.rows.length, s.count, s.empty?.startsWith("No keymaps match “zzqx nothing”")], [0, `0/${total}`, true]);
    check(`${kind}: description, partial key, multiword, case and empty searches`, { deleteRows, foldRows });

    // Hostile description and query stay text; Enter never runs the key.
    s = await query(page, "hostile");
    assert.deepEqual(s.rows.map(r => [r.keys, r.desc, r.meta]), [["gX", HOSTILE, "n <b>proof</b>"]]);
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.querySelector(".vh-toast.vh-show")?.textContent === "Listing only. Esc, then press gX");
    s = await query(page, '<img src=x onerror="window.pwned=2">');
    const inert = await page.evaluate(() => ({ imgs: document.querySelectorAll(".docs-ks img, .docs-ks b").length, pwned: window.pwned ?? null, ran: window.ranHostile }));
    assert.deepEqual(inert, { imgs: 0, pwned: null, ran: 0 });
    assert.equal((await state(page)).open, 1);
    check(`${kind}: hostile description/query are inert and Enter runs nothing`);

    // Query typing reaches neither vim commands nor authored key handlers.
    const before = await page.evaluate(() => ({ cursor: window.__VH.cursor.get(), comments: window.__VH.comments.all().length,
      keys: window.authored ? window.authored.keys.length : null, scroll: scrollY }));
    await page.keyboard.press("Control+KeyU");
    await page.keyboard.type("jjkk dd gg G q :clear dC u zM");
    const after = await page.evaluate(() => ({ cursor: window.__VH.cursor.get(), comments: window.__VH.comments.all().length,
      keys: window.authored ? window.authored.keys.length : null, scroll: scrollY,
      cmdline: !!document.querySelector(".vh-cmdline:not([hidden])") }));
    assert.deepEqual(after, { ...before, cmdline: false });
    assert.equal((await state(page)).query, "jjkk dd gg G q :clear dC u zM");
    check(`${kind}: query text leaves cursor, comments, page handlers and scroll alone`);

    // Keyboard navigation and list-only scrolling.
    await page.keyboard.press("Control+KeyU");
    const nav = [];
    for (const [key, expected] of [["ArrowDown", 1], ["ArrowDown", 2], ["Control+KeyN", 3], ["Control+KeyJ", 4], ["Tab", 5],
      ["ArrowUp", 4], ["Control+KeyP", 3], ["Control+KeyK", 2], ["Shift+Tab", 1]]) {
      await page.keyboard.press(key);
      nav.push([key, (await state(page)).selected]);
      assert.equal(nav.at(-1)[1], expected, key);
    }
    for (let n = 0; n < 6; n++) await page.keyboard.press("PageDown");
    const scrolled = await page.evaluate(() => {
      const list = document.querySelector(".docs-ks-list");
      const row = document.querySelector('.docs-ks-row[aria-selected="true"]').getBoundingClientRect();
      const box = list.getBoundingClientRect();
      return { listScroll: list.scrollTop, visible: row.top >= box.top - 1 && row.bottom <= box.bottom + 1, pageScroll: scrollY,
               focused: document.activeElement.className };
    });
    assert(scrolled.listScroll > 0 && scrolled.visible && scrolled.focused === "docs-ks-input");
    assert.equal(scrolled.pageScroll, before.scroll);
    check(`${kind}: arrows, Ctrl-n/p/j/k, Tab and PageDown move a visible selection`, { nav, scrolled });

    // Esc closes and restores focus; reopening is clean.
    await page.keyboard.press("Escape");
    s = await state(page);
    assert.deepEqual([s.open, s.mode, s.active], [0, "normal", "BODY"]);
    await openKeys(page);
    s = await state(page);
    assert.deepEqual([s.open, s.query, s.count, s.selected], [1, "", `${total}/${total}`, 0]);
    // The backdrop, Ctrl-c and the close button dismiss too.
    await page.mouse.click(10, 810);
    assert.equal((await state(page)).open, 0);
    await openKeys(page); await page.keyboard.press("Control+KeyC");
    assert.equal((await state(page)).open, 0);
    await openKeys(page); await page.locator(".docs-ks-close").click();
    s = await state(page);
    assert.deepEqual([s.open, s.mode], [0, "normal"]);
    const listeners = await page.evaluate(() => document.querySelectorAll("#vh-ui > style[data-docs-keymap-search]").length);
    assert.equal(listeners, 1);
    check(`${kind}: Esc/backdrop/Ctrl-c/close button dismiss; reopen is fresh`);

    // Focus returns to what the reader had focused (a focusable region, which
    // the hosted guard still leaves to vim keys).
    if (kind !== "generated") {
      await page.focus("#focus-target");
      await openKeys(page);
      assert.equal((await state(page)).open, 1);
      await page.keyboard.press("Escape");
      assert.equal((await state(page)).active, "focus-target");
      await page.evaluate(() => document.activeElement.blur());
      check(`${kind}: Esc returns focus to the previously focused element`);
    }

    // Native fields and authored modals own their keys.
    if (kind !== "generated") {
      for (const field of ["#notes", "#long-notes", "#editable"]) {
        await page.click(field);
        await page.keyboard.type(" sk");
        const value = await page.evaluate(sel => { const el = document.querySelector(sel); return el.value ?? el.textContent; }, field);
        assert(value.endsWith(" sk"), field);
        assert.equal((await state(page)).open, 0);
        await page.keyboard.press("Escape");
      }
      check(`${kind}: page input, textarea and contenteditable type Space s k as text`);
    }
    if (kind === "enhanced") {
      await page.evaluate(() => { document.querySelector("#modal").showModal(); document.querySelector("#modal-widget").focus(); });
      await openKeys(page);
      assert.equal((await state(page)).open, 0);
      await page.evaluate(() => document.querySelector("#modal").close());
      check("enhanced: an authored modal keeps Space s k");
    }

    // Help and which-key list the key.
    await page.keyboard.press("Space"); await page.keyboard.press("Shift+Slash");
    await page.locator("#vh-help").waitFor();
    const helpRow = await page.evaluate(() => [...document.querySelectorAll("#vh-help .vh-help-row")]
      .map(r => r.textContent).find(t => t.includes("search keymaps")));
    assert.equal(helpRow, "Spacesksearch keymaps");
    await page.keyboard.press("q");
    await page.keyboard.press("Space"); await page.keyboard.press("s");
    await page.locator("#vh-whichkey:not([hidden])").waitFor();
    const wk = await page.evaluate(() => document.querySelector("#vh-whichkey").textContent);
    assert(wk.includes("search keymaps"), wk);
    await page.keyboard.press("Escape");
    check(`${kind}: Space ? and which-key list Space s k`, { helpRow });

    // dC still clears (and u restores) after the picker came and went.
    await page.keyboard.press("d"); await page.keyboard.press("Shift+KeyC");
    await page.waitForFunction(() => window.__VH.comments.all().length === 0);
    await page.keyboard.press("u");
    await page.waitForFunction(() => window.__VH.comments.all().length === 1);
    check(`${kind}: dC and u still work after the picker`);

    // Vim off (enhanced/generated dock): the off control closes an open picker
    // through the host's real path, and Space s k then opens nothing.
    if (kind !== "baked") {
      await openKeys(page);
      assert.equal((await state(page)).open, 1);
      await page.evaluate(() => [...document.querySelectorAll(".docs-vim-controls button")].find(b => b.textContent === "Vim off").click());
      assert.equal((await state(page)).open, 0);
      await openKeys(page);
      const off = await page.evaluate(() => ({ open: document.querySelectorAll(".docs-ks").length, off: document.documentElement.hasAttribute("data-docs-vim-off") }));
      assert.deepEqual(off, { open: 0, off: true });
      await page.evaluate(() => [...document.querySelectorAll(".docs-vim-controls button")].find(b => b.textContent === "Vim on").click());
      await openKeys(page);
      assert.equal((await state(page)).open, 1);
      await page.keyboard.press("Escape");
      check(`${kind}: Vim off closes the picker and disables Space s k; on restores it`);
    }

    // Authored element rules do not leak into the picker, nor the picker's out.
    if (kind !== "generated") {
      await openKeys(page);
      await query(page, "delete");
      const styles = await page.evaluate(() => {
        const css = (sel, prop) => getComputedStyle(document.querySelector(sel))[prop];
        return { input: css(".docs-ks-input", "borderTopWidth"), hit: css(".docs-ks-hit", "backgroundColor"),
                 kbd: css(".docs-ks-kbd", "letterSpacing"), box: css(".docs-ks-box", "marginTop"),
                 authoredInput: css("#notes", "borderTopWidth") };
      });
      assert.deepEqual(styles, { input: "0px", hit: "rgba(0, 0, 0, 0)", kbd: "normal", box: "0px", authoredInput: "6px" });
      await page.keyboard.press("Escape");
      check(`${kind}: scoped styles hold against authored element rules`, styles);
    }

    // Phones and both schemes: no horizontal overflow; long text wraps.
    for (const [width, height] of [[320, 640], [375, 667]]) {
      for (const scheme of ["light", "dark"]) {
        await page.setViewportSize({ width, height });
        await page.evaluate(sc => window.__VH.scheme.set(sc), scheme);
        await openKeys(page);
        await query(page, width === 320 ? "long" : "comment");
        const fit = await page.evaluate(() => {
          const box = document.querySelector(".docs-ks-box").getBoundingClientRect();
          const rows = [...document.querySelectorAll(".docs-ks-row")];
          return {
            pageOverflow: document.documentElement.scrollWidth > innerWidth,
            boxInside: box.left >= 0 && box.right <= innerWidth && box.bottom <= innerHeight,
            rowsOverflow: rows.filter(r => r.scrollWidth > r.clientWidth + 1).length,
            background: getComputedStyle(document.querySelector(".docs-ks-box")).backgroundColor,
          };
        });
        assert.deepEqual([fit.pageOverflow, fit.boxInside, fit.rowsOverflow], [false, true, 0], `${width} ${scheme}`);
        const shot = `${kind}-${width}-${scheme}.png`;
        await page.screenshot({ path: `${output}/${shot}`, animations: "disabled" }); result.screenshots.push(shot);
        await page.keyboard.press("Escape");
      }
    }
    await page.evaluate(() => window.__VH.scheme.set("light"));
    check(`${kind}: 320/375 light/dark fit without overflow, long descriptions wrap`);
    await context.close();
  }

  // Repeated enhancement: one runtime/hook, one binding, one picker.
  for (const path of ["/authored-repeat", "/baked-repeat"]) {
    const context = await browser.newContext({ viewport: { width: 1180, height: 820 } });
    const page = await context.newPage();
    page.on("pageerror", error => result.errors.push(path + ": " + String(error)));
    await page.goto(origin + path); await booted(page);
    const once = await page.evaluate(() => ({
      runtimes: document.querySelectorAll('script[data-vh="runtime"]').length,
      hooks: document.querySelectorAll("[data-docs-vim-quiet]").length,
      bindings: window.__VH.keys.list().filter(k => k.seq === "<leader>sk").length,
    }));
    assert.deepEqual(once, { runtimes: 1, hooks: path.startsWith("/baked") ? 1 : 0, bindings: 1 });
    await openKeys(page);
    assert.equal((await state(page)).open, 1);
    check(`${path}: twice-enhanced page has one runtime, one binding, one picker`, once);
    await context.close();
  }

  // Raw and download stay byte-exact; the baked page keeps its exact prefix.
  for (const [path, source] of [["/authored", authored], ["/baked", baked]]) {
    for (const variant of ["raw", "download"]) {
      assert.equal(await (await fetch(`${origin}${path}/${variant}`)).text(), source, `${path}/${variant}`);
    }
  }
  const servedBaked = await (await fetch(origin + "/baked")).text();
  assert(servedBaked.startsWith(baked));
  assert.equal(servedBaked.split("data-docs-vim-quiet").length - 1, 1);
  check("raw/download bytes exact; baked page is its original bytes plus one hook");

  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.serverErrors, []);
  result.complete = true;
} catch (error) {
  result.failure = String(error && error.stack || error);
  console.error(error);
  process.exitCode = 1;
} finally {
  await writeFile(`${output}/keymap-search-browser-proof.json`, JSON.stringify(result, null, 2));
  if (browser) await browser.close();
  if (server) await server.close();
}
