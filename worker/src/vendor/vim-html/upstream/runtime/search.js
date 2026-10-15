/* search.js -- piece D: the command line (: / ?), search, pickers and the outline.
 *
 * Four pieces of UI, one keyboard rule. Whichever of them holds the keyboard
 * puts core in mode 'command' and becomes the `owner` below. In that mode core
 * types printable keys straight into the focused element and dispatches only
 * mapped non-printable tokens (<CR> <Esc> <Tab> <Up> <C-j> ...); the
 * command-mode maps at the bottom route those to the owner. Any mode change
 * away from 'command' (a click into a page field, another module setting a
 * mode) closes the owner, so no UI here can trap the reader.
 *
 *   cmdline  ':' '/' '?'  a one-line input over the status line; history in
 *            VH.prefs (one list for ':', one for search), Tab completes ':'
 *            command names (wildmode=full), messages show in the same strip
 *   search   incremental over a text index of the gutter lines; n/N always
 *            forward/backward (LazyVim's saner n/N); * #; highlights clear on
 *            Esc, :noh, or any cursor move that is not ours (vim-noh)
 *   pickers  <leader>sb lines, <leader>ss headings: fzf-style fuzzy ranking
 *   outline  <leader>cs a right-side heading list that follows the cursor;
 *            <leader>cS focuses it, and only then does it own 'command'
 *
 * Text index: each gutter line's text as VH.lines.model gives it (the same
 * text comments quote), built the first time a search needs it and again after
 * 'layout'. Matching runs on those strings, so a match may cross <b>, <code> or
 * a link inside a line but never leaves the line, a table cell, or a source
 * line of a <pre>. Matches turn into DOM Ranges only when painted.
 *
 * Highlights use the CSS Custom Highlight API and never touch the document.
 * Without the API the current match is selected natively instead. The match
 * counter "[3/17]" sits after the current match's line, like noice's virtual
 * text in the owner's LazyVim.
 *
 * Contract surface used: VH.lines (count, el, visible, and headings/hidden when
 * lines.js provides them), VH.folds.reveal when present, VH.cursor.get/set with
 * {scroll, caret, jump} and caret() when present, VH.keys, VH.commands,
 * VH.prefs, VH.mode, and the events 'cursor' 'layout' 'escape' 'close' 'mode'.
 * Emits 'search' {query, index, total} (index and total are 0 while nothing is
 * highlighted) and (+) 'outline' {open}. Exposes (+) VH.search for tests and
 * debugging.
 */

var STATUS_H = 28;       // chrome's fixed status line; the command line covers it
var MARGIN = 48;         // a revealed match keeps this much room from the viewport edges
var PAINT_ALL = 3000;    // above this many matches only those near the viewport are painted
var PAINT_PAD = 80;      // ...that many lines either side of the visible ones
var MAX_MATCHES = 200000;
var HIST_MAX = 100;
var HAS_HL = typeof CSS !== 'undefined' && !!CSS.highlights && typeof Highlight === 'function';
var html = document.documentElement;
var h = function (tag, attrs, kids) { return VH.ui.h(tag, attrs, kids); };

/* ------------------------------------------------------------ text index
 * idx.lines[n - 1] = {el, text, m, segs} for gutter line n, straight from
 * VH.lines.model(n) (lines.js "line text model"), the same text comments
 * quote and yank copies:
 *   text    the line as read: whitespace collapsed, table cells joined by
 *           " | ", nested gutter lines and our UI left out
 *   m       the model, whose raw offset maps turn a match back into a DOM
 *           Range (rangeAt) and a caret into an offset (offsetOf)
 *   segs    [s0, e0, s1, e1...] spans a match may not cross: one per table
 *           cell, one per source line of an unsplit <pre>, else the whole text
 * Matches are offsets into one build; idxVersion tells a stale set of matches
 * (see ensure()) from a fresh one.
 */

var idx = null;
var idxDirty = true;
var idxVersion = 0;

function index() {
  if (idx && !idxDirty) return idx;
  var count = VH.lines.count();
  var lines = [];
  for (var n = 1; n <= count; n++) {
    var m = VH.lines.model(n);
    lines.push(m ? { el: VH.lines.el(n), text: m.text, m: m, segs: m.segs }
                 : { el: null, text: '', m: null, segs: [0, 0] });
  }
  idx = { count: count, lines: lines };
  idxDirty = false;
  idxVersion++;
  return idx;
}

// Text offsets [start, end) of a line -> DOM boundary points, through the
// model's raw spans (VH.text offsets); null when the line is gone.
function boundsAt(ix, line, start, end) {
  var L = ix.lines[line - 1];
  if (!L || !L.m || !L.el || !L.el.isConnected) return null;
  var m = L.m;
  var len = m.text.length;
  var a = start < len ? m.nStart[start] : m.rawLen;
  var b = end > 0 && len ? m.nEnd[Math.min(end, len) - 1] : a;
  return VH.text.bounds(L.el, a, Math.max(a, b));
}

function rangeAt(ix, line, start, end) {
  var b = boundsAt(ix, line, start, end);
  if (!b) return null;
  var r = document.createRange();
  r.setStart(b[0], b[1]);
  r.setEnd(b[2], b[3]);
  return r;
}

// What the highlights hold: a StaticRange, which the document never updates.
// Painting a live Range per match left hundreds registered per n until GC,
// and every DOM write (the status line's, each keypress) walked them all.
// The index is rebuilt and the matches repainted after any 'layout'.
var HAS_STATIC = typeof StaticRange === 'function';

function hlRangeAt(ix, line, start, end) {
  if (!HAS_STATIC) return rangeAt(ix, line, start, end);
  var b = boundsAt(ix, line, start, end);
  return b && new StaticRange({ startContainer: b[0], startOffset: b[1], endContainer: b[2], endOffset: b[3] });
}

// The inverse: a DOM position (a caret) as an offset in the line.
function offsetOf(L, node, offset) {
  if (!L.m) return -1;
  var raw = VH.text.offsetIn(L.el, node, offset);
  return L.m.raw2n[Math.max(0, Math.min(raw, L.m.rawLen))];
}

/* --------------------------------------------------------------- matching */

var WORD = '[\\p{L}\\p{N}_]';

// A query is literal text with vim's search conveniences: smartcase (an
// uppercase letter makes it case-sensitive; \c and \C force either way), any
// run of whitespace matches any run, \< and \> are word edges, and straight
// quotes also match curly ones (documents are typeset, queries are typed).
// `noSmart` is for * and #, which in vim use 'ignorecase' but not 'smartcase'.
function compile(q, noSmart) {
  var s = String(q || '');
  var ic = null;
  if (/\\C/.test(s)) ic = false;
  if (/\\c/.test(s)) ic = true;  // as in vim, \c wins when both appear
  s = s.replace(/\\[cC]/g, '');
  var src = '';
  var plain = '';
  for (var i = 0; i < s.length; i++) {
    var c = s[i];
    if (c === '\\' && (s[i + 1] === '<' || s[i + 1] === '>')) {
      src += s[i + 1] === '<' ? '(?<!' + WORD + ')(?=' + WORD + ')' : '(?<=' + WORD + ')(?!' + WORD + ')';
      i++;
    } else if (/\s/.test(c)) {
      while (i + 1 < s.length && /\s/.test(s[i + 1])) i++;
      src += '\\s+';
      plain += ' ';
    } else {
      plain += c;
      if (c === "'" || c === '\u2018' || c === '\u2019') src += "['\u2018\u2019]";
      else if (c === '"' || c === '\u201C' || c === '\u201D') src += '["\u201C\u201D]';
      else src += c.replace(/[\\^$.*+?()[\]{}|\/]/g, '\\$&');
    }
  }
  if (!plain) return null;
  if (ic === null) ic = noSmart || plain === plain.toLowerCase();
  try {
    return { query: String(q), re: new RegExp(src, 'gu' + (ic ? 'i' : '')) };
  } catch (err) {
    return null;  // e.g. an engine without lookbehind given \< or \>
  }
}

