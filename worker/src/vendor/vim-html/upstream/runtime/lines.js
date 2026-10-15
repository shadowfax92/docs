/* lines.js -- the line model, the line-number gutter and heading folds (piece C1).
 *
 * A line is one gutter number, 1-based, in document order: the innermost
 * h1-h6, p, li, dt, dd, blockquote, figcaption, caption or tr; a .stat, whole;
 * a figure with no text or an img standing alone; and each source line of a
 * pre. Every other module speaks in these numbers (cursor, marks, search hits,
 * comment anchors), so discovery must be deterministic for a given document.
 *
 * Contract (PLAN.md "Line model and folding"); (+) marks additive helpers:
 *   VH.lines.count() / el(n) / of(node) -> n (0 when node is in no line)
 *   VH.lines.text(n)            the line's text as read (see "line text model"),
 *                               whitespace-normalised: cells joined by " | ",
 *                               without nested lines' text
 *   VH.lines.model(n) (+)       that text with its DOM offset maps and search segments
 *   VH.lines.rect(n)            the line's own box, a DOMRect in viewport coordinates:
 *                               a holder stops at its first nested line; zero while folded
 *   VH.lines.visible()          [first, last] on screen, skipping folded lines
 *   VH.lines.headingPath(n)     'Title › Section › Subsection' (every enclosing heading)
 *   VH.lines.sectionPath(n) (+) headingPath without an h1 the document title names
 *   VH.lines.headings()         [{line, level, text}]; heading text skips .tag badges
 *   VH.lines.hidden(n)          inside a closed fold (a closed fold's heading is not)
 *   VH.lines.next(n, step)      the visible line `step` visible lines away (signed),
 *                               clamped to the first/last visible line; a closed
 *                               fold counts as one line, so next(cur, 5) lands on
 *                               the line whose relative number reads 5. For a
 *                               hidden n: next(n, 0) and next(n, -1) are the
 *                               heading of the fold hiding it, next(n, 1) the
 *                               first visible line after that fold
 *   VH.lines.refresh() (+)      rediscover after the document changes
 *   VH.folds.toggle(n) / open(n) / close(n)   za / zo / zc at line n; each returns
 *                               the heading line of the fold it changed, or 0
 *   VH.folds.openAll() / closeAll() / more(count) / less(count)   zR zM zm zr
 *   VH.folds.reveal(n)          open every fold hiding n; true when one opened
 *   VH.folds.list() (+)         [{line, end, level, depth, closed}]
 *   VH.folds.at(n) (+)          innermost fold containing n, as in list(), or null
 *   VH.gutter (+)               {numbers(), relative(), toggleNumbers(), toggleRelative()}
 *   emits 'layout' {} after line geometry is recomputed, 'folds' {} after any
 *   fold change (DOM, gutter and cursor already updated).
 *
 * Data flow:
 *   refresh   split pres -> discover -> headings + fold ranges -> visibility
 *             -> hide folded DOM -> gutter rows -> layout -> paint
 *   'cursor' 'mode' focus/blur  -> paintNumbers()   attribute writes, rows near the view
 *   scroll                      -> paintBand()      tops up relative numbers coming into view
 *   'comments' 'marks'          -> paintSigns()
 *   resize, fonts, images       -> layout() on the next frame, then 'layout'
 *   fold change                 -> visibility -> DOM -> scroll kept -> layout
 *                                  -> cursor moved off hidden lines -> 'folds'
 *
 * Pre lines: each pre's text is rebuilt as inline-block <span class="vh-pl">
 * per source line with the original "\n" text nodes between them, so the pre's
 * textContent (what comment anchors index into) is byte-identical and it renders
 * the same. Highlighting markup survives: an element that spans a newline is
 * shallow-cloned onto each line it touches. A pre holding anything other than
 * plain phrasing elements (br, img, svg, inputs, ids that cloning would
 * duplicate) is left untouched and counts as one line.
 *
 * The gutter lives in VH.ui.layer: one absolutely positioned row per line, in
 * document coordinates, so it scrolls with the page and is only repositioned
 * when layout changes. Rows sit beside the text column, never in it; the room
 * comes from doc.css (or html.vh-gutter-room on pages without it). A row's text
 * is always its absolute number; relative numbers are drawn from data-rel by
 * CSS, which lets insert mode and window blur switch every row with one class.
 */

var LINE_SEL = 'h1,h2,h3,h4,h5,h6,p,li,dt,dd,blockquote,figcaption,caption,tr,.stat';
var INNER_SEL = LINE_SEL + ',pre,.vh-pl';   // candidates that make an ancestor not innermost
var CAND_SEL = INNER_SEL + ',figure,img';
var LONE_SEL = LINE_SEL + ',pre,figure';    // an img or figure inside one of these is not lone
var NEVER = '[data-vh-ui],.no-vim,nav,script,style';
// Elements a pre may contain and still be split: inline formatting only.
var PHRASING = /^(SPAN|A|B|I|EM|STRONG|CODE|MARK|S|U|SUB|SUP|SMALL|VAR|SAMP|KBD|Q|ABBR|DEL|INS|FONT|DATA|TIME|CITE|DFN|BDI|BDO)$/;
var STATUS_H = 28;  // chrome.js's status line covers the bottom of the viewport

var root = null;          // main, article, else body
var list = [];            // line elements; list[n - 1] is line n
var index = new Map();    // element -> n
var nested = new Uint8Array(1);   // nested[n]: line n holds other lines (an li with a sublist)
var heads = [];           // headings in order: {line, level, text, end, depth, parent, closed, key}
var maxDepth = 0;         // deepest fold nesting
var level = null;         // 'foldlevel' once zM/zR/zm/zr ran; null = never set (all open)

