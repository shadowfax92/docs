/**
 * Live card previews of uploaded HTML for the private catalog (catalog origin, /all-docs).
 *
 * Uploaded markup must never run with the catalog's session, so a preview is never fetched or
 * parsed here. Each eligible card instead holds a cross-origin <iframe> of the document's public
 * /ID/raw URL, locked down from both sides:
 *
 *   catalog document (session cookie, CSP frame-src = configured PUBLIC_DOCS_ORIGIN only)
 *     └─ div.preview  inert · aria-hidden            no focus, pointer or accessibility entry
 *          └─ iframe  sandbox="" · no-referrer      opaque origin: no scripts, storage, forms,
 *                                                   popups, downloads, top navigation or
 *                                                   meta refresh; sandbox flags reach nested frames
 *
 * The catalog CSP (catalog.ts) is the authoritative origin pin: the browser refuses a frame, or a
 * redirect, to any other origin. `previewSource` is the matching client-side allowlist, so a
 * malformed summary renders a compact card instead of a blocked frame. If the browser does block
 * a preview frame (a misconfigured deployment), every preview turns off for the tab and the
 * library falls back to compact cards.
 *
 * Tradeoff: a framed document still loads its own subresources and nested frames (fonts, images,
 * iframes, including third-party ones) from the viewer's browser, exactly as opening the document
 * would, but without scripts. Pages that build their content with JavaScript therefore preview
 * blank or partial; a preview is a static first-paint snapshot, not a faithful rendering.
 *
 * Cost is bounded here: frames attach only near the viewport, at most MAX_LOADING at a time, and
 * at most MAX_LIVE stay alive (least recently seen offscreen frames are dropped and re-attach on
 * return). Preview nodes are cached per document version, so callers must keep them attached
 * while a card is re-rendered: detaching an <iframe> discards its document and reloads it.
 */
import type { DocumentSummary } from "../contracts";

/** Larger sources keep a compact card: parsing cost grows with the HTML, not the thumbnail. */
export const PREVIEW_MAX_BYTES = 2 * 1024 * 1024;
/** Concurrent frame navigations; the rest wait their turn in card order. */
export const MAX_LOADING = 4;
/** Live frames kept per tab, roughly three desktop screens of cards. */
export const MAX_LIVE = 36;
/** A frame is revealed after its load event or this delay, whichever is first. The load event
 * waits for every subresource, so one stalled third-party image must not hide the page or hold a
 * loading slot forever. */
export const REVEAL_MS = 4_000;
/** Attach a little before a card scrolls into view. */
const ROOT_MARGIN = "400px 0px";

const UPLOAD_ID = /^[A-Za-z0-9]{8}$/;

/**
 * The exact public URL a card may frame, or null for a compact card. Only HTML documents within
 * the size cap qualify, and only their own raw route. Both URLs must be byte-for-byte what
 * Documents writes (`<origin>/<id>` and `<origin>/<id>/raw`): no query, fragment, credentials,
 * dot-segments or other aliases, http(s) only, and never the catalog origin. Which origin is
 * allowed at all is pinned by the catalog CSP; the raw route serves original bytes inline and
 * never redirects.
 */
export function previewSource(doc: DocumentSummary, catalogOrigin: string): string | null {
  if (doc.kind !== "html" || !/\.html?$/i.test(doc.filename) || !UPLOAD_ID.test(doc.id)) return null;
  if (!Number.isFinite(doc.sizeBytes) || doc.sizeBytes <= 0 || doc.sizeBytes > PREVIEW_MAX_BYTES) return null;
  let origin: string;
  try {
    const page = new URL(doc.publicUrl);
    if (page.protocol !== "https:" && page.protocol !== "http:") return null;
    origin = page.origin;
  } catch {
    return null;
  }
  if (origin === catalogOrigin || doc.publicUrl !== `${origin}/${doc.id}`) return null;
  const raw = `${origin}/${doc.id}/raw`;
  return doc.rawUrl === raw ? raw : null;
}

/** Cache key for one document version's preview node. */
export function previewKey(doc: DocumentSummary): string {
  return `${doc.id}:${doc.version}`;
}

type SlotState = "idle" | "loading" | "ready";

interface Slot {
  key: string;
  src: string;
  title: string;
  element: HTMLElement;
  frame: HTMLIFrameElement | null;
  state: SlotState;
  visible: boolean;
  lastSeen: number;
  reveal: ReturnType<typeof setTimeout> | null;
}

/**
 * Owns every preview node and frame lifecycle for the library view. `slot` hands out one stable
 * node per document version; `retain` drops the ones whose cards left the grid; `clear` tears all
 * frames down on lock. Attachment, eviction and reveal happen inside, driven by visibility.
 */
export class CardPreviews {
  private readonly slots = new Map<string, Slot>();
  private readonly byElement = new WeakMap<Element, Slot>();
  private readonly observer: IntersectionObserver;
  private loading = 0;
  private disabled = false;
  private clock = 0;