function noMatches() { return { line: [], start: [], end: [] }; }

// Every match in document order, as parallel arrays of (line, start, end).
function findAll(pat, ix) {
  var M = noMatches();
  var re = pat.re;
  for (var i = 0; i < ix.count; i++) {
    var L = ix.lines[i];
    for (var k = 0; k < L.segs.length; k += 2) {
      var s = L.segs[k], e = L.segs[k + 1];
      if (e <= s) continue;
      var str = s === 0 && e === L.text.length ? L.text : L.text.slice(s, e);
      re.lastIndex = 0;
      for (var m = re.exec(str); m; m = re.exec(str)) {
        if (!m[0].length) { re.lastIndex++; continue; }
        M.line.push(i + 1);
        M.start.push(s + m.index);
        M.end.push(s + m.index + m[0].length);
        if (M.line.length >= MAX_MATCHES) return M;
      }
    }
  }
  return M;
}

// First match at or after (line, off), strictly after when `strict`.
function firstAfter(M, line, off, strict) {
  var lo = 0, hi = M.line.length;
  while (lo < hi) {
    var mid = (lo + hi) >> 1;
    var c = (M.line[mid] - line) || (M.start[mid] - off);
    if (strict ? c > 0 : c >= 0) hi = mid; else lo = mid + 1;
  }
  return lo;
}

// Last match strictly before (line, off), or -1.
function lastBefore(M, line, off) {
  return firstAfter(M, line, off, false) - 1;
}

// The match in direction `dir` from `pos`, strictly after or before it (as in
// vim, a search never finds the match the caret is on), wrapping round the
// ends like 'wrapscan'. origin() puts `pos` before everything on the cursor
// line when the caret is not on it, so that line's own matches still count.
function seek(M, pos, dir) {
  var n = M.line.length;
  if (!n) return null;
  if (dir > 0) {
    var i = firstAfter(M, pos.line, pos.off, true);
    return i < n ? { i: i, wrapped: false } : { i: 0, wrapped: true };
  }
  var j = lastBefore(M, pos.line, pos.off);
  return j >= 0 ? { i: j, wrapped: false } : { i: n - 1, wrapped: true };
}

/* ----------------------------------------------------------- search state
 * S is the committed search: what n/N repeat and what is painted when shown.
 * While '/' or '?' is open, `live` holds the in-progress one, so Esc can put
 * S, the view and the cursor back exactly as they were.
 */

var S = { query: '', pat: null, M: noMatches(), ver: -1, cur: -1, shown: false };
var live = null;      // {dir, from, view, st} while a search line is open
var moving = false;   // set while search moves the cursor itself; see the 'cursor' listener

function makeState(q, noSmart) {
  var ix = index();
  var pat = compile(q, noSmart);
  return { query: q, pat: pat, M: pat ? findAll(pat, ix) : noMatches(), ver: idxVersion, cur: -1, shown: false };
}

// Matches belong to one build of the index; after a rebuild they are found
// again, keeping the current match at (or just after) the same place.
function ensure(st) {
  index();
  if (!st.pat || st.ver === idxVersion) return;
  var keep = st.cur >= 0 ? { line: st.M.line[st.cur], off: st.M.start[st.cur] } : null;
  st.M = findAll(st.pat, idx);
  st.ver = idxVersion;
  var n = st.M.line.length;
  st.cur = keep && n ? Math.min(firstAfter(st.M, keep.line, keep.off, false), n - 1) : -1;
}

// The caret on line L as an offset, or null: VH.cursor.caret() first (the
// Range a search landed with, kept by motions.js until the cursor moves), then
// the native selection (a click puts a collapsed one under the mouse).
function caretIn(L) {
  if (!L || !L.el) return null;
  var c = VH.cursor.caret && VH.cursor.caret();
  var sel = window.getSelection();
  var r = c && c.startContainer && c.startContainer.isConnected ? c
    : sel && sel.rangeCount ? sel.getRangeAt(0) : null;
  if (!r || !L.el.contains(r.startContainer) || VH.ui.isOurs(r.startContainer)) return null;
  return offsetOf(L, r.startContainer, r.startOffset);
}

// Where a search starts: on the current match when the cursor is still on its
// line, else at the caret when it sits on the cursor line, else before
// everything on the cursor line (off -1). A caret at the very start counts as
// before everything, so a match at column 0 of a line the cursor just moved
// to is found rather than skipped.
function origin(st) {
  var ix = index();
  var line = VH.cursor ? VH.cursor.get() : 0;
  if (!line) return { line: 1, off: -1 };
  var caret = caretIn(ix.lines[line - 1]);
  if (st && st.cur >= 0 && st.M.line[st.cur] === line &&
      (caret === null || caret === st.M.start[st.cur])) {
    return { line: line, off: st.M.start[st.cur] };
  }
  return { line: line, off: caret ? caret : -1 };
}

function emitSearch(st) {
  var on = !!(st && st.shown && st.M.line.length);
  VH.emit('search', { query: st ? st.query : '', index: on ? st.cur + 1 : 0, total: on ? st.M.line.length : 0 });
  showCount(live ? null : st);
}

/* The match counter: "[3/17]" just past the end of the current match's line,
 * where the owner's LazyVim (noice) shows its search count as virtual text.
 * It lives in VH.ui.layer, so it scrolls with the page and never touches the
 * document; while a search is being typed it hides, as vim shows only the
 * pattern then. */
var countEl = null;

function showCount(st) {
  var rect = null;
  if (st && st.shown && st.cur >= 0 && st.M.line.length) {
    var ix = index();
    var line = st.M.line[st.cur];
    var L = ix.lines[line - 1];
    var r = L && rangeAt(ix, line, 0, L.text.length);
    var rects = r ? r.getClientRects() : [];
    for (var i = rects.length - 1; i >= 0 && !rect; i--) if (rects[i].width) rect = rects[i];
  }
  if (!rect) {  // nothing current, or its line is folded away
    if (countEl) countEl.hidden = true;
    return;
  }
  if (!countEl) {
    countEl = h('span', { 'class': 'vh-search-count', 'aria-hidden': 'true' });
    VH.ui.layer.appendChild(countEl);
  }
  countEl.textContent = '[' + (st.cur + 1) + '/' + st.M.line.length + ']';
  countEl.hidden = false;
  var o = VH.ui.origin();
  var x = Math.min(rect.right + 12, html.clientWidth - countEl.offsetWidth - 8);
  countEl.style.left = x - o.left + 'px';
  countEl.style.top = rect.top + (rect.height - countEl.offsetHeight) / 2 - o.top + 'px';
}

/* --------------------------------------------------------------- painting */

var painted = null;    // {lo, hi} lines painted when a search has too many matches to paint all
var nativeSel = null;  // the Range selected for the current match without the Highlight API
var paintRaf = 0;