// Visibility, recomputed on every fold change. rep[n] is n for a visible line,
// else the heading of the outermost closed fold hiding it; vidx[n] is rep[n]'s
// position in `shown` (the visible lines, in order).
var rep = new Int32Array(1);
var vidx = new Int32Array(1);
var shown = [];
var outer = [];           // closed folds not inside another closed fold
var foldedEls = [];       // author elements carrying .vh-folded
var trailers = [];        // headings carrying data-vh-fold

var gutter = null;
var rows = [];            // rows[n - 1] is line n's gutter row
var relVal = new Int32Array(1);   // last data-rel written per line (-1 none)
var geo = null;           // last written {top, height, pad, dx} per row, to skip no-op writes
var curRow = 0;           // line whose row carries .vh-ln-cur
var numbersOn = true;     // <leader>ul
var relativeOn = true;    // <leader>uL
var focused = true;       // window focus (numbertoggle: FocusLost -> absolute)
var room = false;         // html.vh-gutter-room was added
var raf = 0;
var layerY = 0;           // the layer's document y at the last layout (geo.top is relative to it)
var metrics = {};         // font key -> {lh, k}: line-height 'normal' and baseline offset
var booted = false;

function rowsOf(n) { return rows[n - 1]; }

function cursorLine() {
  var c = VH.cursor && VH.cursor.get ? VH.cursor.get() : 0;
  return c >= 1 && c <= list.length ? c : 0;
}

/* --------------------------------------------------------------- pre lines */

function splitPres() {
  Array.prototype.forEach.call(root.querySelectorAll('pre'), function (pre) {
    if (pre.hasAttribute('data-vh-pre') || pre.closest(NEVER)) return;
    var box = textBox(pre);
    pre.setAttribute('data-vh-pre', box && splitInto(box) ? 'lines' : 'whole');
  });
}

// The element whose children hold the pre's text: the pre, or the lone <code>
// inside it (splitting there keeps `pre > code` styles matching). Null when a
// descendant is not plain phrasing, since cloning it per line could change
// what the pre shows or does.
function textBox(pre) {
  if (pre.isContentEditable) return null;
  var box = pre;
  for (;;) {
    var only = null, extra = false;
    for (var c = box.firstChild; c && !extra; c = c.nextSibling) {
      if (c.nodeType === 1) { if (only) extra = true; else only = c; }
      else if (c.nodeType === 3 && /\S/.test(c.data)) extra = true;
    }
    if (!only || extra || !PHRASING.test(only.tagName)) break;
    box = only;
  }
  var els = box.getElementsByTagName('*');
  for (var i = 0; i < els.length; i++) {
    if (!PHRASING.test(els[i].tagName) || els[i].id) return null;
  }
  return box;
}

// One pass over box: text is cut at each "\n"; every element open at a cut is
// shallow-cloned again at the start of the next line, so a highlight span that
// covers three source lines becomes three spans with the same class.
function splitInto(box) {
  var text = box.textContent;
  var frag = document.createDocumentFragment();
  var stack = [];  // original elements open at this point, outermost first
  var target = null;
  function line() {
    if (frag.lastChild) frag.appendChild(document.createTextNode('\n'));
    target = frag.appendChild(document.createElement('span'));
    target.className = 'vh-pl';
    stack.forEach(function (orig) { target = target.appendChild(orig.cloneNode(false)); });
  }
  function walk(node) {
    for (var c = node.firstChild; c; c = c.nextSibling) {
      if (c.nodeType === 3) {
        var parts = c.data.split('\n');
        for (var i = 0; i < parts.length; i++) {
          if (i) line();
          if (parts[i]) target.appendChild(document.createTextNode(parts[i]));
        }
      } else if (c.nodeType === 1) {
        stack.push(c);
        target = target.appendChild(c.cloneNode(false));
        walk(c);
        stack.pop();
        target = target.parentNode;
      }
    }
  }
  line();
  walk(box);
  // A final "\n" renders no line of its own: keep the character, drop its span.
  var last = frag.lastChild;
  if (/\n$/.test(text) && last && last.previousSibling && !last.textContent) frag.removeChild(last);
  if (frag.textContent !== text) return false;  // never change what anchors index into
  box.textContent = '';
  box.appendChild(frag);
  return true;
}

/* ---------------------------------------------------------------- discovery */

function hasOwnText(el) {
  for (var c = el.firstChild; c; c = c.nextSibling) {
    if (c.nodeType === 3 && /\S/.test(c.data)) return true;
  }
  return false;
}

// Closed <details> content may still report boxes (content-visibility), so it
// is excluded by structure; the summary stays a candidate.
function rendered(el) {
  if (!el.getClientRects().length) return false;
  var d = el.closest('details:not([open])');
  if (d) {
    var s = el.closest('summary');
    if (!s || s.parentElement !== d) return false;
  }
  return true;
}

function discover() {
  root = document.querySelector('main, article') || document.body;
  splitPres();
  var found = [];
  var cands = root.querySelectorAll(CAND_SEL);
  for (var i = 0; i < cands.length; i++) {
    var el = cands[i];
    var tag = el.tagName;
    if (el.closest(NEVER) || !rendered(el)) continue;
    // A .stat (doc.css: figure + label) is one line, whole: nothing inside it
    // is a line of its own, whatever markup the figure uses.
    if (el.parentElement && el.parentElement.closest('.stat')) continue;
    if (el.classList.contains('stat')) {
      found.push(el);
      continue;
    }
    if (tag === 'PRE') {
      if (el.getAttribute('data-vh-pre') === 'lines') continue;  // its .vh-pl spans are the lines
    } else if (tag === 'IMG') {
      if (el.parentElement && el.parentElement.closest(LONE_SEL)) continue;
    } else if (tag === 'FIGURE') {
      if (VH.text.norm(el.textContent) || el.querySelector(INNER_SEL) ||
          (el.parentElement && el.parentElement.closest(LONE_SEL))) continue;
    } else if (!el.classList.contains('vh-pl') && el.querySelector(INNER_SEL) && !hasOwnText(el)) {
      // Innermost rule: a holder of other lines is a line only with text of its
      // own (an li with a nested list keeps its number; a blockquote of p's does not).
      continue;
    }
    found.push(el);
  }
  list = found;
  index = new Map();
  nested = new Uint8Array(list.length + 1);
  list.forEach(function (el, i) { index.set(el, i + 1); });
  // A line holds others when one of them has it as its nearest line ancestor.
  list.forEach(function (el) {
    for (var x = el.parentElement; x && x !== root; x = x.parentElement) {
      var p = index.get(x);
      if (p) { nested[p] = 1; break; }
    }
  });
}

