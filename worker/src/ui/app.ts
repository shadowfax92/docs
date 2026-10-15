/**
 * Library view for the private catalog at /all-docs (catalog origin only).
 *
 * Renders `CatalogClient` state into the trusted shell and turns user intent into client calls;
 * HTTP, worker messaging, selection and review rules all live in catalog-client.ts. This file is
 * loaded as a classic blocking script from <head>: the theme is applied before first paint, and
 * everything else waits for DOMContentLoaded. The bundle must therefore stay free of exports.
 *
 * Filter state lives in the URL fragment (/all-docs#q=…&age=gt90): the catalog serves the shell only
 * without a query string, and a fragment keeps search terms out of requests and server logs.
 *
 * Safety: uploaded strings (titles, filenames, snippets, warnings) and extraction reasons only ever
 * become text nodes; nothing here assigns innerHTML. Document links go to http(s) URLs on another
 * origin, in a new tab with noopener/noreferrer, so no uploaded markup can run with this origin's
 * session. HTML card previews are inert, fully sandboxed frames of the public origin, owned by
 * card-preview.ts; the catalog never fetches or parses uploaded markup itself.
 */
import {
  AGE_PRESETS, CatalogClient, FILE_KINDS, KIND_LABEL, RENDER_STEP, SORT_LABEL, describeWindow, displayTitle,
  filtersFromParams, filtersToParams, formatBytes, formatDate, formatDateTime, formatRelative,
  type AgePreset, type ContentProgress, type DeleteOutcome, type Filters, type ReviewState, type SearchPort, type SortKey,
} from "./catalog-client";
import { CardPreviews, previewKey } from "./card-preview";
import { coverageNote } from "./coverage-note";
import type { DocumentSummary, FileKind } from "../contracts";
import type { SearchHit, SearchWorkerResponse } from "../search";

// ---------------------------------------------------------------------------------------------
// Theme: runs synchronously in <head>. Light by default; one moon/sun toggle, saved per origin.

type Theme = "light" | "dark";
const THEME_KEY = "docs-theme";

function storedTheme(): Theme {
  try {
    return localStorage.getItem(THEME_KEY) === "dark" ? "dark" : "light";
  } catch {
    return "light"; // Storage can be blocked; the default theme is always valid.
  }
}

function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
}

applyTheme(storedTheme());
document.documentElement.dataset.view = "booting";
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot, { once: true });
else boot();

function boot(): void {
  try {
    const client = new CatalogClient({
      fetch: (input, init) => fetch(input, init),
      openSearch: openSearchWorker,
      now: () => Date.now(),
    }, new URLSearchParams(location.hash.slice(1)));
    new LibraryApp(client).mount();
    void client.start();
  } catch (error) {
    // Show the login view with an explanation; its submit stays disabled because the catalog only
    // accepts the JSON login this script sends.
    document.documentElement.dataset.view = "login";
    const message = document.getElementById("login-error");
    if (message) message.textContent = "The library couldn't start in this browser.";
    console.error(error);
  }
}

/** Browser adapter for the search seam: one dedicated worker per session, terminated on lock. */
function openSearchWorker(handlers: { message(reply: SearchWorkerResponse): void; failure(reason: string): void }): SearchPort {
  const worker = new Worker("/all-docs/assets/search-worker.js", { type: "module", name: "docs-search" });
  worker.onmessage = (event: MessageEvent<SearchWorkerResponse>) => handlers.message(event.data);
  worker.onerror = (event) => {
    event.preventDefault();
    handlers.failure("Content search stopped working in this tab.");
  };
  worker.onmessageerror = () => handlers.failure("Content search sent an unreadable reply.");
  return { post: (message) => worker.postMessage(message), terminate: () => worker.terminate() };
}

// ---------------------------------------------------------------------------------------------
// DOM helpers. Strings become text nodes; attributes go through setAttribute.

type Child = Node | string | number | null | undefined | false | readonly Child[];
type Props = Record<string, string | number | boolean | null | undefined>;

function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props | null = null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (props) {
    for (const [name, value] of Object.entries(props)) {
      if (value === null || value === undefined || value === false) continue;
      element.setAttribute(name, value === true ? "" : String(value));
    }
  }
  append(element, children);
  return element;
}

function append(parent: Node, children: readonly Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    if (Array.isArray(child)) append(parent, child);
    else if (typeof child === "string" || typeof child === "number") parent.appendChild(document.createTextNode(String(child)));
    else parent.appendChild(child as Node);
  }
}

// Typed against Node: the Worker types share this program and shadow DOM's Element.append.
function replace(parent: Node, ...children: Child[]): void {
  parent.textContent = "";
  append(parent, children);
}

const SVG = "http://www.w3.org/2000/svg";
function icon(name: "moon" | "sun" | "search"): SVGSVGElement {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.75");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  const shapes: Record<typeof name, string[]> = {
    moon: ["path:M20.5 14.2A8.5 8.5 0 1 1 9.8 3.5a6.6 6.6 0 0 0 10.7 10.7Z"],
    sun: ["circle:12,12,4", "path:M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"],
    search: ["circle:11,11,6.5", "path:m20 20-4.4-4.4"],
  };
  for (const shape of shapes[name]) {
    const [kind, value] = shape.split(":");
    const node = document.createElementNS(SVG, kind);
    if (kind === "path") node.setAttribute("d", value);
    else {
      const [cx, cy, r] = value.split(",");
      node.setAttribute("cx", cx);
      node.setAttribute("cy", cy);
      node.setAttribute("r", r);
    }
    svg.appendChild(node);
  }
  return svg;
}