function paint(st) {
  if (!HAS_HL) return paintNative(st);
  if (!st || !st.shown || !st.M.line.length) {
    CSS.highlights.delete('vh-search');
    CSS.highlights.delete('vh-search-cur');
    painted = null;
    return;
  }
  var ix = index();
  var M = st.M;
  var from = 0, to = M.line.length;
  painted = null;
  if (to > PAINT_ALL) {
    var v = VH.lines.visible();
    painted = { lo: Math.max(1, v[0] - PAINT_PAD), hi: v[1] + PAINT_PAD };
    from = firstAfter(M, painted.lo, -1, false);
    to = firstAfter(M, painted.hi + 1, -1, false);
  }
  var all = new Highlight();
  for (var i = from; i < to; i++) {
    var r = hlRangeAt(ix, M.line[i], M.start[i], M.end[i]);
    if (r) all.add(r);
  }
  // Above vh-comment (piece E) and below nothing: a search is what the reader
  // is looking at right now.
  all.priority = 100;
  CSS.highlights.set('vh-search', all);
  var cur = new Highlight();
  var c = st.cur >= 0 && hlRangeAt(ix, M.line[st.cur], M.start[st.cur], M.end[st.cur]);
  if (c) cur.add(c);
  cur.priority = 101;
  CSS.highlights.set('vh-search-cur', cur);
}

// No Highlight API: no DOM mutation either. The current match becomes the
// native selection, and is collapsed again when the search is cleared.
// While a search line is open the preview only scrolls: a document selection
// would take the caret out of the input and swallow the next keystrokes.
function paintNative(st) {
  var sel = window.getSelection();
  if (!sel) return;
  if (live && st === live.st) return;
  if (!st || !st.shown || st.cur < 0) {
    if (nativeSel && sel.rangeCount && sameRange(sel.getRangeAt(0), nativeSel)) sel.collapseToStart();
    nativeSel = null;
    return;
  }
  var r = rangeAt(index(), st.M.line[st.cur], st.M.start[st.cur], st.M.end[st.cur]);
  if (!r) return;
  sel.removeAllRanges();
  sel.addRange(r);
  nativeSel = r;
}

function sameRange(a, b) {
  return a.startContainer === b.startContainer && a.startOffset === b.startOffset &&
    a.endContainer === b.endContainer && a.endOffset === b.endOffset;
}

// With windowed painting, scrolling far enough paints the matches coming into view.
function onScroll() {
  if (!painted || paintRaf) return;
  paintRaf = requestAnimationFrame(function () {
    paintRaf = 0;
    if (!painted) return;
    var v = VH.lines.visible();
    var st = live ? live.st : S;
    if (v[0] < painted.lo + PAINT_PAD / 2 || v[1] > painted.hi - PAINT_PAD / 2) paint(st);
  });
}

/* ----------------------------------------------------------------- moving */

// Scroll so a match is readable: a horizontally scrolled box (a long code line
// in a <pre>) first, then the window if the match is near an edge or off
// screen. `view` (a live search's saved view) records boxes to scroll back.
function reveal(r, view) {
  var rect = r.getBoundingClientRect();
  if (!rect.width && !rect.height) return;  // in a closed fold or display:none
  for (var el = r.startContainer.parentElement; el && el !== document.body; el = el.parentElement) {
    if (el.scrollWidth > el.clientWidth + 1 && /auto|scroll/.test(getComputedStyle(el).overflowX)) {
      var b = el.getBoundingClientRect();
      if (rect.left < b.left || rect.right > b.right) {
        if (view && !view.boxes.some(function (x) { return x.el === el; })) view.boxes.push({ el: el, left: el.scrollLeft });
        el.scrollLeft += rect.left - b.left - b.width / 3;
        rect = r.getBoundingClientRect();
      }
      break;
    }
  }
  var bottom = window.innerHeight - STATUS_H;
  if (rect.top < MARGIN || rect.bottom > bottom - MARGIN) {
    window.scrollBy({ top: rect.top - (bottom - rect.height) / 2, left: 0, behavior: 'instant' });
  }
}

function saveView() {
  return { x: window.scrollX, y: window.scrollY, line: VH.cursor ? VH.cursor.get() : 0, boxes: [] };
}

function restoreView(v) {
  if (v.line && VH.cursor && VH.cursor.get() !== v.line) {
    moving = true;
    try { VH.cursor.set(v.line, { scroll: false }); } finally { moving = false; }
  }
  v.boxes.forEach(function (b) { b.el.scrollLeft = b.left; });
  v.boxes = [];
  window.scrollTo({ top: v.y, left: v.x, behavior: 'instant' });
}

function revealFold(line) {
  if (VH.folds && VH.folds.reveal && (!VH.lines.hidden || VH.lines.hidden(line))) VH.folds.reveal(line);
}

// Land on match i of S: cursor to its line, caret to its start (so `v` starts
// there), view onto it. Search moves are jumps, as in vim, so Ctrl-o returns.
function land(i) {
  var line = S.M.line[i];
  revealFold(line);
  var r = rangeAt(index(), line, S.M.start[i], S.M.end[i]);
  var caret = r && r.cloneRange();
  if (caret) caret.collapse(true);
  moving = true;
  try { VH.cursor.set(line, { scroll: 'auto', caret: caret, jump: true }); } finally { moving = false; }
  if (r) {
    placeCaret(caret);
    reveal(r, null);
  }
  paint(S);
  emitSearch(S);
}

// motions.js keeps {caret} for VH.cursor.caret(), which visual mode reads; a
// motions.js without caret() gets a collapsed native selection there instead.
// Without the Highlight API paint() selects the whole match, which also starts
// at the match.
function placeCaret(caret) {
  var sel = window.getSelection();
  if (!HAS_HL || !sel || VH.cursor.caret) return;
  if (sel.rangeCount) {
    var s = sel.getRangeAt(0);
    if (s.startContainer === caret.startContainer && s.startOffset === caret.startOffset) return;
  }
  sel.removeAllRanges();
  sel.addRange(caret);
}

function clearHl() {
  if (!S.shown) return;
  S.shown = false;
  paint(S);
  emitSearch(S);
}

/* ------------------------------------------------------- incremental search */

function liveStart(dir) {
  live = { dir: dir, from: origin(S), view: saveView(), st: null };
  paint(null);  // vim shows only the pattern being typed
  showCount(null);
}

// Every keystroke: find all matches, preview the first one after the start
// (before it for '?'), wrapping silently; an empty or failing query puts the
// view back.
function liveUpdate() {
  var q = cl.input.value;
  var st = q ? makeState(q) : null;
  if (st && st.M.line.length) {
    st.cur = seek(st.M, live.from, live.dir).i;
    st.shown = true;
  }
  live.st = st;
  paint(st);
  if (st && st.cur >= 0) {
    var r = rangeAt(index(), st.M.line[st.cur], st.M.start[st.cur], st.M.end[st.cur]);
    if (r) reveal(r, live.view);
  } else {
    restoreView(live.view);
  }
  emitSearch(st || { query: q, M: noMatches(), cur: -1, shown: false });
}

function liveCancel() {
  var L = live;
  live = null;
  restoreView(L.view);
  paint(S);
  emitSearch(S);
}

function submitSearch(text, L) {
  if (!L) return;
  var q = text;
  var st = L.st;
  if (!q) {
    if (!S.query) {
      restoreView(L.view);
      paint(S);
      return say('E35: No previous regular expression', 'error');
    }
    q = S.query;  // '/' then Enter repeats the last search, as in vim
    st = S;
    ensure(st);
  }
  histPush('/', q);
  if (!st || st.query !== q) st = makeState(q);
  S = st;
  if (!S.M.line.length) restoreView(L.view);  // vim leaves the cursor where it was
  hop(L.from, L.dir, 1);
}

