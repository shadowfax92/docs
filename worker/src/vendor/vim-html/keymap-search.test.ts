import { describe, expect, it } from "vitest";
import { bakedHookScript, runtimeScript } from "./generated";

// The module exactly as served: generate.py appends it after the baked hook and
// inside the injected runtime's guard. Tests evaluate this shipped text, so a
// stale generated.ts fails here rather than in a browser.
const MARK = "/* Keymap search:";
const moduleSource = bakedHookScript.slice(bakedHookScript.indexOf(MARK));

/* A small stand-in for the slice of DOM the module reaches through VH.ui.h,
 * VH.ui.layer and document. Real layout, focus and key dispatch are proved in
 * keymap-search-browser-proof.mjs; this keeps the ranking and lifecycle fast to check. */
type Listener = (event: FakeEvent) => void;
interface FakeEvent {
  type: string; target: FakeEl; key?: string; ctrlKey?: boolean; shiftKey?: boolean; altKey?: boolean;
  metaKey?: boolean; isComposing?: boolean; keyCode?: number; defaultPrevented: boolean; stopped: boolean;
  preventDefault(): void; stopPropagation(): void;
}

class FakeEl {
  attrs = new Map<string, string>();
  children: FakeEl[] = [];
  parentNode: FakeEl | null = null;
  listeners = new Map<string, Listener[]>();
  data = "";
  value = "";
  selectionStart: number | null = null;
  selectionEnd: number | null = null;
  scrollTop = 0;
  clientHeight = 140;
  offsetHeight = 28;
  constructor(public tag: string, private doc: FakeDocument) { doc.created.push(this); }
  get id() { return this.attrs.get("id") ?? ""; }
  get offsetTop() { return this.parentNode ? this.parentNode.children.indexOf(this) * this.offsetHeight : 0; }
  get textContent(): string { return this.tag === "#text" ? this.data : this.children.map(c => c.textContent).join(""); }
  set textContent(text: string) {
    this.children.forEach(c => (c.parentNode = null));
    this.children = [];
    if (text) this.appendChild(this.doc.text(text));
  }
  setAttribute(name: string, value: string) { this.attrs.set(name, String(value)); }
  getAttribute(name: string) { return this.attrs.get(name) ?? null; }
  removeAttribute(name: string) { this.attrs.delete(name); }
  addEventListener(type: string, fn: Listener) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]); }
  appendChild(child: FakeEl) { child.parentNode = this; this.children.push(child); return child; }
  remove() {
    if (this.parentNode) this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1);
    this.parentNode = null;
  }
  focus() { this.doc.activeElement = this; this.doc.focusCalls.push(this); }
  setSelectionRange(start: number, end: number) { this.selectionStart = start; this.selectionEnd = end; }
  get nodeType() { return this.tag === "#text" ? 3 : 1; }
  get parentElement() { return this.parentNode; }
  // Enough of Element.matches for the module's selectors: tag, [attr], [attr="v"], tag[attr].
  matches(selector: string) {
    return selector.split(",").some(part => {
      const m = /^([a-z]*)(?:\[([\w-]+)(?:="([^"]*)")?\])?$/.exec(part.trim());
      return !!m && (!m[1] || m[1] === this.tag) && (!m[2] || this.attrs.has(m[2])) &&
        (m[3] === undefined || this.attrs.get(m[2]) === m[3]);
    });
  }
  closest(selector: string): FakeEl | null {
    for (let el: FakeEl | null = this; el; el = el.parentNode) if (el.matches(selector)) return el;
    return null;
  }
  find(cls: string): FakeEl[] {
    const own: FakeEl[] = (this.attrs.get("class") ?? "").split(" ").includes(cls) ? [this] : [];
    return own.concat(...this.children.map(c => c.find(cls)));
  }
  // Bubble like the DOM: target first, then each ancestor's listeners.
  fire(type: string, init: Partial<FakeEvent> = {}): FakeEvent {
    const event: FakeEvent = {
      type, target: this, defaultPrevented: false, stopped: false, ...init,
      preventDefault() { event.defaultPrevented = true; }, stopPropagation() { event.stopped = true; },
    };
    for (let el: FakeEl | null = this; el && !event.stopped; el = el.parentNode) {
      (el.listeners.get(type) ?? []).forEach(fn => fn(event));
    }
    return event;
  }
}