/** Only http(s) links to another origin are rendered; anything else stays plain text. */
function externalUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && url.origin !== location.origin ? url.href : null;
  } catch {
    return null;
  }
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count.toLocaleString("en-US")} ${count === 1 ? one : many}`;
}

/**
 * Makes `parent`'s children exactly `nodes`, in order, without detaching a node that is already in
 * place: removing an <iframe> from the document discards its page, so a live preview reloads (and
 * flashes) on any detach. Stale children go first, so kept nodes never need to move past them.
 * A kept node that must move uses the state-preserving moveBefore() where the browser has it.
 */
function syncChildren(parent: Node, nodes: readonly Node[]): void {
  const keep = new Set(nodes);
  for (const child of Array.from(parent.childNodes)) if (!keep.has(child)) parent.removeChild(child);
  let cursor = parent.firstChild;
  for (const node of nodes) {
    if (node === cursor) {
      cursor = cursor.nextSibling;
      continue;
    }
    const move = (parent as Node & { moveBefore?: (node: Node, child: Node | null) => void }).moveBefore;
    if (move && node.isConnected && parent.isConnected) {
      try {
        move.call(parent, node, cursor);
        continue;
      } catch { /* Fall back to a plain (reloading) insert. */ }
    }
    parent.insertBefore(node, cursor);
  }
}

const OLDER_AGES: readonly AgePreset[] = ["gt30", "gt90", "gt365"];

// ---------------------------------------------------------------------------------------------

interface Refs {
  rail: HTMLElement;
  railList: HTMLUListElement;
  main: HTMLElement;
  title: HTMLHeadingElement;
  subtitle: HTMLParagraphElement;
  scanLine: HTMLParagraphElement;
  search: HTMLInputElement;
  regex: HTMLButtonElement;
  matchCase: HTMLButtonElement;
  searchError: HTMLParagraphElement;
  age: HTMLSelectElement;
  range: HTMLSpanElement;
  from: HTMLInputElement;
  to: HTMLInputElement;
  rangeError: HTMLParagraphElement;
  olderChip: HTMLButtonElement;
  sort: HTMLSelectElement;
  chipRow: HTMLElement;
  cutoff: HTMLParagraphElement;
  cutoffText: HTMLSpanElement;
  banner: HTMLElement;
  resultsLabel: HTMLHeadingElement;
  labelGroup: HTMLElement;
  selectGroup: HTMLElement;
  coverage: HTMLElement;
  grid: HTMLUListElement;
  more: HTMLElement;
  empty: HTMLElement;
  bar: HTMLElement;
  review: HTMLDialogElement;
  shortcuts: HTMLDialogElement;
}

class LibraryApp {
  private refs!: Refs;
  private readonly status = document.getElementById("status") as HTMLElement;
  private readonly loginForm = document.getElementById("login-form") as HTMLFormElement;
  private readonly password = document.getElementById("password") as HTMLInputElement;
  private readonly loginError = document.getElementById("login-error") as HTMLParagraphElement;
  private readonly loginNotice = document.getElementById("login-notice") as HTMLParagraphElement;
  private readonly themeButtons: HTMLButtonElement[] = [];
  private frame = 0;
  private gridKey = "";
  private reviewKey = "";
  private reviewInvoker: HTMLElement | null = null;
  private countTimer: ReturnType<typeof setTimeout> | null = null;
  private lastView = "";
  private minute = 0;
  /** One list item per rendered document ID, reused across renders so its preview stays live. */
  private readonly cardItems = new Map<string, HTMLLIElement>();
  // A refused preview frame turns previews off for the tab; the next render is all compact cards.
  private readonly previews = new CardPreviews(() => {
    this.gridKey = "";
    this.schedule();
  });

  constructor(private readonly client: CatalogClient) {}

  mount(): void {
    const library = document.getElementById("library") as HTMLElement;
    this.refs = this.buildLibrary(library);
    const slot = document.querySelector("[data-theme-slot]");
    if (slot) slot.appendChild(this.themeButton());
    this.loginForm.addEventListener("submit", (event) => {
      event.preventDefault();
      // The secret leaves the DOM as soon as it is sent, so a locked screen never holds it.
      const password = this.password.value;
      this.password.value = "";
      void this.client.signIn(password);
    });
    (this.loginForm.querySelector("button") as HTMLButtonElement).disabled = false;
    this.client.subscribe(() => this.schedule());
    this.client.onAnnounce((text) => this.announce(text));
    const fromUrl = () => this.client.setFilters(filtersFromParams(new URLSearchParams(location.hash.slice(1))));
    window.addEventListener("popstate", fromUrl);
    window.addEventListener("hashchange", fromUrl);
    document.addEventListener("keydown", (event) => this.onGlobalKey(event));
    // Relative ages ("5 min ago") stay honest without re-rendering on every tick of the clock.
    setInterval(() => {
      this.minute++;
      this.schedule();
    }, 60_000);
    this.render();
  }

  private schedule(): void {
    if (!this.frame) this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.render();
    });
  }

  private announce(text: string): void {
    this.status.textContent = "";
    // A fresh text node after a tick makes screen readers repeat identical announcements.
    setTimeout(() => {
      this.status.textContent = text;
    }, 30);
  }

  // ---- Structure (built once) ---------------------------------------------------------------

  private themeButton(): HTMLButtonElement {
    const button = h("button", { type: "button", class: "icon-button theme-toggle", "data-ready": true });
    button.addEventListener("click", () => {
      const next: Theme = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
      applyTheme(next);
      try {
        localStorage.setItem(THEME_KEY, next);
      } catch { /* The choice still applies for this page view. */ }
      this.renderTheme();
    });
    this.themeButtons.push(button);
    return button;
  }

  private renderTheme(): void {
    const dark = document.documentElement.dataset.theme === "dark";
    for (const button of this.themeButtons) {
      button.setAttribute("aria-label", dark ? "Switch to light theme" : "Switch to dark theme");
      button.title = dark ? "Light theme" : "Dark theme";
      replace(button, icon(dark ? "sun" : "moon"));
    }
  }

  private buildLibrary(root: HTMLElement): Refs {
    const client = this.client;
    const railList = h("ul", { role: "list" });
    const rail = h("nav", { class: "rail", "aria-label": "Filter by type" },
      h("div", { class: "brand" }, h("p", { class: "wordmark" }, "docs"), h("p", { class: "micro" }, "all-docs")),
      h("h2", null, "Type"),
      railList,
    );

    const title = h("h1", { id: "library-title" }, "All documents");
    const subtitle = h("p", { class: "display-2" });
    const scanLine = h("p", { class: "scan-line" });
    const lock = h("button", { type: "button", class: "text-button" }, "Lock");
    lock.addEventListener("click", () => {
      void this.client.lock().then(() => this.schedule());
      history.replaceState(null, "", "/all-docs");
    });

    const search = h("input", {
      type: "search", id: "search", placeholder: "Search names and content", autocomplete: "off",
      spellcheck: "false", "aria-label": "Search names and content", "aria-describedby": "search-error",
    });
    const regex = h("button", { type: "button", class: "toggle", "aria-pressed": "false", "aria-label": "Regular expression (RE2)", title: "Regular expression (RE2)" }, ".*");
    const matchCase = h("button", { type: "button", class: "toggle", "aria-pressed": "false", "aria-label": "Match case", title: "Match case" }, "Aa");
    const searchError = h("p", { class: "error", id: "search-error", role: "alert" });
    search.addEventListener("input", () => {
      client.setFilters({ text: search.value });
      this.syncUrl(false);
      this.announceCountSoon();
    });
    search.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      if (search.value) {
        search.value = "";
        client.setFilters({ text: "" });
        this.syncUrl(true);
        this.announceCountSoon();
      } else {
        this.focusCard(0);
      }
    });
    regex.addEventListener("click", () => this.changeFilters({ regex: !client.filters.regex }));
    matchCase.addEventListener("click", () => this.changeFilters({ matchCase: !client.filters.matchCase }));

    const age = h("select", { id: "age" }, AGE_PRESETS.map((preset) => h("option", { value: preset.value }, preset.label)));
    age.addEventListener("change", () => {
      const value = age.value as AgePreset;
      if (value === "range") client.setRange(this.refs.from.value, this.refs.to.value);
      else this.changeFilters({ age: value });
      this.syncUrl(true);
    });
    const from = h("input", { type: "date", class: "date", id: "range-from", "aria-describedby": "range-error" });
    const to = h("input", { type: "date", class: "date", id: "range-to", "aria-describedby": "range-error" });
    const rangeError = h("p", { class: "error", id: "range-error", role: "alert" });
    const onRange = () => {
      rangeError.textContent = client.setRange(from.value, to.value) ?? "";
      this.syncUrl(true);
      this.announceCountSoon();
    };
    from.addEventListener("change", onRange);
    to.addEventListener("change", onRange);
    const range = h("span", { class: "range", hidden: true },
      h("label", { class: "filter", for: "range-from" }, "From"), from,
      h("label", { class: "filter", for: "range-to" }, "To"), to,
    );
    const olderChip = h("button", { type: "button", class: "chip", "aria-pressed": "false" });
    olderChip.addEventListener("click", () => this.changeFilters({ age: client.filters.age === "gt90" ? "any" : "gt90" }));
    const sort = h("select", { id: "sort" });
    sort.addEventListener("change", () => this.changeFilters({ sort: sort.value as SortKey }));

    const chipRow = h("div", { class: "chiprow", role: "region", "aria-label": "Filter by type", tabindex: "0" });
    const resetCutoff = h("button", { type: "button", class: "text-button" }, "Reset cutoff");
    resetCutoff.addEventListener("click", () => {
      client.resetCutoff();
      this.announceCountSoon();
    });
    const cutoffText = h("span");
    const cutoff = h("p", { class: "cutoff", hidden: true }, cutoffText, resetCutoff);

    const toolbar = h("section", { class: "toolbar", "aria-label": "Search and filters" },
      h("div", { class: "search" }, icon("search"), search, h("kbd", { "aria-hidden": "true" }, navigator.platform.startsWith("Mac") ? "⌘K" : "Ctrl K"), regex, matchCase),
      searchError,
      h("div", { class: "filters" },
        h("label", { class: "filter", for: "age" }, "Uploaded"), h("span", { class: "select" }, age),
        range,
        olderChip,
        h("label", { class: "filter", for: "sort" }, "Sort"), h("span", { class: "select" }, sort),
      ),
      rangeError,
      chipRow,
      cutoff,
    );

    const banner = h("div", { class: "banner", role: "alert", hidden: true });
    const resultsLabel = h("h2", { class: "micro", id: "results-label" });
    const labelGroup = h("div", { class: "label-group" }, resultsLabel);
    const selectGroup = h("div", { class: "select-group" });
    const coverage = h("div", { class: "coverage", hidden: true });
    const grid = h("ul", { class: "grid", role: "list", "aria-labelledby": "results-label" });
    grid.addEventListener("click", (event) => this.onGridClick(event));
    grid.addEventListener("keydown", (event) => this.onGridKey(event));
    const more = h("div", { class: "more", hidden: true });
    const empty = h("div", { class: "empty", hidden: true });
    const shortcutsButton = h("button", { type: "button", class: "text-button" }, "Keyboard shortcuts");
    const bar = h("div", { class: "selection-bar", role: "region", "aria-label": "Selection", hidden: true });

    const review = h("dialog", { "aria-labelledby": "review-title", "aria-describedby": "review-summary" });
    review.addEventListener("cancel", (event) => {
      if (client.review?.phase === "running") event.preventDefault();
    });
    review.addEventListener("close", () => {
      if (client.review) client.closeReview();
      this.reviewKey = "";
      const invoker = this.reviewInvoker;
      this.reviewInvoker = null;
      if (invoker?.isConnected) invoker.focus();
      else this.focusCard(0);
    });

    const shortcuts = this.buildShortcuts();
    shortcutsButton.addEventListener("click", () => shortcuts.showModal());

    const main = h("main", { class: "content", id: "main", "aria-labelledby": "library-title" },
      h("header", { class: "head" },
        h("div", null,
          h("p", { class: "wordmark brand-inline" }, "docs", h("span", { class: "micro" }, "all-docs")),
          title, subtitle, scanLine),
        h("div", { class: "head-actions" }, lock, this.themeButton()),
      ),
      toolbar,
      banner,
      h("section", { class: "results", "aria-labelledby": "results-label" },
        h("div", { class: "results-head" }, labelGroup, selectGroup),
        coverage,
        grid,
        more,
        empty,
      ),
      h("footer", { class: "foot" }, shortcutsButton),
      bar,
    );
    replace(root, h("a", { class: "skip-link pill primary", href: "#main" }, "Skip to documents"), rail, main, review, shortcuts);
    return {
      rail, railList, main, title, subtitle, scanLine, search, regex, matchCase, searchError, age, range, from, to,
      rangeError, olderChip, sort, chipRow, cutoff, cutoffText, banner, resultsLabel, labelGroup, selectGroup,
      coverage, grid, more, empty, bar, review, shortcuts,
    };
  }

  private buildShortcuts(): HTMLDialogElement {
    const rows: [string, string][] = [
      ["⌘K / Ctrl K", "Focus search"],
      ["Esc (search)", "Clear the query; again to move to the documents"],
      ["← ↑ → ↓", "Move between documents"],
      ["Enter", "Open the focused document in a new tab"],
      ["x / Shift x", "Select, or select a range"],
      ["/", "Focus search"],
      ["Delete", "Review deletion of the selection (never deletes directly)"],
      ["Esc (documents)", "Clear the selection"],
    ];
    const close = h("button", { type: "button", class: "pill secondary" }, "Close");
    const dialog = h("dialog", { "aria-labelledby": "shortcuts-title" },
      h("div", { class: "dialog-body" },
        h("h2", { id: "shortcuts-title" }, "Keyboard shortcuts"),
        h("p", { class: "muted" }, "Single-key shortcuts work while focus is on a document."),
        h("dl", { class: "shortcuts" }, rows.map(([keys, action]) => [h("dt", null, keys), h("dd", null, action)])),
      ),
      h("div", { class: "dialog-foot" }, close),
    );
    close.addEventListener("click", () => dialog.close());
    return dialog;
  }

  // ---- Intent ---------------------------------------------------------------------------------

  private changeFilters(patch: Partial<Filters>): void {
    this.client.setFilters(patch);
    this.syncUrl(true);
    this.announceCountSoon();
  }

  /** Mirrors filters into the URL fragment: replaceState while typing, pushState for discrete changes. */
  private syncUrl(push: boolean): void {
    const state = filtersToParams(this.client.filters).toString();
    const url = `/all-docs${state ? `#${state}` : ""}`;
    if (url === `${location.pathname}${location.search}${location.hash}`) return;
    if (push) history.pushState(null, "", url);
    else history.replaceState(null, "", url);
  }

  private announceCountSoon(): void {
    if (this.countTimer !== null) clearTimeout(this.countTimer);
    this.countTimer = setTimeout(() => {
      this.countTimer = null;
      if (this.client.view !== "library") return;
      if (this.client.filters.text && this.client.search.status === "pending") return this.announceCountSoon();
      const count = this.client.results().matching.length;
      this.announce(this.client.filters.text ? `${plural(count, "document")} ${count === 1 ? "matches" : "match"}` : plural(count, "document"));
    }, 500);
  }

  private openReview(single: string | undefined, invoker: HTMLElement | null): void {
    if (!this.client.openReview(single)) return;
    this.reviewInvoker = invoker;
    this.render();
  }

  private onGridClick(event: MouseEvent): void {
    const target = event.target as HTMLElement;
    const action = target.closest<HTMLElement>("[data-action]");
    const card = target.closest<HTMLElement>("[data-id]");
    if (!action || !card?.dataset.id) return;
    const id = card.dataset.id;
    switch (action.dataset.action) {
      case "toggle":
        this.client.toggle(id, event.shiftKey);
        break;
      case "copy": {
        const doc = this.client.summary(id);
        const url = doc ? externalUrl(doc.publicUrl) : null;
        if (!url) break;
        navigator.clipboard.writeText(url).then(() => {
          action.textContent = "Copied";
          this.announce("Link copied");
          setTimeout(() => {
            action.textContent = "Copy link";
          }, 1500);
        }, () => this.announce("Couldn't copy the link"));
        break;
      }
      case "delete":
        this.openReview(id, action);
        break;
    }
  }

  private onGridKey(event: KeyboardEvent): void {
    const target = event.target as HTMLElement;
    const card = target.closest<HTMLElement>("[data-id]");
    if (!card?.dataset.id || event.altKey || event.ctrlKey || event.metaKey) return;
    const cards = Array.from(this.refs.grid.querySelectorAll<HTMLElement>("article[data-id]"));
    const index = cards.indexOf(card);
    switch (event.key) {
      case "ArrowLeft": case "ArrowRight": case "ArrowUp": case "ArrowDown": {
        const columns = Math.max(1, cards.filter((other) => other.offsetTop === cards[0]?.offsetTop).length);
        const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -columns, ArrowDown: columns }[event.key];
        const next = Math.min(cards.length - 1, Math.max(0, index + step));
        event.preventDefault();
        this.focusCard(next);
        break;
      }
      case "x": case "X":
        event.preventDefault();
        this.client.toggle(card.dataset.id, event.shiftKey);
        break;
      case "/":
        event.preventDefault();
        this.refs.search.focus();
        break;
      case "Delete": case "Backspace":
        if (this.client.selection.scope === "none") return;
        event.preventDefault();
        this.openReview(undefined, target);
        break;
      case "Escape":
        if (this.client.selection.scope === "none") return;
        event.preventDefault();
        this.client.clearSelection("Selection cleared.");
        break;
    }
  }

  private onGlobalKey(event: KeyboardEvent): void {
    if (this.client.view !== "library" || this.refs.review.open || this.refs.shortcuts.open) return;
    if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "k") {
      event.preventDefault();
      this.refs.search.focus();
      this.refs.search.select();
    }
  }

  private focusCard(index: number): void {
    const links = this.refs.grid.querySelectorAll<HTMLElement>("[data-focus='title']");
    links[index]?.focus();
  }

  // ---- Rendering ------------------------------------------------------------------------------

  private render(): void {
    const client = this.client;
    const root = document.documentElement;
    if (client.view !== "booting") root.dataset.view = client.view;
    const login = document.getElementById("login") as HTMLElement;
    const library = document.getElementById("library") as HTMLElement;
    login.hidden = client.view === "library";
    library.hidden = client.view !== "library";
    this.renderTheme();
    if (client.view === "login") this.renderLogin();
    if (client.view === "library") this.renderLibrary();
    else this.clearLibrary();
    if (this.lastView !== client.view) {
      if (client.view === "login") {
        this.password.value = "";
        this.password.focus();
      }
      this.lastView = client.view;
    }
  }

  private renderLogin(): void {
    const { problem, message, retryAfterSeconds, busy } = this.client.login;
    const copy: Record<string, string> = {
      "wrong-password": "Wrong password.",
      "rate-limited": retryAfterSeconds
        ? `Too many attempts. Try again in ${plural(Math.ceil(retryAfterSeconds / 60), "minute")}.`
        : "Too many attempts. Try again later.",
      expired: "Your session ended. Enter the password again.",
      unconfigured: "The library is not configured yet.",
      network: "Couldn't reach the library. Check the connection and try again.",
      rejected: message ?? "The library refused the request.",
    };
    const text = problem ? copy[problem] : "";
    if (this.loginError.textContent !== text) this.loginError.textContent = text;
    this.password.setAttribute("aria-invalid", problem === "wrong-password" ? "true" : "false");
    const submit = this.loginForm.querySelector("button") as HTMLButtonElement;
    submit.disabled = busy;
    submit.textContent = busy ? "Unlocking…" : "Unlock";
    if (problem === "wrong-password" && !busy && document.activeElement !== this.password) this.password.focus();
    this.loginNotice.textContent = this.client.lockNotice ?? "";
  }

  /** On lock or expiry, private titles/snippets leave the DOM along with the client state. */
  private clearLibrary(): void {
    const refs = this.refs;
    if (!this.gridKey && !refs.grid.childElementCount && !refs.subtitle.textContent) return;
    if (refs.review.open) refs.review.close();
    for (const region of [refs.grid, refs.railList, refs.chipRow, refs.review, refs.bar, refs.empty, refs.coverage, refs.banner, refs.selectGroup]) {
      region.replaceChildren();
    }
    for (const keyed of [refs.railList, refs.selectGroup, refs.banner, refs.coverage, refs.more, refs.empty, refs.bar, refs.scanLine]) {
      delete keyed.dataset.key;
    }
    refs.search.value = "";
    refs.from.value = "";
    refs.to.value = "";
    refs.subtitle.textContent = "";
    refs.resultsLabel.textContent = "";
    this.cardItems.clear();
    this.previews.clear();
    this.gridKey = "";
    this.reviewKey = "";
  }

  private renderLibrary(): void {
    const client = this.client;
    const results = client.results();
    const progress = client.contentProgress();
    this.renderHeader();
    this.renderToolbar(results.olderThan90);
    this.renderKinds(results.kindCounts);
    this.renderBanner(progress);
    this.renderResultsHead(results.matching.length, results.visible.length);
    this.renderCoverage(progress);
    this.renderGrid();
    this.renderMoreAndEmpty(results.visible.length, progress);
    this.renderBar(results.hiddenSelected);
    this.renderReview();
  }

  private renderHeader(): void {
    const client = this.client;
    const docs = client.observed();
    const scan = client.scan;
    const refs = this.refs;
    if (scan.status === "running" || scan.status === "idle") {
      refs.subtitle.textContent = `Scanning storage… ${plural(docs.length, "found", "found")}`;
      replace(refs.scanLine, "Documents appear as they are found.");
      return;
    }
    const bytes = docs.reduce((sum, doc) => sum + doc.sizeBytes, 0);
    const newest = docs.reduce((max, doc) => Math.max(max, Date.parse(doc.uploadedAt)), 0);
    refs.subtitle.textContent = docs.length
      ? `${plural(docs.length, "file")} · ${formatBytes(bytes)} · newest ${formatRelative(newest, Date.now())}`
      : "No files yet";
    const refresh = h("button", { type: "button", class: "text-button" }, "Refresh");
    refresh.addEventListener("click", () => client.refresh());
    const finished = scan.finishedAt
      ? h("time", { datetime: new Date(scan.finishedAt).toISOString() }, `scanned ${new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" }).format(scan.finishedAt)}`)
      : null;
    const key = `${scan.finishedAt}|${scan.status}`;
    if (refs.scanLine.dataset.key !== key) {
      refs.scanLine.dataset.key = key;
      replace(refs.scanLine, finished, finished ? " · " : null, refresh);
    }
  }

  private renderToolbar(olderThan90: number): void {
    const client = this.client;
    const refs = this.refs;
    const filters = client.filters;
    if (refs.search.value !== filters.text && document.activeElement !== refs.search) refs.search.value = filters.text;
    refs.regex.setAttribute("aria-pressed", String(filters.regex));
    refs.matchCase.setAttribute("aria-pressed", String(filters.matchCase));
    refs.age.value = filters.age;
    refs.range.hidden = filters.age !== "range";
    if (filters.age === "range") {
      if (document.activeElement !== refs.from) refs.from.value = filters.from;
      if (document.activeElement !== refs.to) refs.to.value = filters.to;
    } else {
      refs.rangeError.textContent = "";
    }
    refs.olderChip.setAttribute("aria-pressed", String(filters.age === "gt90"));
    refs.olderChip.textContent = `Older than 90 days · ${olderThan90.toLocaleString("en-US")}`;

    const sortKeys: SortKey[] = filters.text ? ["matches", "newest", "oldest", "largest", "name"] : ["newest", "oldest", "largest", "name"];
    const sortSignature = sortKeys.join();
    if (refs.sort.dataset.keys !== sortSignature) {
      refs.sort.dataset.keys = sortSignature;
      replace(refs.sort, sortKeys.map((key) => h("option", { value: key }, SORT_LABEL[key])));
    }
    refs.sort.value = client.effectiveSort();

    const line = client.cutoffLine();
    refs.cutoff.hidden = !line;
    refs.cutoffText.textContent = line ?? "";
    (refs.cutoff.lastElementChild as HTMLElement).hidden = filters.age === "range";

    const search = client.search;
    let error = "";
    if (search.status === "error") {
      error = search.message ?? "This pattern can't be searched.";
      if (search.hits && search.hitsKey) error += " Showing results for the last valid pattern.";
    }
    if (refs.searchError.textContent !== error) refs.searchError.textContent = error;
    refs.search.setAttribute("aria-invalid", String(search.status === "error"));
    refs.grid.classList.toggle("stale", search.status === "error" && !!search.hits);
  }

  private renderKinds(counts: Map<FileKind, number>): void {
    const client = this.client;
    const selected = new Set(client.filters.kinds);
    const kinds = FILE_KINDS.filter((kind) => (counts.get(kind) ?? 0) > 0 || selected.has(kind))
      .sort((a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0) || FILE_KINDS.indexOf(a) - FILE_KINDS.indexOf(b));
    const key = kinds.map((kind) => `${kind}:${counts.get(kind) ?? 0}:${selected.has(kind)}`).join();
    if (this.refs.railList.dataset.key === key) return;
    this.refs.railList.dataset.key = key;
    const toggle = (kind: FileKind) => {
      const next = selected.has(kind) ? client.filters.kinds.filter((other) => other !== kind) : [...client.filters.kinds, kind];
      this.changeFilters({ kinds: next });
    };
    const railFocus = document.activeElement instanceof HTMLElement && this.refs.rail.contains(document.activeElement)
      ? document.activeElement.dataset.kind : undefined;
    replace(this.refs.railList, kinds.length ? kinds.map((kind) => {
      const box = h("input", { type: "checkbox", "data-kind": kind, checked: selected.has(kind) });
      box.addEventListener("change", () => toggle(kind));
      return h("li", null, h("label", null, box, KIND_LABEL[kind], h("span", { class: "count" }, (counts.get(kind) ?? 0).toLocaleString("en-US"))));
    }) : h("li", { class: "empty-kinds" }, client.observed().length ? "No matching types" : "No types yet"));
    replace(this.refs.chipRow, kinds.map((kind) => {
      const chip = h("button", { type: "button", class: "chip", "aria-pressed": String(selected.has(kind)), "data-kind": kind },
        KIND_LABEL[kind], h("span", { class: "count" }, (counts.get(kind) ?? 0).toLocaleString("en-US")));
      chip.addEventListener("click", () => toggle(kind));
      return chip;
    }));
    if (railFocus) this.refs.railList.querySelector<HTMLElement>(`[data-kind="${railFocus}"]`)?.focus();
  }

  private renderBanner(progress: ContentProgress): void {
    const client = this.client;
    const banner = this.refs.banner;
    const scan = client.scan;
    let content: Child[] | null = null;
    if (scan.status === "error") {
      const retry = h("button", { type: "button", class: "pill secondary" }, "Retry");
      retry.addEventListener("click", () => client.retryScan());
      // Listing cursors are signed and expire, so a stale one needs a fresh scan rather than a retry.
      const refresh = h("button", { type: "button", class: "text-button" }, "Refresh");
      refresh.addEventListener("click", () => client.refresh());
      content = [`${scan.error ?? "Couldn't reach storage."} The documents found so far stay listed.`, retry, refresh];
    } else if (scan.status === "incomplete") {
      const refresh = h("button", { type: "button", class: "pill secondary" }, "Refresh");
      refresh.addEventListener("click", () => client.refresh());
      content = [`${scan.error ?? "The storage listing is incomplete."} Select all is disabled until a complete scan.`, refresh];
    } else if (client.search.status === "timeout" && client.filters.text) {
      content = ["Search stopped early (2-second limit). Results are incomplete — narrow the pattern or add filters. The content index is being rebuilt."];
    } else if (client.search.status === "unavailable" && client.filters.text) {
      content = [`Content search is unavailable: ${client.search.message ?? "the search worker stopped"}. Filters, sorting and deletion still work.`];
    } else if (progress.budgetExceeded && client.filters.text) {
      content = ["Content indexing stopped at this tab's 32 MB search budget. Search results are incomplete and Select all is disabled while searching."];
    }
    const key = content ? content.map((part) => typeof part === "string" ? part : "btn").join("|") : "";
    if (banner.dataset.key === key) return;
    banner.dataset.key = key;
    banner.hidden = !content;
    banner.classList.toggle("danger", scan.status === "error" || scan.status === "incomplete");
    replace(banner, content ?? []);
  }

  private renderResultsHead(matching: number, visible: number): void {
    const client = this.client;
    const refs = this.refs;
    const total = client.observed().length;
    const filtered = client.filters.text !== "" || client.filters.kinds.length > 0 || client.filters.age !== "any";
    let label: string;
    if (client.selectedOnly) label = `${plural(visible, "selected document")}`;
    else if (client.filters.text && client.search.hitsKey === null && client.search.status === "pending") label = "Searching…";
    else if (client.filters.text) {
      const matches = client.results().matching.reduce((sum, doc) => sum + (client.hitFor(doc)?.matchCount ?? 0), 0);
      label = `${plural(matching, "document")} · ${plural(matches, "match", "matches")}`;
    } else label = filtered ? `${matching.toLocaleString("en-US")} of ${plural(total, "document")}` : plural(total, "document");
    refs.resultsLabel.textContent = label;

    const gate = client.selectAllGate();
    const rendered = client.rendered().length;
    const older = OLDER_AGES.includes(client.filters.age) && !client.selectedOnly;
    const key = [label, filtered, client.selectedOnly, JSON.stringify(gate), rendered, older, client.filters.age].join("|");
    if (refs.selectGroup.dataset.key === key) return;
    refs.selectGroup.dataset.key = key;

    const extras: Child[] = [];
    if (client.selectedOnly) {
      const showAll = h("button", { type: "button", class: "chip", "aria-pressed": "true", "aria-label": "Stop showing selected only" }, "Selected only ×");
      showAll.addEventListener("click", () => client.setSelectedOnly(false));
      extras.push(showAll);
    } else if (filtered) {
      const clear = h("button", { type: "button", class: "text-button" }, "Clear filters");
      clear.addEventListener("click", () => {
        client.clearFilters();
        this.syncUrl(true);
        this.announceCountSoon();
      });
      extras.push(clear);
    }
    replace(refs.labelGroup, refs.resultsLabel, extras);

    const selectPage = h("button", { type: "button", class: "text-button", disabled: rendered === 0 }, `Select page (${rendered.toLocaleString("en-US")})`);
    selectPage.addEventListener("click", () => client.selectPage());
    const selectAll = h("button", {
      type: "button", class: "text-button", disabled: !gate.ok, "aria-describedby": gate.ok ? null : "select-all-reason",
    }, gate.ok ? `Select all ${gate.count.toLocaleString("en-US")} matching` : "Select all matching");
    selectAll.addEventListener("click", () => {
      if (client.selectAllMatching()) this.announce(`${plural(client.selectedIds().size, "document")} selected.`);
    });
    const reason = h("span", { class: "reason", id: "select-all-reason" }, gate.ok ? "" : gate.reason);
    const parts: Child[] = [selectPage, selectAll, reason];
    if (older) {
      const ageLabel = AGE_PRESETS.find((preset) => preset.value === client.filters.age)?.label.toLowerCase() ?? "";
      const cleanup = h("button", {
        type: "button", class: "pill secondary", disabled: !gate.ok, "aria-describedby": gate.ok ? null : "select-all-reason",
      }, gate.ok ? `Delete all ${gate.count.toLocaleString("en-US")} ${ageLabel}…` : `Delete all ${ageLabel}…`);
      cleanup.addEventListener("click", () => {
        if (client.selectAllMatching()) this.openReview(undefined, cleanup);
      });
      parts.push(cleanup);
    }
    replace(refs.selectGroup, parts);
  }

  private renderCoverage(progress: ContentProgress): void {
    const client = this.client;
    const coverage = this.refs.coverage;
    if (!client.filters.text) {
      coverage.hidden = true;
      return;
    }
    const parts: string[] = [];
    if (progress.complete) {
      const finished = progress.failed || progress.skipped ? "Indexing finished" : "Complete";
      parts.push(`${finished} · content searched in ${plural(progress.searched, "document")}`);
    } else {
      parts.push(`Content searched in ${progress.searched.toLocaleString("en-US")} of ${plural(progress.total, "document")}`);
    }
    if (progress.nameOnly) {
      const kinds = progress.nameOnlyKinds.map((kind) => KIND_LABEL[kind]).join(", ");
      parts.push(`${progress.nameOnly.toLocaleString("en-US")} by name only${kinds ? ` (${kinds})` : ""}`);
    }
    if (progress.truncated) parts.push(`${progress.truncated.toLocaleString("en-US")} searched partially`);
    if (progress.unreadable) parts.push(`${progress.unreadable.toLocaleString("en-US")} unreadable (searched by name)`);
    parts.push(`Titles and filenames searched in ${plural(progress.names, "document")}`);
    if (progress.metadataFailed) parts.push(`${progress.metadataFailed.toLocaleString("en-US")} names unavailable`);
    if (progress.failed) parts.push(`${progress.failed.toLocaleString("en-US")} content unavailable`);
    if (progress.skipped) parts.push(`${progress.skipped.toLocaleString("en-US")} content over the search budget`);
    if (!progress.complete) parts.push(client.scan.status === "running" ? "scanning…" : "indexing…");
    const text = parts.join(" · ");
    const key = `${text}|${progress.settled}|${progress.budgetExceeded}|${client.search.status}`;
    coverage.hidden = false;
    if (coverage.dataset.key === key) return;
    coverage.dataset.key = key;
    const children: Child[] = [h("span", null, text)];
    if (progress.failed && !progress.budgetExceeded && client.search.status !== "unavailable") {
      const retry = h("button", { type: "button", class: "text-button" }, "Retry");
      retry.addEventListener("click", () => client.retryContent());
      children.push(" ", retry);
    }
    if (!progress.complete) {
      children.push(h("progress", {
        max: Math.max(1, progress.total), value: progress.settled,
        "aria-label": `${progress.settled} of ${progress.total} documents indexed`,
      }));
    }
    replace(coverage, children);
  }

  private renderGrid(): void {
    const client = this.client;
    const rendered = client.rendered();
    const searching = !!client.filters.text;
    const key = [
      this.minute, searching, client.search.hitsKey,
      ...rendered.map((doc) => {
        // Content state settles asynchronously after the card first renders. The key carries the
        // exact coverage note the card shows, not just the status, so new coverage or reason text
        // from the extractor always rebuilds the card.
        const content = searching ? client.contentOf(doc.id) : null;
        const note = content ? `${content.status}:${JSON.stringify(coverageNote(content))}` : "";
        return `${doc.id}:${doc.version}:${client.isSelected(doc.id) ? 1 : 0}:${client.hitFor(doc)?.matchCount ?? ""}:${note}`;
      }),
    ].join("|");
    if (key === this.gridKey) return;
    this.gridKey = key;
    // Rebuilding drops focus; remember which control of which card had it and restore it.
    const active = document.activeElement as HTMLElement | null;
    const focusCard = active && this.refs.grid.contains(active) ? active.closest<HTMLElement>("[data-id]")?.dataset.id : undefined;
    const focusRole = active?.dataset.focus;
    const now = Date.now();
    // Cards are patched in place, not rebuilt: a selection toggle or the minute tick must not
    // reload every live preview frame on the page.
    const items = rendered.map((doc) => {
      let item = this.cardItems.get(doc.id);
      if (!item || item.dataset.version !== doc.version) {
        item = h("li", { "data-version": doc.version });
        this.cardItems.set(doc.id, item);
      }
      this.card(item, doc, now);
      return item;
    });
    const live = new Set(rendered.map((doc) => doc.id));
    for (const id of [...this.cardItems.keys()]) if (!live.has(id)) this.cardItems.delete(id);
    syncChildren(this.refs.grid, items);
    this.previews.retain(new Set(rendered.map(previewKey)));
    if (focusCard && focusRole) {
      const target = this.refs.grid.querySelector<HTMLElement>(`[data-id="${CSS.escape(focusCard)}"] [data-focus="${focusRole}"]`);
      target?.focus({ preventScroll: true });
    }
  }

  /**
   * Fills `item` with the card for `doc`. Everything is rebuilt except the preview node, which
   * CardPreviews caches per document version and syncChildren leaves in place. Cards without a
   * live preview (non-HTML, oversized, or previews off) are compact: the type is named once, in
   * the meta row, never repeated as a placeholder well.
   */
  private card(item: HTMLLIElement, doc: DocumentSummary, now: number): void {
    const client = this.client;
    const title = displayTitle(doc);
    const uploaded = Date.parse(doc.uploadedAt);
    const selected = client.isSelected(doc.id);
    const titleId = `doc-${doc.id}`;
    const publicUrl = externalUrl(doc.publicUrl);
    const rawUrl = externalUrl(doc.rawUrl);
    const full = formatDateTime(uploaded, client.timeZone);
    const preview = this.previews.slot(doc, title);

    const check = h("label", { class: "check" },
      h("input", { type: "checkbox", checked: selected, "data-action": "toggle", "data-focus": "check", "aria-label": `Select ${title}` }));
    const meta = h("div", { class: "meta" },
      h("span", { class: "kind" }, KIND_LABEL[doc.kind]),
      h("time", { datetime: doc.uploadedAt, title: `Uploaded ${full}` }, formatRelative(uploaded, now)));
    const body: Child[] = [
      h("h3", { id: titleId }, publicUrl
        ? h("a", { href: publicUrl, target: "_blank", rel: "noopener noreferrer", "data-focus": "title" }, title)
        : h("span", { tabindex: "0", "data-focus": "title" }, title)),
      h("p", { class: "file" }, h("span", { class: "name", title: doc.filename }, doc.filename), h("span", { class: "size" }, `· ${formatBytes(doc.sizeBytes)}`)),
      h("p", { class: "ident" }, h("span", { class: "mono" }, doc.id), " · ",
        h("time", { datetime: doc.uploadedAt, title: `Uploaded ${full}` }, formatDate(uploaded, client.timeZone))),
    ];
    if (doc.objectCount > 1) body.push(h("p", { class: "note" }, `${doc.objectCount} stored objects · deleting removes all`));
    for (const warning of doc.warnings) body.push(h("p", { class: "note" }, warning));
    if (client.filters.text) body.push(this.searchDetails(doc));

    const actions: Child[] = [];
    if (publicUrl) actions.push(h("button", { type: "button", class: "text-button", "data-action": "copy", "data-focus": "copy", "aria-label": `Copy link for ${title}` }, "Copy link"));
    if (rawUrl) actions.push(h("a", { href: rawUrl, target: "_blank", rel: "noopener noreferrer", "data-focus": "raw", "aria-label": `Raw ${title}` }, "Raw"));
    actions.push(h("button", { type: "button", class: "text-button", "data-action": "delete", "data-focus": "delete", "aria-label": `Delete ${title}…` }, "Delete"));

    let article = item.firstElementChild as HTMLElement | null;
    if (!article) article = item.appendChild(h("article"));
    article.className = selected ? "card selected" : "card";
    article.dataset.id = doc.id;
    article.setAttribute("aria-labelledby", titleId);
    if (preview) article.dataset.preview = "live";
    else delete article.dataset.preview;
    syncChildren(article, [check, meta, ...(preview ? [preview] : []), h("div", { class: "body" }, body), h("div", { class: "actions" }, actions)]);
  }

  /**
   * Match count, highlighted snippet and an honest coverage note. Partial, name-only and unreadable
   * cards add the extractor's own reason (capped, text node only) under a neutral label; see
   * coverage-note.ts. Full coverage and not-yet-indexed cards show no note.
   */
  private searchDetails(doc: DocumentSummary): Child[] {
    const hit = this.client.hitFor(doc);
    const note = coverageNote(this.client.contentOf(doc.id));
    const parts: Child[] = [];
    if (hit) {
      parts.push(h("p", { class: "matches" }, plural(hit.matchCount, "match", "matches")));
      if (hit.snippet) parts.push(h("p", { class: "snippet" }, snippet(hit)));
    }
    if (note) {
      parts.push(h("p", { class: "note", "data-coverage": "label" }, note.label));
      if (note.reason) parts.push(h("p", { class: "note", "data-coverage": "reason" }, note.reason));
    }
    return parts;
  }

  private renderMoreAndEmpty(visible: number, progress: ContentProgress): void {
    const client = this.client;
    const refs = this.refs;
    const remaining = visible - client.rendered().length;
    refs.more.hidden = remaining <= 0;
    const moreKey = String(remaining);
    if (remaining > 0 && refs.more.dataset.key !== moreKey) {
      refs.more.dataset.key = moreKey;
      const button = h("button", { type: "button", class: "pill secondary" },
        `Show ${Math.min(RENDER_STEP, remaining)} more · ${remaining.toLocaleString("en-US")} remaining`);
      button.addEventListener("click", () => {
        const first = client.rendered().length;
        client.showMore();
        this.render();
        this.focusCard(first);
      });
      replace(refs.more, button);
    }

    let empty: Child[] | null = null;
    const total = client.observed().length;
    const scanning = client.scan.status === "running";
    if (visible === 0) {
      const clear = h("button", { type: "button", class: "pill secondary" }, "Clear filters");
      clear.addEventListener("click", () => {
        client.clearFilters();
        this.syncUrl(true);
      });
      if (total === 0 && scanning) empty = [h("p", { class: "title" }, "Scanning storage…")];
      else if (total === 0 && client.scan.status === "complete") {
        empty = [h("p", { class: "title" }, "No documents yet."), h("p", { class: "mono" }, "docs upload <file>")];
      } else if (client.filters.text) {
        if (client.search.status === "pending" && !client.search.hits) empty = [h("p", { class: "title" }, "Searching…")];
        else if (client.search.status === "error" || client.search.status === "unavailable") {
          empty = [h("p", { class: "title" }, "The search couldn't run, so nothing is listed."),
            h("p", { class: "muted" }, "Change the pattern or clear the search to browse with filters."), clear];
        } else {
          empty = [h("p", { class: "title" }, `Nothing matches “${client.filters.text}”${progress.complete ? "." : " yet."}`)];
          if (progress.nameOnly) {
            empty.push(h("p", { class: "muted" }, `${plural(progress.nameOnly, "document was", "documents were")} searched by name only — PDFs, images, media and archives may have no extracted text.`));
          }
          if (!progress.complete) empty.push(h("p", { class: "muted" }, "Indexing is still running; more matches may appear."));
          empty.push(clear);
        }
      } else if (total > 0) empty = [h("p", { class: "title" }, "No documents match these filters."), clear];
    }
    const key = empty ? `${visible}|${total}|${scanning}|${client.filters.text}|${client.search.status}|${progress.complete}|${progress.nameOnly}` : "";
    refs.empty.hidden = !empty;
    if (refs.empty.dataset.key !== key) {
      refs.empty.dataset.key = key;
      replace(refs.empty, empty ?? []);
    }
  }

  private renderBar(hidden: number): void {
    const client = this.client;
    const bar = this.refs.bar;
    const selection = client.selection;
    bar.hidden = selection.scope === "none";
    const count = client.selectedIds().size;
    const key = `${selection.scope}|${count}|${selection.excluded.size}|${hidden}|${client.selectedOnly}|${selection.label}`;
    if (bar.dataset.key === key) return;
    bar.dataset.key = key;
    if (selection.scope === "none") return replace(bar);
    const scope = selection.scope === "matching"
      ? `matching ${selection.label ?? "the current filters"}`
      : "selected";
    const extras: string[] = [];
    if (selection.excluded.size) extras.push(`${selection.excluded.size.toLocaleString("en-US")} excluded`);
    if (hidden) extras.push(`${hidden.toLocaleString("en-US")} hidden by filters`);
    const clear = h("button", { type: "button", class: "text-button" }, "Clear");
    clear.addEventListener("click", () => client.clearSelection("Selection cleared."));
    const summaryChildren: Child[] = [
      h("span", { class: "count", "aria-live": "polite" }, count.toLocaleString("en-US")),
      h("span", { class: "scope" }, [scope, ...extras].join(" · ")),
    ];
    if (hidden && !client.selectedOnly) {
      const show = h("button", { type: "button", class: "text-button" }, "Show selected");
      show.addEventListener("click", () => client.setSelectedOnly(true));
      summaryChildren.push(show);
    }
    summaryChildren.push(clear);
    const review = h("button", { type: "button", class: "pill primary" }, "Review deletion");
    review.addEventListener("click", () => this.openReview(undefined, review));
    replace(bar, h("div", { class: "summary" }, summaryChildren), review);
  }

  // ---- Delete review dialog -----------------------------------------------------------------

  private renderReview(): void {
    const review = this.client.review;
    const dialog = this.refs.review;
    if (!review) {
      if (dialog.open) dialog.close();
      return;
    }
    const counts = tally(review);
    const key = `${review.phase}|${counts.processed}|${counts.deleted}|${review.stopRequested}|${review.items.length}`;
    if (key === this.reviewKey && dialog.open) return;
    this.reviewKey = key;
    const focusTarget = this.buildReview(review, counts);
    if (!dialog.open) dialog.showModal();
    focusTarget?.focus();
  }

  /** Rebuilds the dialog for the current phase and returns the control that should hold focus. */
  private buildReview(review: ReviewState, counts: ReturnType<typeof tally>): HTMLElement | null {
    const client = this.client;
    const dialog = this.refs.review;
    const total = review.items.length;
    const done = h("button", { type: "button", class: "pill secondary" }, "Done");
    done.addEventListener("click", () => dialog.close());
    const zone = client.timeZone;

    if (review.phase === "review") {
      const cancel = h("button", { type: "button", class: "pill secondary" }, "Cancel");
      cancel.addEventListener("click", () => dialog.close());
      const single = total === 1;
      const confirmLabel = single ? `Delete ${review.items[0].ref.id}` : `Delete ${total.toLocaleString("en-US")} documents`;
      const submit = h("button", { type: "button", class: "pill danger", disabled: !single }, confirmLabel);
      const input = h("input", {
        class: "field", id: "confirm-count", type: "text", inputmode: "numeric", autocomplete: "off", spellcheck: "false",
        "aria-describedby": "confirm-help",
      });
      input.addEventListener("input", () => {
        submit.disabled = !client.canConfirm(input.value);
      });
      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter" && client.canConfirm(input.value)) submit.click();
      });
      submit.addEventListener("click", () => {
        void client.confirmReview(single ? "" : input.value);
      });
      const copy = h("button", { type: "button", class: "text-button" }, "Copy IDs");
      copy.addEventListener("click", () => {
        navigator.clipboard.writeText(client.reviewIdsText()).then(() => {
          copy.textContent = `Copied ${plural(total, "ID")}`;
        }, () => this.announce("Couldn't copy the IDs"));
      });
      const cutoff = review.window ? describeWindow(review.window, zone) : null;
      replace(dialog,
        h("div", { class: "dialog-body" },
          h("h2", { id: "review-title" }, single ? "Delete 1 document?" : `Delete ${total.toLocaleString("en-US")} documents?`),
          h("p", { class: "lead", id: "review-summary" }, `${plural(total, "document")} · ${formatBytes(review.items.reduce((sum, item) => sum + item.summary.sizeBytes, 0))}`),
          cutoff ? h("p", { class: "muted" }, `${cutoff} (cutoff fixed)`) : null,
          review.label ? h("p", { class: "muted" }, `Selected by filter: ${review.label}`) : null,
          h("p", { class: "muted" }, "Their public links stop working. Copies already open in a tab or held in a browser cache can stay visible. This cannot be undone."),
          h("div", { class: "list-head" }, h("span", { id: "review-list-label" }, "Documents to delete"), copy),
          this.reviewList(review, false),
          single ? null : h("div", { class: "confirm" },
            h("label", { for: "confirm-count" }, `Type ${total} to confirm`),
            input,
            h("p", { class: "muted", id: "confirm-help" }, `Deletes run in batches of up to 100, oldest first.`)),
        ),
        h("div", { class: "dialog-foot" }, cancel, submit),
      );
      return cancel;
    }

    if (review.phase === "running") {
      const stop = h("button", { type: "button", class: "pill secondary", disabled: review.stopRequested },
        review.stopRequested ? "Stopping after this batch…" : "Stop after this batch");
      stop.addEventListener("click", () => client.stopReview());
      replace(dialog,
        h("div", { class: "dialog-body" },
          h("h2", { id: "review-title" }, "Deleting…"),
          h("p", { id: "review-summary", "aria-live": "polite" },
            `${counts.processed.toLocaleString("en-US")} of ${total.toLocaleString("en-US")} processed · ${counts.deleted.toLocaleString("en-US")} deleted`),
          h("progress", { max: total, value: counts.processed, "aria-label": `${counts.processed} of ${total} processed` }),
        ),
        h("div", { class: "dialog-foot" }, stop),
      );
      return stop;
    }

    let title: string;
    const lines: string[] = [];
    const foot: Child[] = [];
    switch (review.phase) {
      case "stopped":
        title = "Stopped";
        lines.push(`${plural(counts.deleted, "document")} deleted. ${plural(counts.unprocessed, "document")} not processed — they stay selected.`);
        foot.push(done);
        break;
      case "complete":
        title = `Deleted ${plural(counts.deleted, "document")}`;
        if (counts.missing) lines.push(`${plural(counts.missing, "was", "were")} already gone.`);
        if (counts.changed) lines.push(`${plural(counts.changed, "document")} changed after you reviewed ${counts.changed === 1 ? "it and was" : "them and were"} skipped; ${counts.changed === 1 ? "it stays" : "they stay"} selected.`);
        if (!counts.missing && !counts.changed) lines.push("Every reviewed document was deleted.");
        foot.push(done);
        break;
      case "partial": {
        title = `${counts.deleted.toLocaleString("en-US")} of ${plural(total, "document")} deleted`;
        lines.push("The documents below were not deleted and stay selected.");
        const retryable = counts.failed + counts.unprocessed;
        if (retryable) {
          const retry = h("button", { type: "button", class: "pill primary" },
            counts.unprocessed ? `Retry ${retryable.toLocaleString("en-US")} remaining` : `Retry ${retryable.toLocaleString("en-US")} failed`);
          retry.addEventListener("click", () => void client.retryReview());
          foot.push(retry);
        }
        foot.push(done);
        break;
      }
      default: // session-ended
        title = "Session ended";
        lines.push(`${plural(counts.deleted, "document")} deleted before the session ended. The other ${counts.unprocessed.toLocaleString("en-US")} were not touched. Signing in again starts over — this selection is lost.`);
        {
          const signIn = h("button", { type: "button", class: "pill primary" }, "Sign in");
          signIn.addEventListener("click", () => dialog.close());
          foot.push(signIn);
        }
    }
    const listed = review.items.filter((item) => {
      const outcome = review.outcomes.get(item.ref.id);
      return outcome !== "deleted" && (review.phase !== "complete" || outcome === "changed");
    });
    replace(dialog,
      h("div", { class: "dialog-body" },
        h("h2", { id: "review-title" }, title),
        h("p", { id: "review-summary" }, lines.join(" ")),
        listed.length ? [h("div", { class: "list-head" }, h("span", { id: "review-list-label" }, "Not deleted")), this.reviewList({ ...review, items: listed }, true)] : null,
      ),
      h("div", { class: "dialog-foot" }, foot),
    );
    return foot[0] as HTMLElement;
  }

  /** Every frozen ref as a two-line row (ID, name, size / type, MIME, upload time or outcome). */
  private reviewList(review: ReviewState, withOutcome: boolean): HTMLElement {
    const zone = this.client.timeZone;
    const outcomeText: Record<DeleteOutcome, string> = {
      deleted: "Deleted", "not-found": "Already gone", changed: "Skipped: changed after review",
      failed: "Failed", unprocessed: "Not processed",
    };
    return h("div", { class: "review-list", role: "region", tabindex: "0", "aria-labelledby": "review-list-label" },
      h("ol", { role: "list" }, review.items.map((item) => {
        const outcome = review.outcomes.get(item.ref.id) ?? "unprocessed";
        const reason = review.reasons.get(item.ref.id);
        const uploaded = Date.parse(item.summary.uploadedAt);
        const detail: Child[] = withOutcome
          ? [h("strong", null, outcomeText[outcome]), reason ? ` — ${reason}` : null]
          : [`${KIND_LABEL[item.summary.kind]}${item.summary.mime ? ` · ${item.summary.mime}` : ""} · Uploaded `,
            h("time", { datetime: item.summary.uploadedAt }, formatDateTime(uploaded, zone))];
        return h("li", null,
          h("span", { class: "mono id" }, item.ref.id),
          h("span", { class: "name" }, displayTitle(item.summary)),
          h("span", { class: "size" }, formatBytes(item.summary.sizeBytes)),
          h("span", { class: "detail" }, detail),
        );
      })),
    );
  }
}