// Count `count` matches on from `pos` in direction `dir`, land on the last,
// and say so when that went round an end of the document.
function hop(pos, dir, count) {
  if (!S.M.line.length) {
    S.shown = false;
    paint(S);
    emitSearch(S);
    return say('E486: Pattern not found: ' + S.query, 'error');
  }
  var hit = null;
  var wrapped = false;
  for (var k = 0; k < (count || 1); k++) {
    hit = seek(S.M, pos, dir);
    wrapped = wrapped || hit.wrapped;
    pos = { line: S.M.line[hit.i], off: S.M.start[hit.i] };
  }
  S.cur = hit.i;
  S.shown = true;
  land(hit.i);
  if (wrapped) say(dir > 0 ? 'search hit BOTTOM, continuing at TOP' : 'search hit TOP, continuing at BOTTOM', 'warn');
  else hideMsg();
}

// n and N: count matches on from where the cursor is, wrapping; n is always
// forward and N always backward, whichever of / or ? started the search.
function step(dir, count) {
  if (!S.query) return say('E35: No previous regular expression', 'error');
  ensure(S);
  hop(origin(S), dir, count);
}

// * and #: search the whole word at the caret (or the first word after it on
// the cursor line), forward or backward, skipping the occurrence under it.
function star(dir, count) {
  var pos = origin(S);
  var L = index().lines[pos.line - 1];
  if (!L) return;
  var re = new RegExp(WORD + '+', 'gu');
  var from = Math.max(0, pos.off);
  var m;
  for (m = re.exec(L.text); m && m.index + m[0].length <= from; m = re.exec(L.text)) { /* skip */ }
  if (!m) return say('E348: No string under cursor', 'error');
  var q = '\\<' + m[0] + '\\>';
  histPush('/', q);
  S = makeState(q, true);
  hop({ line: pos.line, off: m.index }, dir, count);
}

/* ------------------------------------------------------------ the owner */

var owner = null;  // {key(tok) -> bool, hide(why)} holding mode 'command'

function take(o) {
  if (owner && owner !== o) {
    var prev = owner;
    owner = null;
    prev.hide('replaced');
  }
  owner = o;
  if (!VH.mode.is('command')) VH.mode.set('command');
}

function release(o) {
  if (owner !== o) return;
  owner = null;
  if (VH.mode.is('command')) VH.mode.set('normal');
}

function closeOwner(o, why) {
  o.hide(why);
  release(o);
}

// When focus leaves an owner's element for something else on the page, the
// owner closes; the window losing focus (switching apps) is not that.
function closeOnBlur(o, el) {
  el.addEventListener('blur', function () {
    setTimeout(function () {
      if (owner === o && document.hasFocus() && document.activeElement !== el) closeOwner(o, 'cancel');
    }, 0);
  });
}

/* ---------------------------------------------------------- command line */

var cl = null;  // {box, prompt, input, wild, msg, kind, hist, comp}
var msgTimer = 0;

function clBuild() {
  var input = h('input', { type: 'text', 'class': 'vh-cmd-input', spellcheck: 'false', autocomplete: 'off',
                          autocapitalize: 'off', 'aria-label': 'Command line' });
  cl = {
    input: input,
    prompt: h('span', { 'class': 'vh-cmd-prompt', 'aria-hidden': 'true' }),
    wild: h('div', { 'class': 'vh-wild', role: 'listbox', hidden: true }),
    msg: h('div', { 'class': 'vh-cmdmsg', role: 'status', 'aria-live': 'polite', hidden: true }),
    kind: ':', hist: null, comp: null
  };
  cl.box = h('div', { 'class': 'vh-cmdline', hidden: true }, [cl.prompt, input]);
  VH.ui.layer.appendChild(cl.wild);
  VH.ui.layer.appendChild(cl.box);
  VH.ui.layer.appendChild(cl.msg);
  input.addEventListener('input', function () {
    cl.hist = null;
    cl.comp = null;
    wildHide();
    if (live) liveUpdate();
  });
  closeOnBlur(cmdOwner, input);
}

var cmdOwner = {
  key: function (tok) {
    switch (tok) {
      case '<CR>': case '<S-CR>': case '<C-j>': clSubmit(); return true;
      case '<Esc>': closeOwner(cmdOwner, 'cancel'); return true;
      case '<BS>':
        if (cl.input.value) return false;  // an ordinary backspace
        closeOwner(cmdOwner, 'cancel');
        return true;
      case '<Tab>': if (cl.kind === ':') complete(1); return true;
      case '<S-Tab>': if (cl.kind === ':') complete(-1); return true;
      case '<Up>': history(-1, true); return true;
      case '<Down>': history(1, true); return true;
      case '<C-p>': history(-1, false); return true;
      case '<C-n>': history(1, false); return true;
      case '<C-u>': killToStart(cl.input); return true;
    }
    return false;
  },
  hide: function (why) {
    cl.box.hidden = true;
    cl.comp = null;
    cl.hist = null;
    wildHide();
    if (document.activeElement === cl.input) cl.input.blur();
    if (live && why !== 'submit') liveCancel();
  }
};

function clOpen(kind) {
  hideMsg();
  take(cmdOwner);
  cl.kind = kind;
  cl.prompt.textContent = kind;
  cl.input.value = '';
  cl.hist = null;
  cl.comp = null;
  cl.box.hidden = false;
  // Before the focus: focusing the input moves the document selection into it,
  // and the search starts from the caret.
  if (kind !== ':') liveStart(kind === '/' ? 1 : -1);
  cl.input.focus({ preventScroll: true });
}

// Closing first, then running, lets a command open another mode.
function clSubmit() {
  var text = cl.input.value;
  if (cl.kind === ':') {
    closeOwner(cmdOwner, 'submit');
    if (text.trim()) histPush(':', text);
    return runCommand(text);
  }
  var L = live;
  live = null;
  closeOwner(cmdOwner, 'submit');
  submitSearch(text, L);
}

// Vim's messages for names that resolve to nothing, instead of core's toast.
// The resolution mirrors VH.commands.run: exact, lowercase (:W, :Q, :Wq), then
// a unique prefix.
function runCommand(text) {
  var s = String(text).replace(/^[\s:]+/, '').trim();
  if (!s) return;
  var m = /^([A-Za-z][\w-]*)/.exec(s);
  if (m) {
    var names = VH.commands.list().map(function (c) { return c.name; });
    var name = m[1];
    if (names.indexOf(name) < 0 && names.indexOf(name.toLowerCase()) < 0) {
      var hits = names.filter(function (n) { return n.indexOf(name) === 0; });
      if (hits.length > 1) return say('E464: Ambiguous use of user-defined command: ' + s, 'error');
      if (!hits.length) return say('E492: Not an editor command: ' + s, 'error');
    }
  } else if (!/^(?:\d+|\$)$/.test(s)) {
    return say('E492: Not an editor command: ' + s, 'error');
  }
  VH.commands.run(s);
}

function setValue(v) {
  cl.input.value = v;
  cl.input.setSelectionRange(v.length, v.length);
  if (live) liveUpdate();
}