/* ------------------------------------------------------- headings and folds
 * A heading's fold runs to the line before the next heading of the same or a
 * higher level (smaller number), or to the last line. A heading with nothing
 * under it has no fold. depth is the fold's nesting (1 = outermost), which is
 * what 'foldlevel' compares against, so a document that skips heading levels
 * still folds one step at a time with zm/zr.
 */

function buildHeads() {
  heads = [];
  maxDepth = 0;
  var stack = [], seen = {};
  list.forEach(function (el, i) {
    var m = /^H([1-6])$/.exec(el.tagName);
    if (!m) return;
    var lv = +m[1], line = i + 1;
    while (stack.length && stack[stack.length - 1].level >= lv) stack.pop().end = line - 1;
    var text = headingText(el);
    var id = lv + '|' + text;
    seen[id] = (seen[id] || 0) + 1;
    var h = { line: line, level: lv, text: text, end: list.length, depth: stack.length + 1,
              parent: stack[stack.length - 1] || null, closed: false, key: id + '|' + seen[id] };
    heads.push(h);
    stack.push(h);
  });
  heads.forEach(function (h) { if (h.end > h.line && h.depth > maxDepth) maxDepth = h.depth; });
}

function isFold(h) { return h.end > h.line; }

// A heading's name in crumbs, the outline, pickers and fold keys: its text
// without doc.css's .tag badges ("Rollout <span class=tag>draft</span>" is
// "Rollout") and without anything of ours. A heading that is only badges keeps
// its full text rather than becoming nameless.
var NOT_NAME = '.tag,[data-vh-ui]';

function headingText(el) {
  var out = '';
  var w = document.createTreeWalker(el, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode: function (n) {
      return n.nodeType === 1 && n !== el && n.matches(NOT_NAME) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
    }
  });
  for (var n = w.nextNode(); n; n = w.nextNode()) if (n.nodeType === 3) out += n.data;
  return VH.text.norm(out) || VH.text.norm(el.textContent);
}

// Whether a heading's text is what the document title already says: equal to
// it, or a word-bounded part of it (<title>Brief: Arnab Das</title> over
// <h1>Arnab Das</h1>). Case-insensitive.
function namesTitle(text) {
  var t = VH.text.norm(VH.cfg.docTitle).toLowerCase();
  var x = String(text || '').toLowerCase();
  if (!x || !t) return false;
  for (var i = t.indexOf(x); i >= 0; i = t.indexOf(x, i + 1)) {
    if (!/\w/.test(t.charAt(i - 1)) && !/\w/.test(t.charAt(i + x.length))) return true;
  }
  return false;
}

// The innermost heading whose range holds line n (a heading holds its own line).
function innermost(n) {
  var lo = 0, hi = heads.length - 1, h = null;
  while (lo <= hi) {
    var mid = (lo + hi) >> 1;
    if (heads[mid].line <= n) { h = heads[mid]; lo = mid + 1; } else hi = mid - 1;
  }
  while (h && h.end < n) h = h.parent;
  return h;
}

// Folds holding line n, innermost first.
function foldsAt(n) {
  var out = [];
  for (var h = innermost(n); h; h = h.parent) if (isFold(h)) out.push(h);
  return out;
}

function computeVisibility() {
  var n = list.length;
  rep = new Int32Array(n + 1);
  vidx = new Int32Array(n + 1);
  shown = [];
  outer = [];
  var reach = 0;
  heads.forEach(function (h) {
    if (h.closed && isFold(h) && h.line > reach) { outer.push(h); reach = h.end; }
  });
  for (var line = 1, j = 0; line <= n; line++) {
    while (j < outer.length && outer[j].end < line) j++;
    var f = outer[j];
    if (f && line > f.line && line <= f.end) {
      rep[line] = f.line;
      vidx[line] = vidx[f.line];
    } else {
      rep[line] = line;
      vidx[line] = shown.length;
      shown.push(line);
    }
  }
}

// Maximal subtrees after heading `a` and before boundary `b` (null: to the end
// of root). Climbing out of a's parents and descending into b's ancestors lets
// a fold cross <section> or <div> wrappers without hiding the next heading.
function between(a, b) {
  var out = [], n = a;
  for (;;) {
    while (n && n !== root && !n.nextSibling) n = n.parentNode;
    if (!n || n === root) return out;
    n = n.nextSibling;
    while (b && n !== b && n.contains(b)) n = n.firstChild;
    if (n === b) return out;
    if (n.nodeType === 1 && !n.hasAttribute('data-vh-ui')) out.push(n);
  }
}

function unfoldDom() {
  foldedEls.forEach(function (el) { el.classList.remove('vh-folded'); });
  trailers.forEach(function (el) { el.removeAttribute('data-vh-fold'); });
  foldedEls = [];
  trailers = [];
}

// Only outermost closed folds touch the DOM; nested state is just remembered.
function foldDom() {
  unfoldDom();
  outer.forEach(function (f) {
    var head = list[f.line - 1];
    between(head, f.end < list.length ? list[f.end] : null).forEach(function (el) {
      el.classList.add('vh-folded');
      foldedEls.push(el);
    });
    var n = f.end - f.line;
    head.setAttribute('data-vh-fold', '··· ' + n + (n === 1 ? ' line' : ' lines'));
    trailers.push(head);
  });
}