class FakeDocument {
  readyState = "loading";
  created: FakeEl[] = [];
  focusCalls: FakeEl[] = [];
  body = new FakeEl("body", this);
  activeElement: FakeEl = this.body;
  modals: FakeEl[] = [];
  querySelectorAll(selector: string) { return this.modals.filter(el => el.matches(selector)); }
  el(tag: string) { return new FakeEl(tag, this); }
  text(data: string) { const node = new FakeEl("#text", this); node.data = data; return node; }
}

type Entry = { modes: string[]; seq: string; desc: string; group: string };
const ENTRIES: Entry[] = [
  { modes: ["normal"], seq: "j", desc: "down one line", group: "motion" },
  { modes: ["normal"], seq: "gg", desc: "go to the first line", group: "motion" },
  { modes: ["normal"], seq: "<C-d>", desc: "half page down", group: "scroll" },
  { modes: ["normal"], seq: "za", desc: "toggle the fold here", group: "folds" },
  { modes: ["normal"], seq: "dc", desc: "delete the comment(s) on the cursor line", group: "comments" },
  { modes: ["normal", "visual", "vline"], seq: "gc", desc: "comment on the selection", group: "comments" },
  { modes: ["panel"], seq: "D", desc: "delete all comments", group: "sidebar" },
  { modes: ["normal"], seq: "<leader>sb", desc: "fuzzy-find a line", group: "search" },
  { modes: ["normal"], seq: "<leader>?", desc: "keymap help", group: "help" },
  { modes: ["command"], seq: "<C-u>", desc: "delete to the start of the input", group: "command line" },
  { modes: ["normal"], seq: "m{a-z}", desc: "set a mark on the cursor line", group: "marks" },
  { modes: ["normal"], seq: "gx", desc: '<img src=x onerror="window.pwned=1"><b>bold</b>', group: "<i>group</i>" },
];