function killToStart(input) {
  var p = input.selectionStart == null ? input.value.length : input.selectionStart;
  input.setRangeText('', 0, p, 'start');
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

/* History: like vim, <Up>/<Down> recall entries that start with what was typed
 * before the first <Up>; <C-p>/<C-n> recall any. ':' and search keep separate
 * lists, global across documents, newest last. */

function histKey(kind) { return kind === ':' ? 'cmdHistory' : 'searchHistory'; }

function histList(kind) {
  var l = VH.prefs.get(histKey(kind));
  return Array.isArray(l) ? l.filter(function (x) { return typeof x === 'string'; }) : [];
}

function histPush(kind, text) {
  if (!text) return;
  var l = histList(kind).filter(function (x) { return x !== text; });
  l.push(text);
  VH.prefs.set(histKey(kind), l.slice(-HIST_MAX));
}

function history(dir, prefixed) {
  if (!cl.hist) {
    var list = histList(cl.kind);
    cl.hist = { list: list, i: list.length, base: cl.input.value };
  }
  var H = cl.hist;
  var base = prefixed ? H.base : '';
  for (var j = H.i + dir; j >= 0 && j < H.list.length; j += dir) {
    if (H.list[j].indexOf(base) === 0) {
      H.i = j;
      return setValue(H.list[j]);
    }
  }
  if (dir > 0 && H.i !== H.list.length) {
    H.i = H.list.length;
    setValue(H.base);  // past the newest entry: back to what was typed
  }
}

/* Tab completion of ':' command names, wildmode=full: the first Tab inserts the
 * first match at once, each further Tab the next, and after the last one the
 * text as typed comes back before the cycle starts again. */

function complete(dir) {
  var C = cl.comp;
  if (!C) {
    var m = /^(\s*:*\s*)([A-Za-z][\w-]*)?$/.exec(cl.input.value);
    if (!m) return;  // past the command name: nothing to complete
    var word = m[2] || '';
    var names = VH.commands.list().map(function (c) { return c.name; });
    var hits = names.filter(function (n) { return n.indexOf(word) === 0; });
    if (!hits.length) hits = names.filter(function (n) { return n.toLowerCase().indexOf(word.toLowerCase()) === 0; });
    if (!hits.length) return;
    C = cl.comp = { lead: m[1], word: word, hits: hits, p: hits.length };
  }
  var n = C.hits.length;
  C.p = (C.p + dir + n + 1) % (n + 1);  // position n is the text as typed
  cl.input.value = C.lead + (C.p === n ? C.word : C.hits[C.p]);
  cl.input.setSelectionRange(cl.input.value.length, cl.input.value.length);
  wildShow(C);
}

function wildShow(C) {
  if (C.hits.length < 2) return wildHide();
  cl.wild.textContent = '';
  C.hits.forEach(function (name, i) {
    cl.wild.appendChild(h('div', { 'class': 'vh-wild-item' + (i === C.p ? ' vh-sel' : ''), role: 'option', text: name }));
  });
  cl.wild.hidden = false;
  var sel = cl.wild.children[C.p];
  if (sel) scrollWithin(cl.wild, sel);
}

function wildHide() {
  if (cl && !cl.wild.hidden) { cl.wild.hidden = true; cl.wild.textContent = ''; }
}

/* Messages (E492, E486, wrap warnings) take the command line's strip for a few
 * seconds, as vim prints them in its command-line row. */

function say(text, kind) {
  if (!cl) return;
  cl.msg.textContent = text;
  cl.msg.className = 'vh-cmdmsg' + (kind ? ' vh-cmdmsg-' + kind : '');
  cl.msg.hidden = false;
  clearTimeout(msgTimer);
  msgTimer = setTimeout(hideMsg, 4000);
}

function hideMsg() {
  clearTimeout(msgTimer);
  if (cl) cl.msg.hidden = true;
}

/* ----------------------------------------------------------------- pickers
 * fzf-style: space-separated terms must all match; a plain term is fuzzy (its
 * letters in order), 'term is exact, ^term a prefix, term$ a suffix, !term
 * excludes; smartcase per term. Ranking follows fzf's v1 scorer: points per
 * matched letter, bonuses at word starts and for runs, penalties for gaps;
 * ties go to the shorter line, then document order.
 */

var pk = null;  // {kind, box, input, list, count, items, results, sel, top, rows, onDown}
var ROW_H = 26;

var CW = 0, CN = 1, CL = 2, CU = 3, CD = 4;  // white, punctuation, lower, upper, digit

function charClass(c) {
  if (c === undefined || /\s/.test(c)) return CW;
  if (c >= 'a' && c <= 'z') return CL;
  if (c >= 'A' && c <= 'Z') return CU;
  if (c >= '0' && c <= '9') return CD;
  if (/\p{L}/u.test(c)) return c === c.toLowerCase() ? CL : CU;
  return CN;
}

function bonusAt(prev, cur) {
  if (cur >= CL) {
    if (prev === CW) return 10;
    if (prev === CN) return 8;
    if ((prev === CL && cur === CU) || (prev !== CD && cur === CD)) return 7;
    return 0;
  }
  return cur === CW ? 10 : 8;
}

// fzf v1 tried from a few starts: the leftmost occurrence of the first letter,
// then each later one that begins a word, keeping the best score. Plain v1
// (leftmost only) ranks "t...i...e" scattered over "the ... with ... the" above a
// real "tie-breaker" later in the line; fzf's v2 avoids that with a full
// alignment, which word starts approximate at a fraction of the cost.
function fuzzy(hay, orig, pat) {
  var best = null;
  var tries = 0;
  for (var s = hay.indexOf(pat[0]); s >= 0 && tries < 16; s = hay.indexOf(pat[0], s + 1)) {
    if (best && s > 0 && bonusAt(charClass(orig[s - 1]), charClass(orig[s])) < 7) continue;
    tries++;
    var r = fuzzyFrom(hay, orig, pat, s);
    if (!r) break;  // nothing from here means nothing further right either
    if (!best || r.score > best.score) best = r;
  }
  return best;
}

// One v1 pass from `from`: the letters in order, then the shortest window
// ending where they end, scored left to right.
function fuzzyFrom(hay, orig, pat, from) {
  var n = pat.length;
  var pi = 0, start = -1, end = -1, i;
  for (i = from; i < hay.length; i++) {
    if (hay[i] !== pat[pi]) continue;
    if (pi === 0) start = i;
    if (++pi === n) { end = i; break; }
  }
  if (end < 0) return null;
  pi = n - 1;
  for (i = end; i >= start; i--) {
    if (hay[i] === pat[pi] && --pi < 0) { start = i; break; }
  }
  var score = 0, pos = [], inGap = false, consec = 0, first = 0;
  var prev = start > 0 ? charClass(orig[start - 1]) : CW;
  pi = 0;
  for (i = start; i <= end; i++) {
    var c = charClass(orig[i]);
    if (hay[i] === pat[pi]) {
      var b = bonusAt(prev, c);
      if (consec === 0) first = b;
      else {
        if (b >= 8 && b > first) first = b;
        b = Math.max(b, first, 4);
      }
      score += 16 + (pi === 0 ? 2 * b : b);
      pos.push(i);
      inGap = false;
      consec++;
      pi++;
    } else {
      score += inGap ? -1 : -3;
      inGap = true;
      consec = 0;
      first = 0;
    }
    prev = c;
  }
  return { score: score, pos: pos };
}

function exact(hay, orig, t) {
  var s = t.s, at;
  if (t.pre && t.suf) at = hay === s ? 0 : -1;
  else if (t.pre) at = hay.indexOf(s) === 0 ? 0 : -1;
  else if (t.suf) at = hay.length >= s.length && hay.slice(-s.length) === s ? hay.length - s.length : -1;
  else at = hay.indexOf(s);
  if (at < 0) return null;
  var pos = [];
  for (var i = 0; i < s.length; i++) pos.push(at + i);
  var b = bonusAt(at > 0 ? charClass(orig[at - 1]) : CW, charClass(orig[at]));
  return { score: 16 * s.length + 2 * b + 4 * (s.length - 1), pos: pos };
}

// Lowercase without changing length, so match positions index the original.
function fold(s) {
  var l = s.toLowerCase();
  if (l.length === s.length) return l;
  return s.split('').map(function (c) { var x = c.toLowerCase(); return x.length === 1 ? x : c; }).join('');
}

function parseTerms(q) {
  return q.split(/\s+/).filter(Boolean).map(function (w) {
    var t = { s: w, neg: false, ex: false, pre: false, suf: false, ic: false };
    if (t.s[0] === '!') { t.neg = t.ex = true; t.s = t.s.slice(1); }
    if (t.s[0] === "'") { t.ex = true; t.s = t.s.slice(1); }
    if (t.s[0] === '^') { t.pre = t.ex = true; t.s = t.s.slice(1); }
    if (t.s.length > 1 && t.s[t.s.length - 1] === '$') { t.suf = t.ex = true; t.s = t.s.slice(0, -1); }
    t.ic = t.s === t.s.toLowerCase();
    if (t.ic) t.s = fold(t.s);
    return t;
  }).filter(function (t) { return t.s; });
}

function matchItem(it, terms) {
  var score = 0, pos = [];
  for (var i = 0; i < terms.length; i++) {
    var t = terms[i];
    var hay = t.ic ? it.low : it.text;
    var r = t.ex ? exact(hay, it.text, t) : fuzzy(hay, it.text, t.s);
    if (t.neg) { if (r) return null; continue; }
    if (!r) return null;
    score += r.score;
    pos = pos.concat(r.pos);
  }
  return { it: it, score: score, pos: pos };
}

function lineItems() {
  var ix = index(), out = [];
  for (var n = 1; n <= ix.count; n++) {
    var text = VH.text.norm(ix.lines[n - 1].text);
    if (text) out.push({ line: n, text: text, low: fold(text) });
  }
  return out;
}

function headings() {
  if (VH.lines.headings) {
    try { return VH.lines.headings(); } catch (err) { VH.error('lines.headings', err); }
  }
  var ix = index(), out = [];
  for (var n = 1; n <= ix.count; n++) {
    var el = ix.lines[n - 1].el;
    var m = el && /^H([1-6])$/.exec(el.tagName);
    if (m) out.push({ line: n, level: +m[1], text: VH.text.norm(ix.lines[n - 1].text) });
  }
  return out;
}

// The heading whose section holds `line`: the last one at or above it.
function sectionOf(hs, line) {
  var cur = -1;
  for (var i = 0; i < hs.length && hs[i].line <= line; i++) cur = i;
  return cur;
}

var pkOwner = {
  key: function (tok) {
    switch (tok) {
      case '<CR>': case '<S-CR>': pkAccept(); return true;
      case '<Esc>': closeOwner(pkOwner, 'cancel'); return true;
      case '<Down>': case '<C-j>': case '<C-n>': pkMove(1); return true;
      case '<Up>': case '<C-k>': case '<C-p>': pkMove(-1); return true;
      case '<PageDown>': pkMove(pk.rows); return true;
      case '<PageUp>': pkMove(-pk.rows); return true;
      case '<Tab>': case '<S-Tab>': return true;  // focus stays in the picker
      case '<C-u>': killToStart(pk.input); return true;
    }
    return false;
  },
  hide: function () {
    if (!pk) return;
    document.removeEventListener('mousedown', pk.onDown, true);
    pk.box.remove();
    pk = null;
  }
};

function pkOpen(kind) {
  hideMsg();
  var cur = VH.cursor ? VH.cursor.get() : 0;
  var items, pre = 0;
  if (kind === 'lines') {
    items = lineItems();
    while (pre < items.length - 1 && items[pre].line < cur) pre++;
  } else {
    items = headings().map(function (x) { return { line: x.line, level: x.level, text: x.text, low: fold(x.text) }; });
    pre = Math.max(0, sectionOf(items, cur));
  }
  var title = kind === 'lines' ? 'Buffer Lines' : 'Headings';
  var input = h('input', { type: 'text', 'class': 'vh-pk-input', spellcheck: 'false', autocomplete: 'off',
                          autocapitalize: 'off', 'aria-label': title });
  var count = h('span', { 'class': 'vh-pk-count' });
  var list = h('div', { 'class': 'vh-pk-list', role: 'listbox' });
  var box = h('div', { 'class': 'vh-pk', role: 'dialog', 'aria-label': title, 'data-kind': kind }, [
    h('div', { 'class': 'vh-pk-bar' }, [h('span', { 'class': 'vh-pk-title', text: title }), count]),
    h('div', { 'class': 'vh-pk-prompt' }, [h('span', { 'class': 'vh-pk-caret', text: '>' }), input]),
    list
  ]);
  var rows = Math.max(4, Math.min(14, Math.floor(window.innerHeight * 0.55 / ROW_H)));
  list.style.height = rows * ROW_H + 'px';
  var p = { kind: kind, box: box, input: input, list: list, count: count, items: items, results: [],
            sel: 0, top: 0, rows: rows, pre: pre };
  p.onDown = function (e) { if (pk === p && !box.contains(e.target)) closeOwner(pkOwner, 'cancel'); };
  input.addEventListener('input', pkFilter);
  box.addEventListener('mousedown', function (e) { if (e.target !== input) e.preventDefault(); });  // focus stays in the input
  list.addEventListener('click', function (e) {
    var row = e.target.closest('.vh-pk-row');
    if (row) { p.sel = +row.getAttribute('data-i'); pkAccept(); }
  });
  list.addEventListener('wheel', function (e) {
    e.preventDefault();
    pkScroll(p.top + (e.deltaY > 0 ? 3 : -3));
  }, { passive: false });
  VH.ui.layer.appendChild(box);
  pk = p;
  take(pkOwner);
  document.addEventListener('mousedown', p.onDown, true);
  input.focus({ preventScroll: true });
  pkFilter();
}

function pkFilter() {
  var terms = parseTerms(pk.input.value);
  if (!terms.length) {
    pk.results = pk.items.map(function (it) { return { it: it, score: 0, pos: null }; });
    pk.sel = Math.min(pk.pre, pk.results.length - 1);
    pk.top = pk.sel - (pk.rows >> 1);
  } else {
    var out = [];
    for (var i = 0; i < pk.items.length; i++) {
      var r = matchItem(pk.items[i], terms);
      if (r) out.push(r);
    }
    out.sort(function (a, b) {
      return (b.score - a.score) || (a.it.text.length - b.it.text.length) || (a.it.line - b.it.line);
    });
    pk.results = out;
    pk.sel = 0;
    pk.top = 0;
  }
  pkScroll(pk.top);
}

function pkMove(d) {
  if (!pk.results.length) return;
  pk.sel = Math.max(0, Math.min(pk.results.length - 1, pk.sel + d));
  var top = pk.top;
  if (pk.sel < top) top = pk.sel;
  if (pk.sel >= top + pk.rows) top = pk.sel - pk.rows + 1;
  pkScroll(top);
}

function pkScroll(top) {
  pk.top = Math.max(0, Math.min(top, pk.results.length - pk.rows));
  pkRender();
}

// Only the rows in view exist, so a 2,000-line document renders as fast as a
// ten-line one.
function pkRender() {
  pk.count.textContent = pk.results.length + '/' + pk.items.length;
  pk.list.textContent = '';
  var end = Math.min(pk.results.length, pk.top + pk.rows);
  for (var i = pk.top; i < end; i++) {
    var r = pk.results[i];
    var lead = pk.kind === 'lines'
      ? h('span', { 'class': 'vh-pk-ln', text: String(r.it.line) })
      : h('span', { 'class': 'vh-pk-lv', text: 'H' + r.it.level });
    var tx = h('span', { 'class': 'vh-pk-tx' });
    if (pk.kind !== 'lines') tx.style.paddingLeft = (r.it.level - 1) * 12 + 'px';
    marked(tx, r.it.text, r.pos);
    pk.list.appendChild(h('div', { 'class': 'vh-pk-row' + (i === pk.sel ? ' vh-sel' : ''), role: 'option',
                                   'data-i': String(i), 'aria-selected': i === pk.sel ? 'true' : 'false' },
                          [lead, tx]));
  }
  if (!pk.results.length) pk.list.appendChild(h('div', { 'class': 'vh-pk-empty', text: 'No matches' }));
}

// The text with matched characters in <mark>; a long line whose first match is
// far in starts just before it, behind an ellipsis.
function marked(el, text, pos) {
  var cut = pos && pos.length && pos[0] > 48 ? pos[0] - 24 : 0;
  var hits = new Set((pos || []).map(function (x) { return x - cut; }));
  var s = text.slice(cut);
  if (cut) el.appendChild(document.createTextNode('\u2026'));
  var run = '', on = false;
  function flush() {
    if (!run) return;
    el.appendChild(on ? h('mark', { 'class': 'vh-pk-hit', text: run }) : document.createTextNode(run));
    run = '';
  }
  for (var i = 0; i < s.length; i++) {
    var hit = hits.has(i);
    if (hit !== on) { flush(); on = hit; }
    run += s[i];
  }
  flush();
}

function pkAccept() {
  var r = pk.results[pk.sel];
  closeOwner(pkOwner, 'submit');
  if (r) jumpTo(r.it.line, true);
}

function jumpTo(line, jump) {
  revealFold(line);
  VH.cursor.set(line, { jump: !!jump });
}

/* ----------------------------------------------------------------- outline
 * Like the owner's outline.nvim: on the right, opens without taking focus,
 * follows the cursor (the current section marked), click jumps. <leader>cS
 * focuses it: j/k move and jump as they go (auto_jump), <CR> jumps and gives
 * focus back, o jumps and keeps it, <S-CR> jumps and closes, q/<Esc> give focus
 * back. Focused, it owns mode 'command' (see the top of the file): printable
 * keys then reach its list's own keydown listener, everything else the router.
 * The comments sidebar (piece F) takes mode 'panel'; the outline closes then,
 * so the two never share the right edge.
 */

var ol = { box: null, list: null, items: [], rows: [], open: false, focused: false,
           cur: -1, sel: -1, sig: '', jumped: false, lastG: 0, pad: 0 };

function olBuild() {
  ol.list = h('div', { 'class': 'vh-ol-list', role: 'listbox', tabindex: '-1', 'aria-label': 'Outline' });
  ol.box = h('aside', { 'class': 'vh-ol', hidden: true, 'aria-label': 'Outline' }, [
    h('div', { 'class': 'vh-ol-head' }, [
      h('span', { 'class': 'vh-ol-title', text: 'Outline' }),
      h('button', { type: 'button', 'class': 'vh-ol-close', 'aria-label': 'Close outline', title: 'Close (<leader>cs)',
                    text: '\u00d7', onclick: olClose })
    ]),
    ol.list
  ]);
  VH.ui.layer.appendChild(ol.box);
  ol.box.addEventListener('mousedown', function (e) { if (!ol.focused) e.preventDefault(); });  // a click jumps, focus stays on the page
  ol.list.addEventListener('keydown', olKeydown);
  closeOnBlur(olOwner, ol.list);
}

var olOwner = {
  key: function (tok) {
    switch (tok) {
      case '<CR>': olJump(ol.sel, 'return'); return true;
      case '<S-CR>': olJump(ol.sel, 'close'); return true;
      case '<Esc>': closeOwner(olOwner, 'cancel'); return true;
      case '<Down>': case '<C-j>': case '<C-n>': olMove(1); return true;
      case '<Up>': case '<C-k>': case '<C-p>': olMove(-1); return true;
      case '<Tab>': case '<S-Tab>': return true;
    }
    return false;
  },
  hide: function () {
    ol.focused = false;
    ol.box.classList.remove('vh-focus');
    olMarkSel();
    if (document.activeElement === ol.list) ol.list.blur();
  }
};

// Printable keys while focused (core passes them through in 'command' mode).
function olKeydown(e) {
  if (!ol.focused || e.ctrlKey || e.metaKey || e.altKey) return;
  var k = e.key;
  var now = Date.now();
  if (k === 'j') olMove(1);
  else if (k === 'k') olMove(-1);
  else if (k === 'G') olMove(ol.items.length);
  else if (k === 'g' && now - ol.lastG < VH.keys.timeout) olMove(-ol.items.length);
  else if (k === 'o') olJump(ol.sel, 'keep');
  else if (k === 'q') closeOwner(olOwner, 'cancel');
  else if (k !== 'g') return;
  ol.lastG = k === 'g' && now - ol.lastG >= VH.keys.timeout ? now : 0;
  e.preventDefault();
}

function olOpen(focus) {
  if (!ol.box) olBuild();
  if (!ol.open) {
    ol.open = true;
    ol.box.hidden = false;
    ol.sig = '';
    olRender();
    olFit();
    VH.emit('outline', { open: true });
  }
  if (focus) olFocus();
}

function olClose() {
  if (!ol.open) return;
  if (ol.focused) closeOwner(olOwner, 'cancel');
  ol.open = false;
  ol.box.hidden = true;
  olFit();
  VH.emit('outline', { open: false });
}

function olFocus() {
  ol.focused = true;
  ol.jumped = false;
  ol.sel = Math.max(0, ol.cur);
  take(olOwner);
  ol.box.classList.add('vh-focus');
  olMarkSel();
  ol.list.focus({ preventScroll: true });
}

// The outline takes room on the right only when the text column would run
// under it: padding on <html> moves the column left just enough (body keeps its
// width, so nothing re-wraps unless the window is narrow). Moving the column
// does not resize <body>, so a resize event tells every module that places
// things over the text (gutter, comment marks) to measure again.
// The text column makes room for the outline only while it keeps a readable
// width; on a phone the outline lies over the text instead (as the comments
// sidebar does) rather than squeezing it to a word or two per line.
var OL_MIN_TEXT = 480;

function olFit() {
  var want = 0;
  var need = ol.open ? ol.box.getBoundingClientRect().width + 12 : 0;
  if (ol.open && html.clientWidth - need >= OL_MIN_TEXT) {
    html.style.paddingRight = '0px';
    var W = html.clientWidth;
    var gap = W - document.body.getBoundingClientRect().right;
    if (gap < need) {
      want = Math.min(need, 2 * need - 2 * gap);  // a centred column moves by half the padding
      html.style.paddingRight = want + 'px';
      gap = W - document.body.getBoundingClientRect().right;
      if (gap < need) want = Math.min(need, want + need - gap);
    }
  }
  html.style.paddingRight = want ? Math.ceil(want) + 'px' : '';
  html.classList.toggle('vh-outline-open', ol.open);
  if (want !== ol.pad) {
    ol.pad = want;
    window.dispatchEvent(new Event('resize'));
  }
}

function olRender() {
  var hs = headings();
  var sig = hs.map(function (x) { return x.line + ':' + x.level + ':' + x.text; }).join('\n');
  if (sig !== ol.sig) {
    ol.sig = sig;
    ol.items = hs;
    var min = hs.reduce(function (m, x) { return Math.min(m, x.level); }, 6);
    ol.list.textContent = '';
    ol.rows = hs.map(function (x, i) {
      var row = h('div', { 'class': 'vh-ol-item', role: 'option', 'data-level': String(x.level), title: x.text }, [
        h('span', { 'class': 'vh-ol-text', text: x.text }),
        h('span', { 'class': 'vh-ol-ln', text: String(x.line) })
      ]);
      row.style.paddingLeft = 10 + (x.level - min) * 12 + 'px';
      row.addEventListener('click', function () { olJump(i, ol.focused ? 'return' : 'click'); });
      ol.list.appendChild(row);
      return row;
    });
    if (!hs.length) ol.list.appendChild(h('div', { 'class': 'vh-ol-empty', text: 'No headings' }));
    ol.cur = -1;
    ol.sel = Math.min(ol.sel, hs.length - 1);
    olMarkSel();
  }
  olFollow();
}

function olFollow() {
  if (!ol.open) return;
  var cur = sectionOf(ol.items, VH.cursor ? VH.cursor.get() : 0);
  if (cur === ol.cur) return;
  if (ol.rows[ol.cur]) ol.rows[ol.cur].classList.remove('vh-cur');
  ol.cur = cur;
  if (ol.rows[cur]) {
    ol.rows[cur].classList.add('vh-cur');
    if (!ol.focused) scrollWithin(ol.list, ol.rows[cur]);
  }
}

function olMarkSel() {
  ol.rows.forEach(function (row, i) { row.classList.toggle('vh-sel', ol.focused && i === ol.sel); });
}

function olMove(d) {
  if (!ol.items.length) return;
  ol.sel = Math.max(0, Math.min(ol.items.length - 1, ol.sel + d));
  olMarkSel();
  scrollWithin(ol.list, ol.rows[ol.sel]);
  // auto_jump: the page follows the selection. The first move of a focus
  // session records the jump, so Ctrl-o returns to where reading left off.
  var line = ol.items[ol.sel].line;
  revealFold(line);
  VH.cursor.set(line, { jump: !ol.jumped });
  ol.jumped = true;
}

// how: 'click' (unfocused), 'return' (jump, focus back to the page), 'keep'
// (jump, stay focused), 'close' (jump, close the outline).
function olJump(i, how) {
  var item = ol.items[i];
  if (!item) return;
  revealFold(item.line);
  VH.cursor.set(item.line, { jump: !(ol.focused && ol.jumped) });
  if (ol.focused) ol.jumped = true;
  if (how === 'return') closeOwner(olOwner, 'submit');
  else if (how === 'close') olClose();
}

function scrollWithin(box, row) {
  if (!row) return;
  var top = row.offsetTop, bottom = top + row.offsetHeight;
  if (top < box.scrollTop) box.scrollTop = top;
  else if (bottom > box.scrollTop + box.clientHeight) box.scrollTop = bottom - box.clientHeight;
}

/* ------------------------------------------------------------------ events */

var refreshRaf = 0;

// Geometry changed, and maybe the lines (lines.js splitting a <pre>, a fold
// trailer): the index is rebuilt the next time something reads it, and
// whatever is on screen is redone once per frame.
VH.on('layout', function () {
  idxDirty = true;
  if (refreshRaf || !(S.shown || ol.open)) return;
  refreshRaf = requestAnimationFrame(function () {
    refreshRaf = 0;
    if (S.shown && !live) { ensure(S); paint(S); emitSearch(S); }
    if (ol.open) olRender();
  });
});

// vim-noh: highlights go once the cursor moves by anything but n, N, * or #
// (which set `moving`). While a search line is open the cursor only moves
// because the preview scrolled it, so that does not count. Such a move also
// takes the cursor off its match for good: the next / or n starts from the
// cursor's line (origin), not from the old match, so `gg` then `/x` finds an
// x on line 1 even when the last search landed there.
VH.on('cursor', function (e) {
  if (ol.open) olFollow();
  if (moving || live || e.line === e.prev) return;
  S.cur = -1;
  clearHl();
});

VH.on('escape', function () { clearHl(); hideMsg(); });

VH.on('close', function () {
  if (owner) closeOwner(owner, 'cancel');
  olClose();
});

VH.on('mode', function (e) {
  if (e.from === 'command' && e.to !== 'command' && owner) {
    var o = owner;
    owner = null;
    o.hide('mode');
  }
  if (e.to === 'panel') olClose();
});

VH.init(function () {
  clBuild();
  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', function (e) { if (ol.open && e.isTrusted) olFit(); });
});

/* ----------------------------------------------------------------- keymaps */

VH.keys.map('normal', ':', function () { clOpen(':'); }, { desc: 'command line', group: 'search' });
VH.keys.map('normal', '/', function () { clOpen('/'); }, { desc: 'search forward', group: 'search' });
VH.keys.map('normal', '?', function () { clOpen('?'); }, { desc: 'search backward', group: 'search' });
VH.keys.map('normal', 'n', function (c) { step(1, c); }, { desc: 'next match (always forward)', group: 'search' });
VH.keys.map('normal', 'N', function (c) { step(-1, c); }, { desc: 'previous match (always backward)', group: 'search' });
VH.keys.map('normal', '*', function (c) { star(1, c); }, { desc: 'search the word at the caret forward', group: 'search' });
VH.keys.map('normal', '#', function (c) { star(-1, c); }, { desc: 'search the word at the caret backward', group: 'search' });
VH.keys.map('normal', '<leader>sb', function () { pkOpen('lines'); }, { desc: 'fuzzy-find a line', group: 'search' });
VH.keys.map('normal', '<leader>ss', function () { pkOpen('headings'); }, { desc: 'fuzzy-find a heading', group: 'search' });
VH.keys.map('normal', '<leader>cs', function () { if (ol.open) olClose(); else olOpen(false); },
  { desc: 'toggle the outline', group: 'search' });
VH.keys.map('normal', '<leader>cS', function () { olOpen(true); }, { desc: 'focus the outline', group: 'search' });

// Command mode: these tokens go to whichever UI owns the mode (see the top).
var ROUTES = {
  '<CR>': 'run the command / jump to the match or item',
  '<S-CR>': 'jump (in the outline: jump and close it)',
  '<Esc>': 'cancel and go back to normal',
  '<BS>': 'on an empty command line: cancel',
  '<Tab>': 'complete a command name (again: next match)',
  '<S-Tab>': 'previous completion',
  '<Up>': 'older history entry / previous item',
  '<Down>': 'newer history entry / next item',
  '<C-p>': 'older history entry / previous item',
  '<C-n>': 'newer history entry / next item',
  '<C-k>': 'previous item',
  '<C-j>': 'next item (on the command line: run)',
  '<C-u>': 'delete to the start of the input',
  '<PageUp>': 'a page of items up',
  '<PageDown>': 'a page of items down'
};
Object.keys(ROUTES).forEach(function (tok) {
  VH.keys.map('command', tok, function () { return owner ? owner.key(tok) !== false : false; },
    { desc: ROUTES[tok], group: 'command line' });
});

/* ---------------------------------------------------------------- commands */

VH.commands.add('noh', function () { clearHl(); }, 'clear the search highlight');
// The owner's nvim maps :Wq and :WQ to :wq; core already lowercases names.
VH.commands.add('wq', function () { runCommand('w'); runCommand('q'); }, 'copy all comments, then close (:w, :q)');

/* -------------------------------------------------------------- VH.search (+) */

VH.search = {
  state: function () {
    var on = S.shown && S.M.line.length > 0;
    return { query: S.query, index: on ? S.cur + 1 : 0, total: S.M.line.length, shown: S.shown,
             highlightApi: HAS_HL };
  },
  clear: clearHl,
  outline: function () { return { open: ol.open, focused: ol.focused, current: ol.cur, selected: ol.sel }; }
};