/* ------------------------------------------------------------- persistence
 * VH.store 'folds' = {closed: [heading keys], level}. A key is level|text|nth
 * occurrence, so state survives rebuilds that shift line numbers and quietly
 * drops headings that no longer exist.
 */

function closedKeys() {
  return heads.filter(function (h) { return h.closed && isFold(h); }).map(function (h) { return h.key; });
}

function applyKeys(keys) {
  var set = {};
  (keys || []).forEach(function (k) { set[k] = true; });
  heads.forEach(function (h) { h.closed = isFold(h) && !!set[h.key]; });
}

function save() {
  var closed = closedKeys();
  if (!closed.length && level === null) VH.store.del('folds');
  else VH.store.set('folds', { closed: closed, level: level });
}

function load() {
  var s = VH.store.get('folds');
  if (!s || typeof s !== 'object') return [];
  level = typeof s.level === 'number' ? s.level : null;
  return Array.isArray(s.closed) ? s.closed : [];
}

/* ------------------------------------------------------------ fold changes */

// The cursor never rests on a hidden line (every other module reads, comments
// and yanks "the cursor line"), so a fold that swallows it moves it to the
// fold's heading. vim instead keeps the cursor inside the fold, which is what
// makes zM zR a round trip; `swallowed` gives the same feel: while the cursor
// has not moved since, the line it came from is where it returns once visible.
var swallowed = null;  // {line: where the cursor was, at: the stand-in it sits on}

function onCursor(e) {
  if (swallowed && e.line !== swallowed.at) swallowed = null;
  paintNumbers();
}

function isOnScreen(r) {
  return (r.width || r.height) && r.bottom > 0 && r.top < window.innerHeight - STATUS_H;
}

// Apply the heads' closed flags: DOM, scroll, gutter, cursor, store, event.
// The line the cursor ends on stays where it was on screen, or takes the old
// cursor line's place when it was not on screen (a heading far above, a line
// coming back out of a fold): folding never throws the reader elsewhere.
function commit() {
  if (!booted) return;
  var cur = cursorLine();
  var want = swallowed && cur === swallowed.at ? swallowed.line : cur;
  if (!want) want = VH.lines.visible()[0];
  computeVisibility();
  var target = want ? rep[want] : 0;
  var el = target ? list[target - 1] : null;
  var r0 = el && el.getBoundingClientRect();
  var y0 = r0 && isOnScreen(r0) ? r0.top : null;
  if (y0 === null && cur && list[cur - 1]) {
    var rc = list[cur - 1].getBoundingClientRect();
    if (rc.width || rc.height) y0 = rc.top;
  }
  foldDom();
  if (el && y0 !== null) {
    var dy = el.getBoundingClientRect().top - y0;
    if (Math.abs(dy) > 0.5) window.scrollBy({ top: dy, left: 0, behavior: 'instant' });
  }
  layout();
  paintSigns();
  if (cur) {
    swallowed = target !== want ? { line: want, at: target } : null;
    if (target !== cur) VH.cursor.set(target);
  }
  paintNumbers();
  save();
  VH.emit('folds', {});
}

function setLevel(lv) {
  level = Math.max(0, Math.min(lv, maxDepth));
  heads.forEach(function (h) { h.closed = isFold(h) && h.depth > level; });
  commit();
}

function currentLevel() {
  return level === null ? maxDepth : Math.min(level, maxDepth);
}

function view(h) {
  return h ? { line: h.line, end: h.end, level: h.level, depth: h.depth, closed: h.closed } : null;
}

VH.folds = {
  // zc: close the innermost open fold holding n (on a closed one, its parent).
  close: function (n) {
    var f = foldsAt(n).filter(function (x) { return !x.closed; })[0];
    if (!f) return 0;
    f.closed = true;
    commit();
    return f.line;
  },
  // zo: open the innermost closed fold holding n.
  open: function (n) {
    var f = foldsAt(n).filter(function (x) { return x.closed; })[0];
    if (!f) return 0;
    f.closed = false;
    commit();
    return f.line;
  },
  // za: open when n is on a closed fold, else close.
  toggle: function (n) {
    return foldsAt(n).some(function (x) { return x.closed; }) ? VH.folds.open(n) : VH.folds.close(n);
  },
  openAll: function () { setLevel(maxDepth); },
  closeAll: function () { setLevel(0); },
  more: function (count) { setLevel(currentLevel() - (count || 1)); },
  less: function (count) { setLevel(currentLevel() + (count || 1)); },
  // Only folds that hide n: a closed fold whose heading is n leaves n in view.
  reveal: function (n) {
    var hit = foldsAt(n).filter(function (x) { return x.closed && x.line < n; });
    if (!hit.length) return false;
    hit.forEach(function (x) { x.closed = false; });
    commit();
    return true;
  },
  list: function () { return heads.filter(isFold).map(view); },
  at: function (n) { return view(foldsAt(n)[0] || null); },
  level: function () { return currentLevel(); }
};

/* ------------------------------------------------------------------ gutter */

function renderRows() {
  if (rows.length !== list.length) {
    gutter.textContent = '';
    rows = list.map(function (el, i) {
      var row = VH.ui.h('div', { 'class': 'vh-ln' }, [VH.ui.h('span', { 'class': 'vh-n', text: String(i + 1) })]);
      gutter.appendChild(row);
      return row;
    });
  }
  relVal = new Int32Array(list.length + 1).fill(-1);
  geo = { top: new Float64Array(list.length), height: new Float64Array(list.length), pad: new Float64Array(list.length),
          dx: new Float64Array(list.length) };
  geo.top.fill(NaN);
  curRow = 0;
  rows.forEach(function (row) {
    row.classList.remove('vh-ln-cur');
    row.removeAttribute('data-rel');
    row.classList.remove('vh-ln-fold');
  });
  heads.forEach(function (h) { if (isFold(h)) rows[h.line - 1].classList.add('vh-ln-fold'); });
}