/** Boot the module against a fake v1 runtime that records what it registers. */
function boot(options: { version?: number; booted?: boolean; readyState?: string; replace?: boolean; copies?: number;
                         entries?: Entry[]; noUi?: boolean; source?: string } = {}) {
  const doc = new FakeDocument();
  doc.readyState = options.readyState ?? "loading";
  const inits: Array<() => void> = [];
  const listeners: Record<string, Array<(e: { from: string; to: string }) => void>> = {};
  const maps: Array<{ modes: string; seq: string; fn: (count: null, event?: Partial<FakeEvent>) => unknown; desc: string; group: string }> = [];
  const toasts: string[] = [];
  const ran: string[] = [];
  let mode = "normal";
  const layer = doc.el("div");
  layer.setAttribute("data-vh-ui", "");
  const VH: Record<string, any> = {
    version: options.version ?? 1, booted: options.booted ?? false, disabled: false,
    init: (fn: () => void) => inits.push(fn),
    on: (evt: string, fn: (e: { from: string; to: string }) => void) => { (listeners[evt] ||= []).push(fn); },
    keys: {
      map: (modes: string, seq: string, fn: (count: null, event?: Partial<FakeEvent>) => unknown, opts: { desc: string; group: string }) =>
        maps.push({ modes, seq, fn, desc: opts.desc, group: opts.group }),
      list: () => (options.entries ?? ENTRIES).concat(maps.map(m => ({ modes: [m.modes], seq: m.seq, desc: m.desc, group: m.group }))),
    },
    mode: {
      get: () => mode,
      set: (to: string) => {
        if (to === mode) return;
        const from = mode;
        mode = to;
        (listeners.mode ?? []).forEach(fn => fn({ from, to }));
      },
    },
    commands: { run: (text: string) => ran.push(text) },
    toast: (text: string) => toasts.push(text),
    ui: options.noUi ? undefined : {
      layer,
      h: (tag: string, attrs: Record<string, unknown> | null, kids?: Array<FakeEl | string>) => {
        const el = doc.el(tag);
        Object.entries(attrs ?? {}).forEach(([k, v]) => {
          if (v == null || v === false) return;
          if (k === "class") el.setAttribute("class", String(v));
          else if (k === "text") el.textContent = String(v);
          else el.setAttribute(k, String(v));
        });
        (kids ?? []).forEach(kid => el.appendChild(typeof kid === "string" ? doc.text(kid) : kid));
        return el;
      },
    },
  };
  const window: { __VH: unknown } = { __VH: VH };
  for (let n = 0; n < (options.copies ?? 1); n++) new Function("window", "document", options.source ?? moduleSource)(window, doc);
  if (options.replace) window.__VH = { ...VH };
  VH.booted = true;
  inits.forEach(fn => fn());

  const root = () => layer.find("docs-ks")[0];
  const input = () => layer.find("docs-ks-input")[0];
  const rows = () => layer.find("docs-ks-row");
  const open = (event?: Partial<FakeEvent>) => maps.find(m => m.seq === "<leader>sk")!.fn(null, event);
  const type = (text: string) => { input().value = text; input().selectionEnd = text.length; input().fire("input"); };
  const press = (key: string, mods: Partial<FakeEvent> = {}) => input().fire("keydown", { key, ...mods });
  const selected = () => rows().findIndex(r => r.getAttribute("aria-selected") === "true");
  const keysOf = () => rows().map(r => r.find("docs-ks-keys")[0].textContent);
  return { VH, doc, layer, inits, maps, listeners, toasts, ran, root, input, rows, open, type, press, selected, keysOf,
           count: () => layer.find("docs-ks-count")[0].textContent, mode: () => mode };
}