function tally(review: ReviewState) {
  const counts = { processed: 0, deleted: 0, missing: 0, changed: 0, failed: 0, unprocessed: 0 };
  for (const outcome of review.outcomes.values()) {
    if (outcome !== "unprocessed") counts.processed++;
    if (outcome === "deleted") counts.deleted++;
    if (outcome === "not-found") counts.missing++;
    if (outcome === "changed") counts.changed++;
    if (outcome === "failed") counts.failed++;
    if (outcome === "unprocessed") counts.unprocessed++;
  }
  return counts;
}

/** Builds snippet text with <mark> around validated UTF-16 ranges; never parses markup. */
function snippet(hit: SearchHit): Child[] {
  const text = hit.snippet;
  const ranges = (Array.isArray(hit.ranges) ? hit.ranges : [])
    .filter((range) => Array.isArray(range) && Number.isInteger(range[0]) && Number.isInteger(range[1])
      && range[0] >= 0 && range[1] > range[0] && range[1] <= text.length)
    .sort((a, b) => a[0] - b[0]);
  const parts: Child[] = [];
  let position = 0;
  for (const [start, end] of ranges) {
    if (start < position) continue;
    parts.push(text.slice(position, start), h("mark", null, text.slice(start, end)));
    position = end;
  }
  parts.push(text.slice(position));
  return parts;
}