// Font metrics, measured once per face: lh is the 'normal' line height and k
// the baseline's offset from the middle of a line box. A line box of height L
// has its baseline at L / 2 + k, which is how a 12px gutter number is set on
// the same baseline as a 17px paragraph or a 52px heading.
function fontKey(cs) {
  return cs.fontStyle + '|' + cs.fontWeight + '|' + cs.fontSize + '|' + cs.fontFamily;
}

function measureFonts(styles) {
  var probes = [];
  styles.forEach(function (cs) {
    var p = VH.ui.h('div', { 'class': 'vh-metric' }, ['Hxg', VH.ui.h('span')]);
    p.style.fontStyle = cs.fontStyle;
    p.style.fontWeight = cs.fontWeight;
    p.style.fontSize = cs.fontSize;
    p.style.fontFamily = cs.fontFamily;
    VH.ui.layer.appendChild(p);
    probes.push(p);
  });
  probes.forEach(function (p, i) {
    var lh = p.offsetHeight;
    metrics[fontKey(styles[i])] = { lh: lh, k: p.lastChild.offsetTop - lh / 2 };
  });
  probes.forEach(function (p) { p.remove(); });
}

function lineHeight(cs, m) {
  var lh = parseFloat(cs.lineHeight);
  return isNaN(lh) ? m.lh : lh;
}

function gutterWidth() {
  var probe = VH.ui.h('div', { 'class': 'vh-gutter-probe' });
  VH.ui.layer.appendChild(probe);
  var w = probe.getBoundingClientRect().width || 48;
  probe.remove();
  return w;
}

// Reads everything first, then writes only what changed: a full pass costs
// one forced document layout no matter how many lines there are.
function layout() {
  cancelAnimationFrame(raf);
  raf = 0;
  if (!gutter) return;
  var n = list.length;
  var gw = gutterWidth();
  var boxes = new Array(n), styles = new Array(n), xs = new Array(n), need = [], needKeys = {};
  var left = Infinity;
  for (var i = 0; i < n; i++) {
    if (rep[i + 1] !== i + 1) continue;
    var el = list[i];
    var box = el.tagName === 'TR' && el.cells.length ? el.cells[0] : el;
    var cs = getComputedStyle(box);
    var r = box.getBoundingClientRect();
    var lr = box === el ? r : el.getBoundingClientRect();
    if (lr.width || lr.height) left = Math.min(left, lr.left);
    xs[i] = { left: lr.left, right: lr.right };
    boxes[i] = {
      top: r.top + parseFloat(cs.paddingTop) + parseFloat(cs.borderTopWidth),
      bottom: lr.bottom - (box === el ? parseFloat(cs.paddingBottom) + parseFloat(cs.borderBottomWidth) : 0)
    };
    styles[i] = cs;
    var key = fontKey(cs);
    if (!metrics[key] && !needKeys[key]) { needKeys[key] = true; need.push(cs); }
  }
  if (left === Infinity) left = gw;
  // A page that leaves no room for the gutter (--theme none, browser-default
  // body margin) gets a left margin once; the text column moves before the
  // first paint, never afterwards.
  if (left < gw && !room) {
    room = true;
    document.documentElement.classList.add('vh-gutter-room');
    return layout();
  }
  var numCs = rows.length ? getComputedStyle(rows[0]) : null;
  if (numCs && !metrics[fontKey(numCs)] && !needKeys[fontKey(numCs)]) need.push(numCs);
  if (need.length) measureFonts(need);
  var o = VH.ui.origin();
  layerY = o.top + window.scrollY;
  gutter.style.left = (left - gw - o.left) + 'px';
  gutter.style.width = gw + 'px';
  if (!n) { VH.emit('layout', {}); return; }
  // A holder's row (and its comment bar) stops where its first nested line
  // starts, as rectOf() does.
  for (var q = 1; q < n; q++) {
    if (nested[q] && boxes[q - 1] && boxes[q] && list[q - 1].contains(list[q])) {
      boxes[q - 1].bottom = Math.min(boxes[q - 1].bottom, boxes[q].top);
    }
  }
  var nm = metrics[fontKey(numCs)];
  var numLh = lineHeight(numCs, nm);
  var numBase = numLh / 2 + nm.k;
  var prev = -1;  // the last visible line, to spot lines that sit side by side
  for (var j = 0; j < n; j++) {
    var row = rows[j];
    if (!boxes[j]) { row.classList.add('vh-ln-x'); continue; }
    row.classList.remove('vh-ln-x');
    // Lines side by side (the .stat cells of a .grid) share one row of the
    // page; in the gutter column their numbers would print over each other.
    // A line that starts to the right of the previous one, level with it,
    // gets its row (number and signs) moved to its own left edge instead.
    var side = prev >= 0 && boxes[j].top < boxes[prev].bottom - 1 && xs[j].left >= xs[prev].right - 1;
    var dx = side ? xs[j].left - left : 0;
    if (geo.dx[j] !== dx) { geo.dx[j] = dx; row.style.transform = dx ? 'translateX(' + dx + 'px)' : ''; }
    prev = j;
    var m = metrics[fontKey(styles[j])];
    var lh = lineHeight(styles[j], m);
    var top = boxes[j].top - o.top;
    var height = Math.max(lh, boxes[j].bottom - boxes[j].top);
    var pad = Math.max(0, lh / 2 + m.k - numBase);
    var s = row.style;
    if (geo.top[j] !== top) { geo.top[j] = top; s.top = top + 'px'; }
    if (geo.height[j] !== height) { geo.height[j] = height; s.height = height + 'px'; }
    if (geo.pad[j] !== pad) { geo.pad[j] = pad; s.paddingTop = pad + 'px'; }
  }
  paintBand();
  VH.emit('layout', {});
}