describe("keymap search (Space s k)", () => {
  it("ships once in each served layer: inside the runtime guard and after the baked hook", () => {
    expect(moduleSource.startsWith(MARK)).toBe(true);
    expect(runtimeScript.split(moduleSource).length - 1).toBe(1);
    expect(runtimeScript.endsWith(moduleSource + "\n}")).toBe(true);
    expect(bakedHookScript.endsWith("\n" + moduleSource)).toBe(true);
    expect(bakedHookScript.indexOf(MARK)).toBeGreaterThan(0);
    // The scanner and the served script element must never see markup here.
    expect(moduleSource).not.toMatch(/<script|<\/style|<!--/i);
    // Nor the hosting markers enhanceHtml reads: they mean "already served".
    expect(moduleSource).not.toMatch(/data-docs-vim-quiet|vim-html:(?:head|body)|data-vh\s*=/i);
    expect(moduleSource).toMatch(/^[\x00-\x7f]*$/);
  });

  it("registers one normal-mode Space s k under search alongside the baked hook's dC", () => {
    expect(boot().maps.map(m => [m.modes, m.seq, m.desc, m.group])).toEqual([["normal", "<leader>sk", "search keymaps", "search"]]);
    // The whole served baked script: its startup hook first, then this module.
    let numbers = true;
    const doc = new FakeDocument();
    const maps: string[] = [];
    const inits: Array<() => void> = [];
    const VH: Record<string, unknown> = {
      version: 1, booted: false, init: (fn: () => void) => inits.push(fn), on: () => {},
      gutter: { numbers: () => numbers, toggleNumbers: () => (numbers = !numbers) },
      keys: { map: (modes: string, seq: string) => maps.push(modes + " " + seq), list: () => [] },
      commands: { run: () => true }, mode: { get: () => "normal", set: () => {} }, ui: { h: () => doc.el("div") },
    };
    new Function("window", "document", bakedHookScript)({ __VH: VH }, doc);
    inits.forEach(fn => fn());
    expect([maps, numbers]).toEqual([["normal dC", "normal <leader>sk"], false]);
  });

  it.each([
    ["an unknown runtime version", { version: 2 }],
    ["an already-booted runtime", { booted: true }],
    ["a page past parsing", { readyState: "interactive" }],
    ["a runtime without the UI interface", { noUi: true }],
  ])("leaves %s alone", (_name, options) => {
    const t = boot(options);
    expect([t.inits.length, t.maps.length]).toEqual([0, 0]);
  });

  it("does not attach to a replaced instance, an authored Space s k, or a second copy", () => {
    expect(boot({ replace: true }).maps).toEqual([]);
    const authored = boot({ entries: [...ENTRIES, { modes: ["normal"], seq: "<Space>sk", desc: "authored", group: "" }] });
    expect(authored.maps).toEqual([]);
    const twice = boot({ copies: 2 });
    expect(twice.maps.length).toBe(1);
    expect(twice.listeners.mode.length).toBe(1);
  });

  it("opens one focused picker over the live keymap list, in registration order", () => {
    const t = boot();
    t.open();
    t.open();
    expect(t.layer.find("docs-ks").length).toBe(1);
    expect(t.mode()).toBe("command");
    expect(t.doc.activeElement).toBe(t.input());
    expect(t.count()).toBe(`${ENTRIES.length + 1}/${ENTRIES.length + 1}`);
    expect(t.keysOf()).toEqual(["j", "gg", "Ctrl-d", "za", "dc", "gc", "D", "Spacesb", "Space?", "Ctrl-u", "m{a-z}", "gx", "Spacesk"]);
    expect(t.selected()).toBe(0);
    expect(t.input().getAttribute("aria-activedescendant")).toBe("docs-ks-opt-0");
    // Modes read as nvim's letters plus the runtime's own contexts; groups follow.
    expect(t.rows()[5].find("docs-ks-meta")[0].textContent).toBe("nvVcomments");
    expect(t.rows()[6].find("docs-ks-mode")[0].getAttribute("title")).toBe("sidebar");
  });

  it("ranks keys, descriptions, groups and modes case-insensitively, exact key case first", () => {
    const t = boot({ entries: [...ENTRIES, { modes: ["normal"], seq: "dC", desc: "delete all comments in this document (u undoes)", group: "comments" },
                               { modes: ["normal"], seq: "gD", desc: "deliberately slow", group: "proof" }] });
    t.open();
    t.type("dC");
    expect(t.keysOf().slice(0, 2)).toEqual(["dC", "dc"]);
    t.type("dc");
    expect(t.keysOf().slice(0, 2)).toEqual(["dc", "dC"]);
    t.type("<leader>s");
    expect(t.keysOf()).toEqual(["Spacesb", "Spacesk"]);
    t.type("Space s k");
    expect(t.keysOf()[0]).toBe("Spacesk");
    t.type("sk");
    expect(t.keysOf()[0]).toBe("Spacesk");
    t.type("ctrl-d");
    expect(t.keysOf()[0]).toBe("Ctrl-d");
    t.type("FOLD");
    expect(t.keysOf()).toEqual(["za"]);
    // Every word must match; dc's "comments" is its group, so it ranks last.
    t.type("delete comments");
    expect(t.keysOf()).toEqual(["D", "dC", "dc"]);
    t.type("  sidebar  ");
    expect(t.keysOf()).toEqual(["D"]);
    t.type("visual");
    expect(t.keysOf()).toEqual(["gc"]);
    t.type("cmnts");  // fuzzy: the letters of "comments" in order, close together
    expect(t.keysOf()).toEqual(["D", "dC", "dc"]);
    expect(t.count()).toBe(`3/${ENTRIES.length + 3}`);
    t.type("hre");  // close together in za's "here", not scattered over gg's "the first line"
    expect(t.keysOf()).toEqual(["za"]);
    // Fuzzy only rescues a word with no literal match: "delete" keeps to the
    // literal deletes, while "dlbrt" can still find "deliberately".
    t.type("delete");
    expect(t.keysOf()).not.toContain("gD");
    t.type("dlbrt");
    expect(t.keysOf()).toEqual(["gD"]);
    // Matched description characters are marked, as text.
    t.type("delete");
    expect(t.rows()[0].find("docs-ks-hit").map(m => m.textContent)).toEqual(["delete"]);
  });

  it("shows a count and an inert empty state, and keeps hostile text as text", () => {
    const t = boot();
    t.open();
    t.type('<b onclick="x">zzqx</b>');
    expect(t.rows()).toEqual([]);
    expect(t.count()).toBe(`0/${ENTRIES.length + 1}`);
    const empty = t.layer.find("docs-ks-empty")[0];
    expect(empty.textContent).toContain('No keymaps match “<b onclick="x">zzqx</b>”');
    expect(t.input().getAttribute("aria-activedescendant")).toBe(null);
    t.type("bold");
    const row = t.rows()[0];
    expect(row.find("docs-ks-desc")[0].textContent).toBe('<img src=x onerror="window.pwned=1"><b>bold</b>');
    expect(row.find("docs-ks-group")[0].textContent).toBe("<i>group</i>");
    // Only elements the module itself names exist: no img, b or i was parsed.
    expect(t.doc.created.some(el => ["img", "b", "i"].includes(el.tag))).toBe(false);
    // Authored display rows can name anything; inherited object keys are not labels.
    const odd = boot({ entries: [{ modes: ["normal"], seq: "<constructor><toString>x", desc: "odd", group: "" }] });
    odd.open();
    expect(odd.keysOf()[0]).toBe("constructortoStringx");
  });

  it("moves with arrows, Ctrl-n/p/j/k, Tab and pages, and never runs the selected key", () => {
    const t = boot();
    t.open();
    const moves: Array<[string, Partial<FakeEvent>, number]> = [
      ["ArrowDown", {}, 1], ["n", { ctrlKey: true }, 2], ["j", { ctrlKey: true }, 3], ["Tab", {}, 4],
      ["ArrowUp", {}, 3], ["p", { ctrlKey: true }, 2], ["k", { ctrlKey: true }, 1], ["Tab", { shiftKey: true }, 0],
      ["ArrowUp", {}, 0], ["PageDown", {}, 4], ["PageDown", {}, 8], ["PageUp", {}, 4],
    ];
    for (const [key, mods, expected] of moves) {
      const event = t.press(key, mods);
      expect([key, event.defaultPrevented, t.selected()]).toEqual([key, true, expected]);
    }
    // The selection scrolls the list into view, not the page.
    const list = t.layer.find("docs-ks-list")[0];
    expect(list.scrollTop).toBeGreaterThan(0);
    for (let n = 0; n < 20; n++) t.press("ArrowDown");
    expect(t.selected()).toBe(t.rows().length - 1);
    const enter = t.press("Enter");
    expect(enter.defaultPrevented).toBe(true);
    expect(t.toasts).toEqual(["Listing only. Esc, then press Space sk"]);
    expect(t.ran).toEqual([]);
    expect(t.root()).toBeDefined();
    // Typing is the input's own: printable keys are not prevented, only kept
    // from bubbling to authored handlers.
    for (const key of ["j", "k", "q", ":", " ", "d", "C"]) {
      const event = t.press(key);
      expect([key, event.defaultPrevented, event.stopped]).toEqual([key, false, true]);
    }
    expect(t.press("Enter", { isComposing: true }).defaultPrevented).toBe(false);
  });

  it("Ctrl-u clears the query up to the caret", () => {
    const t = boot();
    t.open();
    t.type("fold here");
    t.input().selectionEnd = 5;
    t.press("u", { ctrlKey: true });
    expect([t.input().value, t.input().selectionStart]).toEqual(["here", 0]);
    expect(t.keysOf()).toEqual(["za"]);
  });

  it("closes on Esc, Ctrl-c, the backdrop and the close button, restoring focus; reopens clean", () => {
    const t = boot();
    const link = t.doc.el("a");
    for (const close of [
      () => t.VH.mode.set("normal"),            // core's Esc fallback leaves 'command'
      () => t.press("c", { ctrlKey: true }),
      () => t.press("Escape"),
      () => t.root().fire("mousedown"),
      () => t.layer.find("docs-ks-close")[0].fire("click"),
    ]) {
      link.focus();
      t.open();
      expect(t.doc.activeElement).toBe(t.input());
      close();
      expect([t.root(), t.mode(), t.doc.activeElement]).toEqual([undefined, "normal", link]);
    }
    // Rebuilt per open, never stacked: one picker, one style, one 'mode' listener.
    t.open();
    expect([t.layer.find("docs-ks").length, t.layer.children.filter(c => c.tag === "style").length, t.listeners.mode.length]).toEqual([1, 1, 1]);
    // A mousedown inside the box keeps focus in the query instead of closing.
    const inside = t.rows()[0].fire("mousedown");
    expect([inside.defaultPrevented, t.root() !== undefined]).toEqual([true, true]);
    // A row click selects without running anything.
    t.rows()[3].find("docs-ks-desc")[0].fire("click");
    expect([t.selected(), t.ran, t.root() !== undefined]).toEqual([3, [], true]);
  });

  it("declines, leaving the key to the page, inside authored modals, ARIA text widgets and native controls", () => {
    // The baked runtime dispatches here (only the enhanced dispatcher guards
    // these), so the picker itself must decline rather than open behind a modal.
    const t = boot();
    const page = t.doc.el("main");
    t.doc.body.appendChild(page);
    const target = (tag: string, attrs: Record<string, string> = {}) => {
      const el = t.doc.el(tag);
      Object.entries(attrs).forEach(([k, v]) => el.setAttribute(k, v));
      page.appendChild(el);
      return el;
    };
    for (const el of [target("div", { role: "textbox" }), target("button"), target("a", { href: "#x" }), target("summary")]) {
      expect([el.tag, t.open({ target: el })]).toEqual([el.tag, false]);
      el.focus();
      expect([el.tag, t.open()]).toEqual([el.tag, false]);
    }
    // A text node target resolves to its element.
    const box = target("div", { role: "searchbox" });
    box.appendChild(t.doc.text("query"));
    expect(t.open({ target: box.children[0] })).toBe(false);
    const modal = target("dialog", { open: "" });
    t.doc.modals.push(modal);
    expect(t.open({ target: target("div", { tabindex: "0" }) })).toBe(false);
    expect([t.root(), t.mode()]).toEqual([undefined, "normal"]);
    // Our own open runtime UI is not an authored modal; a plain focusable region opens.
    modal.removeAttribute("open");
    t.doc.modals = [t.doc.el("div")];
    t.doc.modals[0].setAttribute("aria-modal", "true");
    t.layer.appendChild(t.doc.modals[0]);
    expect(t.open({ target: target("div", { tabindex: "0" }) })).toBeUndefined();
    expect(t.root()).toBeDefined();
  });

  it("closes without stealing focus when the reader leaves for a page field or turns Vim off", () => {
    const t = boot();
    const field = t.doc.el("input");
    t.open();
    field.focus();
    t.VH.mode.set("insert");  // core's focusin on an authored field
    expect([t.root(), t.doc.activeElement]).toEqual([undefined, field]);
    t.VH.mode.set("normal");
    // Vim off: host.js sets VH.disabled and the key no longer opens anything.
    t.VH.disabled = true;
    expect(t.open()).toBe(false);
    expect(t.root()).toBeUndefined();
  });
});