  /** `onDisabled` runs once if the browser refuses a preview frame; callers re-render compact. */
  constructor(private readonly onDisabled: () => void) {
    this.observer = new IntersectionObserver((entries) => this.onIntersect(entries), { rootMargin: ROOT_MARGIN });
    // A frame-src refusal reaches the embedding document as a CSP violation event. Matching the
    // blocked URL keeps unrelated violations from switching previews off.
    document.addEventListener("securitypolicyviolation", (event) => {
      if (this.disabled || event.effectiveDirective !== "frame-src") return;
      // Browsers report the full URL, or only the origin after a cross-origin redirect.
      const blocked = event.blockedURI;
      const ours = [...this.slots.values()].some((slot) => {
        const origin = new URL(slot.src).origin;
        return blocked === origin || blocked.startsWith(`${origin}/`);
      });
      if (ours) this.disable();
    });
  }

  /** The preview node for this document version, or null when it gets a compact card. */
  slot(doc: DocumentSummary, title: string): HTMLElement | null {
    if (this.disabled) return null;
    const src = previewSource(doc, location.origin);
    if (!src) return null;
    const key = previewKey(doc);
    const existing = this.slots.get(key);
    if (existing) return existing.element;
    const element = document.createElement("div");
    element.className = "preview";
    element.dataset.state = "idle";
    element.dataset.part = "preview";
    // inert removes the frame and everything inside it from focus, pointer and accessibility
    // trees; the card's title link (stretched over the card) stays the only way in.
    element.inert = true;
    element.setAttribute("aria-hidden", "true");
    const slot: Slot = { key, src, title, element, frame: null, state: "idle", visible: false, lastSeen: 0, reveal: null };
    this.slots.set(key, slot);
    this.byElement.set(element, slot);
    this.observer.observe(element);
    return element;
  }

  /** Drops every preview whose key is not in `keys` (its card left the rendered grid). */
  retain(keys: ReadonlySet<string>): void {
    for (const slot of [...this.slots.values()]) if (!keys.has(slot.key)) this.drop(slot);
    this.pump();
  }

  clear(): void {
    this.retain(new Set());
  }

  private disable(): void {
    this.disabled = true;
    this.clear();
    this.onDisabled();
  }

  private drop(slot: Slot): void {
    this.observer.unobserve(slot.element);
    this.detach(slot);
    this.slots.delete(slot.key);
  }

  private onIntersect(entries: IntersectionObserverEntry[]): void {
    const now = ++this.clock;
    for (const entry of entries) {
      const slot = this.byElement.get(entry.target);
      if (!slot || this.slots.get(slot.key) !== slot) continue;
      slot.visible = entry.isIntersecting;
      slot.lastSeen = now;
    }
    this.pump();
  }

  /** Attaches waiting visible frames in card order, within the loading and live budgets. */
  private pump(): void {
    if (this.disabled) return;
    const live = [...this.slots.values()].filter((slot) => slot.frame);
    for (const slot of this.ordered()) {
      if (this.loading >= MAX_LOADING) return;
      if (!slot.visible || slot.frame) continue;
      if (live.length >= MAX_LIVE) {
        // Evict the least recently seen offscreen frame; if every live frame is on screen, wait.
        const victim = live.filter((other) => !other.visible).sort((a, b) => a.lastSeen - b.lastSeen)[0];
        if (!victim) return;
        this.detach(victim);
        live.splice(live.indexOf(victim), 1);
      }
      this.attach(slot);
      live.push(slot);
    }
  }

  /** Visible slots in document order, so the top of the screen fills first. */
  private ordered(): Slot[] {
    return [...this.slots.values()].filter((slot) => slot.visible && slot.element.isConnected).sort((a, b) =>
      a.element.compareDocumentPosition(b.element) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1);
  }

  private attach(slot: Slot): void {
    const frame = document.createElement("iframe");
    // Order matters: sandbox and referrer policy must be in place before the frame navigates,
    // which happens when it is inserted with a src. An empty sandbox grants nothing.
    frame.setAttribute("sandbox", "");
    frame.setAttribute("referrerpolicy", "no-referrer");
    frame.setAttribute("tabindex", "-1");
    frame.setAttribute("aria-hidden", "true");
    frame.setAttribute("title", `Preview of ${slot.title}`);
    frame.src = slot.src;
    slot.frame = frame;
    slot.state = "loading";
    slot.element.dataset.state = "loading";
    this.loading++;
    const settle = () => {
      if (slot.frame !== frame || slot.state !== "loading") return;
      if (slot.reveal) clearTimeout(slot.reveal);
      slot.reveal = null;
      slot.state = "ready";
      slot.element.dataset.state = "ready";
      this.loading--;
      this.pump();
    };
    frame.addEventListener("load", settle, { once: true });
    slot.reveal = setTimeout(settle, REVEAL_MS);
    slot.element.appendChild(frame);
  }

  private detach(slot: Slot): void {
    if (slot.reveal) clearTimeout(slot.reveal);
    slot.reveal = null;
    if (slot.state === "loading") this.loading--;
    // Removing the element discards the framed document and cancels any pending navigation.
    slot.frame?.remove();
    slot.frame = null;
    slot.state = "idle";
    slot.element.dataset.state = "idle";
  }
}