function schedule() {
  if (!raf) raf = requestAnimationFrame(layout);
}

function relative() {
  return numbersOn && relativeOn && focused && !VH.mode.is('insert') && curRow > 0;
}

// numbertoggle: relative in normal/visual with the cursor line absolute and
// highlighted; absolute in insert and while the window is blurred. Relative
// distances count visible lines, so a closed fold is one step, like vim.
function paintNumbers() {
  if (!gutter) return;
  var cur = cursorLine();
  var c = cur ? rep[cur] : 0;
  if (curRow !== c) {
    if (curRow && rowsOf(curRow)) rowsOf(curRow).classList.remove('vh-ln-cur');
    if (c) rowsOf(c).classList.add('vh-ln-cur');
    curRow = c;
  }
  var rel = relative();
  gutter.classList.toggle('vh-rel', rel);
  if (rel) paintBand();
}

// Every relative number changes when the cursor moves, and rewriting 2,000
// rows costs ~8 ms of style work, so only rows within ~1.5 screens of the
// viewport are written; the scroll listener tops up rows as they come near.
// The band is found from the geometry layout() cached (no forced layout).
// Rows outside it keep stale values nobody can see.
function paintBand() {
  if (!gutter || !curRow || !gutter.classList.contains('vh-rel') || !shown.length) return;
  var vc = vidx[curRow];
  var view = window.innerHeight;
  var y = window.scrollY - layerY;
  var from = Math.max(0, firstBelow(y - 1.5 * view) - 30);
  var to = Math.min(shown.length - 1, firstBelow(y + 2.5 * view) + 30);
  for (var i = from; i <= to; i++) {
    var line = shown[i];
    var d = i > vc ? i - vc : vc - i;
    if (relVal[line] !== d) {
      relVal[line] = d;
      rows[line - 1].setAttribute('data-rel', d);
    }
  }
}

// Index into `shown` of the first visible line whose cached top is at or below
// y (layer coordinates); shown.length when none is.
function firstBelow(y) {
  var lo = 0, hi = shown.length;
  while (lo < hi) {
    var mid = (lo + hi) >> 1;
    if (geo.top[shown[mid] - 1] < y) lo = mid + 1; else hi = mid;
  }
  return lo;
}

// VH.marks is motions.js's: all() -> [{mark, line, text}]. Guarded, so the
// gutter still draws on a build without it.
function markList() {
  var all = [];
  try { all = VH.marks && VH.marks.all ? VH.marks.all() : []; } catch (err) { VH.error('marks', err); }
  return (all || []).filter(function (m) { return m && m.mark && m.line; });
}

// Comment bars and mark letters. A closed fold's heading shows the signs of
// the lines it hides, so folded comments are never out of sight.
function paintSigns() {
  if (!gutter) return;
  var n = list.length;
  var commented = new Uint8Array(n + 1);
  var marks = {};
  var comments = [];
  try { comments = VH.comments && VH.comments.all ? VH.comments.all() : []; } catch (err) { VH.error('comments', err); }
  comments.forEach(function (c) {
    var a = c && c.anchor;
    if (!a || c.detached || !a.startLine) return;
    var s = Math.max(1, a.startLine), e = Math.min(n, a.endLine || a.startLine);
    for (var k = s; k <= e; k++) commented[rep[k]] = 1;
  });
  markList().forEach(function (m) {
    if (m.line < 1 || m.line > n) return;
    var r = rep[m.line];
    (marks[r] || (marks[r] = [])).push(m.mark);
  });
  rows.forEach(function (row, i) {
    row.classList.toggle('vh-ln-c', !!commented[i + 1]);
    var letters = marks[i + 1] ? marks[i + 1].sort().join('').slice(0, 2) : null;
    if (letters) row.setAttribute('data-mark', letters);
    else if (row.hasAttribute('data-mark')) row.removeAttribute('data-mark');
  });
}

// `keep` is the closed-fold keys to restore: the stored ones at boot, else
// whatever is closed now (headings are matched by key, not line number).
function refresh(keep) {
  if (!Array.isArray(keep)) keep = closedKeys();
  swallowed = null;
  unfoldDom();  // discovery must see folded lines rendered
  discover();
  buildHeads();
  applyKeys(keep);
  computeVisibility();
  foldDom();
  renderRows();
  layout();
  paintSigns();
  paintNumbers();
}

/* ---------------------------------------------------------------- the API */

function clampLine(n) {
  n = Math.floor(+n) || 0;
  return Math.max(1, Math.min(list.length, n));
}

// The line's own box: a holder (an li with a sublist) stops where its first
// nested line starts, so "line n" never covers lines n+1... on screen. This is
// the one definition of a line's box: motions.js's cursorline and scrolling use
// it too.
function rectOf(n) {
  var e = list[n - 1];
  var r = e.getBoundingClientRect();
  var nx = nested[n] && list[n];
  if (!nx || !e.contains(nx) || !nx.getClientRects().length) return r;
  var bottom = Math.max(r.top, Math.min(r.bottom, nx.getBoundingClientRect().top));
  return new DOMRect(r.left, r.top, r.width, bottom - r.top);
}

/* ------------------------------------------------------- line text model
 * The one definition of a line's text, which comments (quotes, anchors, the
 * export), search, the pickers, yank and VH.lines.text all read:
 *
 *   model(n) -> {text, raw2n, nStart, nEnd, rawLen, segs}
 *     text    the line as read: whitespace collapsed as the browser renders
 *             it, table cells joined by " | ", a space for <br>, for a block
 *             element inside the line (a div in a cell) and between a .stat's
 *             parts ("640 visitors"); a <pre> line verbatim. Nested lines' text
 *             (an li's sub-list) and our UI are left out.
 *     raw     offsets are VH.text offsets (positions in el.textContent, which
 *             still counts the left-out text): raw2n[raw] is the text index at
 *             a raw boundary; nStart[i]/nEnd[i] the raw span behind text char
 *             i. A collapsed run maps to the one space it became; separators
 *             own no raw chars. So any DOM point maps in (VH.text.offsetIn ->
 *             raw2n) and any text span maps out (nStart/nEnd ->
 *             VH.text.rangeFrom) exactly.
 *     segs    [s0, e0, s1, e1...] spans a search match may not cross: one per
 *             table cell, one per source line of an unsplit <pre>, else the
 *             whole text.
 */

var BLOCKS = /^(?:DIV|P|UL|OL|DL|DT|DD|LI|BLOCKQUOTE|H[1-6]|FIGURE|FIGCAPTION|TABLE|THEAD|TBODY|TFOOT|SECTION|ARTICLE|HR|PRE|DETAILS|SUMMARY)$/;

// Text a reader never sees as the line's: our UI, scripts, a field's contents.
var NOT_TEXT = '[data-vh-ui],script,style,template,noscript,textarea,select';

function skippedText(node, n) {
  var p = node.parentElement;
  return !!(p && p.closest(NOT_TEXT)) || VH.lines.of(node) !== n;
}

function model(n) {
  var el = list[n - 1];
  var keep = !!el.closest('pre');
  var stat = el.classList.contains('stat');
  var out = '';
  var nStart = [], nEnd = [], raw2n = [], segs = [0];
  var raw = 0, wsFrom = -1, sep = '';
  var pend = [];  // raw indices whose text index is known only once the next char lands
  function settle() { for (var i = 0; i < pend.length; i++) raw2n[pend[i]] = out.length; pend = []; }
  function emit(ch, s, e) { out += ch; nStart.push(s); nEnd.push(e); }
  var w = document.createTreeWalker(el, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
  var node;
  while ((node = w.nextNode())) {
    if (node.nodeType === 1) {
      if (keep) continue;
      var tag = node.tagName;
      if ((tag === 'TD' || tag === 'TH') && node.previousElementSibling) sep = ' | ';
      else if (tag === 'BR' || BLOCKS.test(tag) || (stat && node.parentElement === el)) sep = sep || ' ';
      continue;
    }
    var data = node.data, skip = skippedText(node, n);
    for (var i = 0; i < data.length; i++, raw++) {
      var ch = data.charAt(i);
      if (skip) { pend.push(raw); continue; }
      if (keep) { settle(); raw2n[raw] = out.length; emit(ch, raw, raw + 1); continue; }
      if (/\s/.test(ch)) { if (wsFrom < 0) wsFrom = raw; pend.push(raw); continue; }
      if (out.length && sep) {
        settle();
        if (sep === ' | ') segs.push(out.length);
        for (var k = 0; k < sep.length; k++) emit(sep.charAt(k), raw, raw);
        if (sep === ' | ') segs.push(out.length);
      } else if (out.length && wsFrom >= 0) { settle(); emit(' ', wsFrom, raw); }
      settle();
      sep = '';
      wsFrom = -1;
      raw2n[raw] = out.length;
      emit(ch, raw, raw + 1);
    }
  }
  settle();
  raw2n[raw] = out.length;
  if (keep) {
    // A <pre> line keeps its indentation but not the newline that ends it.
    var len = out.replace(/[\r\n]+$/, '').length;
    if (len < out.length) {
      out = out.slice(0, len);
      nStart.length = nEnd.length = len;
      for (var j = 0; j <= raw; j++) if (raw2n[j] > len) raw2n[j] = len;
    }
    segs = [0];
    for (var at = out.indexOf('\n'); at >= 0; at = out.indexOf('\n', at + 1)) segs.push(at, at + 1);
  }
  segs.push(out.length);
  return { text: out, raw2n: raw2n, nStart: nStart, nEnd: nEnd, rawLen: raw, segs: segs };
}

VH.lines = {
  count: function () { return list.length; },
  el: function (n) { return list[n - 1] || null; },
  of: function (node) {
    for (var x = node && node.nodeType === 1 ? node : node && node.parentNode; x && x !== document; x = x.parentNode) {
      var n = index.get(x);
      if (n) return n;
    }
    // The "\n" between two pre lines belongs to the line it ends.
    if (node && node.nodeType === 3 && node.previousSibling && node.previousSibling.nodeType === 1 &&
        node.previousSibling.classList.contains('vh-pl')) return index.get(node.previousSibling) || 0;
    return 0;
  },
  // model(n).text, whitespace-normalised: they differ only on a <pre> line,
  // whose model keeps its indentation for quotes.
  text: function (n) { return list[n - 1] ? VH.text.norm(model(n).text) : ''; },
  model: function (n) { return list[n - 1] ? model(n) : null; },
  rect: function (n) { return list[n - 1] ? rectOf(n) : null; },
  // Binary search over visible lines for the first one below the top edge,
  // then a walk to the last one above the status line.
  visible: function () {
    var len = shown.length;
    if (!len) return [0, 0];
    var bottom = window.innerHeight - STATUS_H;
    var lo = 0, hi = len;
    while (lo < hi) {
      var mid = (lo + hi) >> 1;
      if (rectOf(shown[mid]).bottom > 0) hi = mid; else lo = mid + 1;
    }
    if (lo >= len) lo = len - 1;
    var last = lo;
    while (last + 1 < len && rectOf(shown[last + 1]).top < bottom) last++;
    return [shown[lo], shown[last]];
  },
  headingPath: function (n) {
    var parts = [];
    for (var h = innermost(n); h; h = h.parent) parts.unshift(h.text);
    return parts.join(' › ');
  },
  // (+) headingPath for a crumb printed beside the document title (status
  // line, comments sidebar): an outermost h1 the title already names is left
  // out, so 'Brief: Arnab Das › Arnab Das › Background' reads '… › Background'.
  sectionPath: function (n) {
    var hs = [];
    for (var h = innermost(n); h; h = h.parent) hs.unshift(h);
    if (hs.length && hs[0].level === 1 && namesTitle(hs[0].text)) hs.shift();
    return hs.map(function (x) { return x.text; }).join(' › ');
  },
  headings: function () {
    return heads.map(function (h) { return { line: h.line, level: h.level, text: h.text }; });
  },
  hidden: function (n) { return n >= 1 && n <= list.length && rep[n] !== n; },
  next: function (n, step) {
    if (!list.length) return 0;
    n = clampLine(n);
    step = Math.trunc(+step) || 0;
    // A hidden line sits just after its fold's heading: one step back is the heading.
    var i = vidx[n] + step + (step < 0 && rep[n] !== n ? 1 : 0);
    return shown[Math.max(0, Math.min(shown.length - 1, i))];
  },
  refresh: function () { refresh(); }
};

VH.gutter = {
  numbers: function () { return numbersOn; },
  relative: function () { return relative(); },
  toggleNumbers: function () {
    numbersOn = !numbersOn;
    if (gutter) gutter.classList.toggle('vh-nonu', !numbersOn);
    paintNumbers();
    return numbersOn;
  },
  toggleRelative: function () {
    relativeOn = !relativeOn;
    paintNumbers();
    return relativeOn;
  }
};

/* ------------------------------------------------------------------ mouse
 * Phones have no z keys: tapping a fold heading's number toggles its fold, and
 * tapping the "··· N lines" trailer opens it.
 */

function onGutterClick(e) {
  var row = e.target.closest && e.target.closest('.vh-ln-fold');
  if (!row) return;
  var n = rows.indexOf(row) + 1;
  if (!n) return;
  e.preventDefault();
  if (VH.cursor) VH.cursor.set(n, { scroll: false });
  VH.folds.toggle(n);
}

function onTrailerClick(e) {
  var head = e.target.closest && e.target.closest('[data-vh-fold]');
  if (!head || e.button) return;
  var r = document.createRange();
  r.selectNodeContents(head);
  var rects = r.getClientRects();
  var end = rects[rects.length - 1];
  // The trailer follows the text: right of its last row, or below it when the
  // trailer wrapped onto a row of its own.
  if (!end || !(e.clientY > end.bottom || (e.clientX > end.right && e.clientY >= end.top - 4))) return;
  VH.folds.open(index.get(head));
}

/* ------------------------------------------------------------------- keys */

function foldKey(fn) {
  return function () {
    var cur = cursorLine();
    if (!cur || !fn(cur)) VH.toast('E490: No fold found');
  };
}

VH.keys.map('normal', 'za', foldKey(VH.folds.toggle), { desc: 'toggle the fold at the cursor', group: 'fold' });
VH.keys.map('normal', 'zc', foldKey(VH.folds.close), { desc: 'close the fold at the cursor', group: 'fold' });
VH.keys.map('normal', 'zo', foldKey(VH.folds.open), { desc: 'open the fold at the cursor', group: 'fold' });
VH.keys.map('normal', 'zM', function () { VH.folds.closeAll(); }, { desc: 'close all folds', group: 'fold' });
VH.keys.map('normal', 'zR', function () { VH.folds.openAll(); }, { desc: 'open all folds', group: 'fold' });
VH.keys.map('normal', 'zm', function (c) { VH.folds.more(c); }, { desc: 'fold more: close one more level', group: 'fold' });
VH.keys.map('normal', 'zr', function (c) { VH.folds.less(c); }, { desc: 'fold less: open one more level', group: 'fold' });
VH.keys.map('normal', '<leader>ul', function () {
  VH.toast(VH.gutter.toggleNumbers() ? 'Line numbers on' : 'Line numbers off');
}, { desc: 'toggle line numbers', group: 'ui' });
VH.keys.map('normal', '<leader>uL', function () {
  VH.toast(VH.gutter.toggleRelative() ? 'Relative numbers on' : 'Relative numbers off');
}, { desc: 'toggle relative numbers', group: 'ui' });

/* ------------------------------------------------------------------- boot */

VH.init(function () {
  gutter = VH.ui.h('div', { 'class': 'vh-gutter', 'aria-hidden': 'true' });
  VH.ui.layer.appendChild(gutter);
  gutter.addEventListener('click', onGutterClick);
  document.addEventListener('click', onTrailerClick);
  focused = document.hasFocus ? document.hasFocus() : true;
  booted = true;
  refresh(load());

  window.addEventListener('resize', schedule);
  window.addEventListener('scroll', paintBand, { passive: true });
  window.addEventListener('load', schedule);
  window.addEventListener('focus', function () { focused = true; paintNumbers(); });
  window.addEventListener('blur', function () { focused = false; paintNumbers(); });
  // Image loads do not bubble; capture sees every one.
  document.addEventListener('load', function (e) { if (e.target && e.target.tagName === 'IMG') schedule(); }, true);
  // Opening or closing a <details> adds or removes lines.
  document.addEventListener('toggle', function (e) {
    if (e.target && e.target.tagName === 'DETAILS' && !VH.ui.isOurs(e.target)) refresh();
  }, true);
  if (document.fonts) {
    var fontsChanged = function () { metrics = {}; schedule(); };
    if (document.fonts.ready) document.fonts.ready.then(fontsChanged);
    if (document.fonts.addEventListener) document.fonts.addEventListener('loadingdone', fontsChanged);
  }
  if (window.ResizeObserver) new ResizeObserver(schedule).observe(document.body);

  VH.on('cursor', onCursor);
  VH.on('mode', paintNumbers);
  VH.on('comments', paintSigns);
  VH.on('marks', paintSigns);
});
