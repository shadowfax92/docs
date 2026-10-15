/* motions.js -- the cursor, motions, scrolling, marks and the jumplist (piece C2).
 *
 * The cursor is one gutter line (VH.lines numbering, 1-based), never a column:
 * a reading cursor. Everything here moves it, scrolls around it, or remembers it.
 *
 * Contract (PLAN.md "Keymap"; items marked (+) are additive):
 *   VH.cursor.line() / get()      the cursor line; 0 when the page has no lines
 *   VH.cursor.set(n, {scroll, caret, jump, at(+)}) -> n
 *     clamps n (Infinity = last line), opens folds hiding it (VH.folds.reveal),
 *     moves .vh-cursor and the cursorline, scrolls, emits 'cursor' {line, prev}.
 *     scroll: 'auto' (default) | 'center' | 'top' | 'bottom' | 'none' (false = 'none')
 *     caret:  a Range inside the line (a search landing); VH.cursor.caret() returns
 *             it until the cursor moves again, so visual mode can start there
 *     jump:   record the line we leave in the jumplist (search, ]c, sidebars, gd...)
 *     at:     (+) put the line's top at this viewport y (restoring a jump's view)
 *   VH.cursor.caret() -> Range | null
 *   VH.marks.all() -> [{mark, line, text}] / get(ch) / at(line) -> [ch] / set(ch, n)
 *     / del(chars) / clear(); 'marks' {} after every change; persisted per document
 *     through VH.store ('marks'), reattached by line text after the document changes
 *   VH.jumps(+) list() / index() / back(count) / forward(count)
 *   listens to core's 'goto' {line} (':{n}', ':$')
 *
 * Scrolling model. The page scrolls in pixels and lines have any height, so the
 * vim notions are mapped like this (smoothscroll on, as in LazyVim):
 *   view   = the viewport above the fixed status line; a "row" = body line-height
 *   band   = the view minus a scrolloff of SO_ROWS rows at each edge; the margin
 *            drops away at the top and bottom of the document, as in vim
 *   'auto' = the least scroll that puts the line inside the band, unless that
 *            is more than half a view, then centre it (vim does the same when the
 *            cursor leaves the screen by more than half of it)
 *   Ctrl-d/u  scroll half a view; the cursor keeps its screen row, so it moves by
 *            as many lines as scrolled past it. The row is kept between presses
 *            (`sticky`), which is what makes Ctrl-d Ctrl-d Ctrl-u Ctrl-u land on
 *            the same line and scroll it started from.
 *   wheel, trackpad, Ctrl-e/y, Ctrl-f/b move the view; the cursor only moves when
 *            its line leaves the band (margin included), to the nearest line inside
 *            it, so it never sits under or flush against the status line.
 *
 * Jumps follow vim with LazyVim's jumpoptions=view: an entry remembers the line
 * and where it sat on screen, so Ctrl-o restores the view, not just the line.
 *
 * Line model fallbacks: the wave-1 VH.lines has no hidden/next/headings and no
 * VH.folds; the adapters below use them when present and fall back to "nothing is
 * folded" and a scan of h1-h6 line elements otherwise.
 */

var SO_ROWS = 2;           // scrolloff, in rows: "a couple of lines" of context
var STATUS_FALLBACK = 28;  // status line height when chrome has not drawn it (its contract)
var JUMPS_MAX = 100;       // vim's jumplist length
var LETTERS = 'abcdefghijklmnopqrstuvwxyz';

var cur = 0;               // the cursor line
var curEl = null;          // the element carrying .vh-cursor
var caretRange = null;     // VH.cursor.caret()
var sticky = null;         // {line, y, sy}: the screen row Ctrl-d/Ctrl-u keep
var bar = null;            // the cursorline overlay in VH.ui.layer
var paintRaf = 0;

/* ------------------------------------------------------ line model adapters */

function count() { return VH.lines.count(); }
function el(n) { return VH.lines.el(n); }

function hidden(n) {
  return VH.lines.hidden ? !!VH.lines.hidden(n) : false;
}

// The adjacent visible line in direction dir (+1 / -1), or n at either end.
// C1's next(n, step) is called one step at a time on purpose: that is correct
// whether `step` is read as a count or only as a direction.
function step(n, dir) {
  var c = count();
  if (VH.lines.next) {
    var m = VH.lines.next(n, dir);
    return (typeof m === 'number' && m >= 1 && m <= c && (m - n) * dir > 0) ? m : n;
  }
  for (var k = n + dir; k >= 1 && k <= c; k += dir) {
    if (!hidden(k)) return k;
  }
  return n;
}

function move(n, k) {
  var dir = k < 0 ? -1 : 1;
  for (var i = Math.abs(k); i > 0; i--) {
    var m = step(n, dir);
    if (m === n) break;
    n = m;
  }
  return n;
}

function firstVisible() { return count() ? (hidden(1) ? step(1, 1) : 1) : 0; }
function lastVisible() { var c = count(); return c && hidden(c) ? step(c, -1) : c; }

function headings() {
  if (VH.lines.headings) return VH.lines.headings();
  var out = [];
  for (var n = 1, c = count(); n <= c; n++) {
    var m = /^H([1-6])$/.exec(el(n).tagName);
    if (m) out.push({ line: n, level: +m[1], text: VH.lines.text(n) });
  }
  return out;
}

// Visible line numbers in document order, for binary searches by screen y.
// Rebuilt after 'folds' / 'layout', or when the line count changes.
var visCache = null;

function visibleLines() {
  var c = count();
  if (visCache && visCache.c === c) return visCache.v;
  var v = [];
  for (var n = 1; n <= c; n++) {
    if (!hidden(n) && el(n).getClientRects().length) v.push(n);
  }
  visCache = { c: c, v: v };
  return v;
}

/* ----------------------------------------------------------------- geometry
 * All y values are viewport coordinates (getBoundingClientRect). Line tops
 * increase in document order, which the binary searches below rely on.
 */

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function rowH() {
  var cs = getComputedStyle(document.body);
  var lh = parseFloat(cs.lineHeight);
  return lh > 0 ? lh : (parseFloat(cs.fontSize) || 16) * 1.2;
}

function statusH() {
  var st = VH.ui.layer && VH.ui.layer.querySelector('.vh-status');
  var h = st && st.getClientRects().length ? st.getBoundingClientRect().height : 0;
  return h || STATUS_FALLBACK;
}

// The reading area is [0, viewBottom()) -- everything above the status line.
function viewBottom() {
  return (document.documentElement.clientHeight || window.innerHeight) - statusH();
}

function scrolloff() { return Math.min(SO_ROWS * rowH(), viewBottom() / 4); }

function maxScroll() {
  var se = document.scrollingElement || document.documentElement;
  return Math.max(0, se.scrollHeight - se.clientHeight);
}

function band() {
  var so = scrolloff();
  var y = window.scrollY;
  return { top: y <= 0.5 ? 0 : so, bottom: viewBottom() - (y >= maxScroll() - 0.5 ? 0 : so) };
}

// 'instant' beats any scroll-behavior: smooth a host page may set (the owner turned
// smooth scrolling off in nvim). Older engines reject the enum value; fall back.
function scrollToY(y) {
  y = Math.round(clamp(y, 0, maxScroll()));
  if (y === Math.round(window.scrollY)) return;
  try {
    window.scrollTo({ top: y, left: window.scrollX, behavior: 'instant' });
  } catch (err) {
    window.scrollTo(window.scrollX, y);
  }
}

// The part of the screen that belongs to line n: VH.lines.rect(n), the line's
// own box (an li holding a nested list stops where its first nested line
// starts), widened so a line of a <pre> spans the whole block (like a
// cursorline across a code buffer).
function ownRect(n) {
  var e = el(n);
  if (!e || !e.getClientRects().length) return null;
  var r = VH.lines.rect(n);
  var top = r.top, bottom = r.bottom, left = r.left, right = r.right;
  var pre = e.tagName !== 'PRE' && e.parentElement && e.parentElement.closest('pre');
  if (pre) {
    var p = pre.getBoundingClientRect();
    left = p.left;
    right = p.right;
  }
  return { top: top, bottom: bottom, left: left, right: right, height: bottom - top, width: right - left };
}

function topOf(n) { return el(n).getBoundingClientRect().top; }

// Index into v of the last line whose top is at or above y, or -1.
function lastStartingAbove(v, y) {
  var lo = 0, hi = v.length - 1, ans = -1;
  while (lo <= hi) {
    var mid = (lo + hi) >> 1;
    if (topOf(v[mid]) <= y) { ans = mid; lo = mid + 1; } else { hi = mid - 1; }
  }
  return ans;
}

// The visible line under screen y. In the gap between two lines it takes the
// one below when that starts inside `limit` (the band's bottom), else the one above.
function lineAtY(y, limit) {
  var v = visibleLines();
  if (!v.length) return 0;
  var i = lastStartingAbove(v, y);
  if (i < 0) return v[0];
  var r = ownRect(v[i]);
  if ((r && r.bottom > y) || i === v.length - 1) return v[i];
  return limit == null || topOf(v[i + 1]) < limit ? v[i + 1] : v[i];
}

// The first line that starts inside band b; failing that (one tall line covers
// the band), the line across its top edge.
function firstIn(b) {
  var v = visibleLines();
  if (!v.length) return 0;
  var i = lastStartingAbove(v, b.top - 0.5);
  if (i + 1 < v.length && topOf(v[i + 1]) < b.bottom) return v[i + 1];
  return i >= 0 ? v[i] : v[0];
}

// The last line that ends inside band b; failing that, the line across its
// bottom edge.
function lastIn(b) {
  var v = visibleLines();
  if (!v.length) return 0;
  var i = lastStartingAbove(v, b.bottom - 1);
  if (i < 0) return v[0];
  for (var k = i; k >= 0 && k > i - 64; k--) {
    var r = ownRect(v[k]);
    if (!r || r.top < b.top - 0.5) break;
    if (r.bottom <= b.bottom + 0.5) return v[k];
  }
  return v[i];
}

// Where the cursor may rest: fully inside the band, or, for a line too tall to
// fit, anywhere across it. The one exception is the line an in-page link or the
// address's #fragment points at: the browser parks it at the top edge (inside
// our margin) and it should stay the cursor line there.
var anchorLine = 0;
var linkFrom = null;  // the cursor's jump entry when an in-page link was clicked

function settled(n, b) {
  var r = ownRect(n);
  if (!r || r.height <= 0) return false;
  if (r.height > b.bottom - b.top) return r.bottom > b.top && r.top < b.bottom;
  if (r.top >= b.top - 0.5 && r.bottom <= b.bottom + 0.5) return true;
  return n === anchorLine && r.top >= -0.5 && r.bottom <= viewBottom() + 0.5;
}

// n, or the nearest line on its side of band b that may hold the cursor.
function settle(n, b) {
  if (settled(n, b)) return n;
  var r = ownRect(n);
  return r && r.top < b.top ? firstIn(b) : lastIn(b);
}

/* -------------------------------------------------------------- scrolling */

function reveal(n, how) {
  if (how === 'none') return;
  var r = ownRect(n);
  if (!r) return;
  var vb = viewBottom();
  var so = scrolloff();
  var tall = r.height > vb - 2 * so;  // cannot fit inside the band: show its start
  var dy = 0;
  if (how === 'top' || (tall && how !== 'auto')) {
    dy = r.top - so;
  } else if (how === 'bottom') {
    dy = r.bottom - (vb - so);
  } else if (how === 'center') {
    dy = (r.top + r.bottom) / 2 - vb / 2;
  } else if (tall) {
    // Show its start when it is out of sight or begins low on the screen; while
    // the reader is inside it (top scrolled away, rest still showing), stay.
    if (r.bottom <= so || r.top > vb / 2) dy = r.top - so;
  } else {
    if (r.top < so) dy = r.top - so;
    else if (r.bottom > vb - so) dy = r.bottom - (vb - so);
    if (Math.abs(dy) > vb / 2) dy = (r.top + r.bottom) / 2 - vb / 2;
  }
  if (dy) scrollToY(window.scrollY + dy);
}

// Put line n's top at screen y (a remembered view), kept inside the band.
function placeAt(n, y) {
  var r = ownRect(n);
  if (!r) return;
  var vb = viewBottom();
  var so = scrolloff();
  var hi = Math.max(so, vb - so - Math.min(r.height, vb - 2 * so));
  scrollToY(window.scrollY + r.top - clamp(y, so, hi));
}

/* ------------------------------------------------------------------ cursor */

function markEl() {
  var e = cur ? el(cur) : null;
  if (curEl && curEl !== e) curEl.classList.remove('vh-cursor');
  if (e) e.classList.add('vh-cursor');
  curEl = e;
}

// The cursorline is an overlay in VH.ui.layer rather than a background on the
// line element: a background would tint an li's nested list, cover only the
// glyphs of a <pre> line, and replace the element's own background (a <pre>'s).
// The layer scrolls with the page, so only layout changes need a repaint.
function paint() {
  paintRaf = 0;
  if (!bar) return;
  var r = cur ? ownRect(cur) : null;
  if (!r || r.height <= 0) { bar.classList.remove('vh-on'); return; }
  var o = VH.ui.origin();
  var s = bar.style;
  s.top = (r.top - o.top) + 'px';
  s.left = (r.left - o.left) + 'px';
  s.width = r.width + 'px';
  s.height = r.height + 'px';
  bar.classList.add('vh-on');
}

function schedulePaint() {
  if (!paintRaf) paintRaf = requestAnimationFrame(paint);
}

function set(n, opts) {
  opts = opts || {};
  var c = count();
  if (!c) { cur = 0; markEl(); paint(); return 0; }
  n = n === Infinity ? c : Math.round(Number(n));
  if (!isFinite(n)) n = cur || 1;
  n = clamp(n, 1, c);
  if (opts.jump && cur) record(here(cur));
  if (hidden(n) && VH.folds && VH.folds.reveal) VH.folds.reveal(n);
  var prev = cur;
  cur = n;
  caretRange = opts.caret || null;
  sticky = null;
  markEl();
  if (typeof opts.at === 'number') placeAt(n, opts.at);
  else reveal(n, opts.scroll === false ? 'none' : opts.scroll || 'auto');
  paint();
  if (n !== prev || opts.caret) VH.emit('cursor', { line: n, prev: prev });
  return n;
}

VH.cursor = {
  line: function () { return cur; },
  get: function () { return cur; },  // the wave-1 name; harness and modules use it
  caret: function () { return caretRange; },
  set: set
};

// Pull the cursor back into the band after the view moved under it (wheel,
// trackpad, scrollbar, Ctrl-e...). It stays put while its line rests there.
function keepInView() {
  if (!cur) return;
  var n = settle(cur, band());
  if (n && n !== cur) set(n, { scroll: 'none' });
}

/* ------------------------------------------------------------ the motions */

function down(c) { set(move(cur, c || 1)); }
function up(c) { set(move(cur, -(c || 1))); }

// Ctrl-d / Ctrl-u (see the header). A count scrolls that many rows instead.
function halfPage(dir, c) {
  if (!cur) return;
  var amount = c ? c * rowH() : Math.round(viewBottom() / 2);
  var b0 = band();
  var y;
  if (sticky && sticky.line === cur && Math.abs(sticky.sy - window.scrollY) < 1) {
    y = sticky.y;
  } else {
    var r = ownRect(cur);
    y = clamp(r ? r.top + 1 : b0.top, b0.top, b0.bottom - 1);
  }
  var before = window.scrollY;
  scrollToY(before + dir * amount);
  // Whatever the view could not scroll (top or end of the page), the cursor
  // travels on screen instead, as vim moves the cursor when it cannot scroll.
  var rest = dir * amount - (window.scrollY - before);
  var b = band();
  var ty = clamp(y + rest, b.top, b.bottom - 1);
  set(settle(lineAtY(ty, b.bottom), b), { scroll: 'none' });
  sticky = { line: cur, y: ty, sy: window.scrollY };
}

// Ctrl-f / Ctrl-b: a view minus two rows of overlap, as in vim; the cursor
// lands on the new view's top (bottom) line. When the document runs out first,
// vim scrolls on past its end; here the unscrolled rest moves the cursor down
// (up) the screen instead, reaching the last (first) line if it is more than a view.
function page(dir, c) {
  if (!cur) return;
  var amount = Math.max(rowH(), viewBottom() - 2 * rowH()) * (c || 1);
  var before = window.scrollY;
  scrollToY(before + dir * amount);
  var rest = dir * amount - (window.scrollY - before);
  var b = band();
  var n;
  if (Math.abs(rest) < 1) {
    n = settle(cur, b);
  } else {
    var y = dir > 0 ? b.top + rest : b.bottom - 1 + rest;
    n = y >= b.bottom ? lastVisible() : y < b.top ? firstVisible() : settle(lineAtY(y, b.bottom), b);
  }
  if (n !== cur) set(n, { scroll: 'auto' });
}

// Ctrl-e / Ctrl-y: one row per count; the cursor stays unless it leaves the view.
function nudge(dir, c) {
  scrollToY(window.scrollY + dir * (c || 1) * rowH());
  keepInView();
}

// zz zt zb; with a count, that line first (vim's {count}zt).
function align(how) {
  return function (c) {
    if (c) set(c, { scroll: how });
    else reveal(cur, how);
  };
}

// } { ]] [[: headings, skipping ones inside closed folds. Past the last (first)
// heading they go to the last (first) line, like vim's section motions. They are
// jumps in vim, so they are jumps here.
function heading(dir) {
  return function (c) {
    if (!cur) return;
    var k = c || 1;
    var hs = headings().filter(function (h) {
      return !hidden(h.line) && (dir > 0 ? h.line > cur : h.line < cur);
    });
    if (dir < 0) hs.reverse();
    var n = k <= hs.length ? hs[k - 1].line : (dir > 0 ? lastVisible() : firstVisible());
    set(n, { jump: true });
  };
}

function gotoLine(dflt) {
  return function (c) { set(c || dflt(), { jump: true }); };
}

/* ---------------------------------------------------------------- jumplist
 * vim's model: `jumps` holds the lines jumped *from*, oldest first; `jidx` is
 * jumps.length except while walking with Ctrl-o / Ctrl-i. A jump appends the
 * line it leaves (dropping an older entry for the same line). The first Ctrl-o
 * also appends the current line, so Ctrl-i can come back to it. `pcmark` is
 * the entry '' returns to; '' is itself a jump, so pressing it twice toggles.
 */

var jumps = [];
var jidx = 0;
var pcmark = null;

function here(n) {
  var r = ownRect(n);
  return { line: n, at: r ? r.top : null };
}

function record(entry) {
  jumps = jumps.filter(function (j) { return j.line !== entry.line; });
  pcmark = entry;
  jumps.push(entry);
  if (jumps.length > JUMPS_MAX) jumps.shift();
  jidx = jumps.length;
}

function go(entry, jump) {
  var opts = { jump: !!jump };
  if (entry.at != null) opts.at = entry.at;
  set(entry.line, opts);
}

function back(c) {
  if (!cur) return;
  if (jidx >= jumps.length) {
    record(here(cur));
    jidx = jumps.length - 1;
  }
  var t = jidx - (c || 1);
  if (t < 0) return;
  jidx = t;
  go(jumps[t]);
}

function forward(c) {
  var t = jidx + (c || 1);
  if (t >= jumps.length) return;
  jidx = t;
  go(jumps[t]);
}

function previousContext() {
  if (!pcmark) { VH.toast('E20: Mark not set', { kind: 'error' }); return; }
  go(pcmark, true);
}

VH.jumps = {
  list: function () { return jumps.map(function (j) { return j.line; }); },
  index: function () { return jidx; },
  back: back,
  forward: forward
};

/* ------------------------------------------------------------------- marks
 * marks: letter -> {line, text, at}. `text` (the line's first 80 characters)
 * lets a mark find its line again after the document is rebuilt with lines
 * added or removed above it; `at` is the screen position when it was set,
 * restored on jump (jumpoptions=view covers mark motions too).
 */

var marks = {};

function snippet(n) { return VH.lines.text(n).slice(0, 80); }

function nearestWithText(text, near) {
  var best = 0;
  for (var n = 1, c = count(); n <= c; n++) {
    if (snippet(n) === text && (!best || Math.abs(n - near) < Math.abs(best - near))) best = n;
  }
  return best;
}

function loadMarks() {
  var saved = VH.store.get('marks');
  marks = {};
  if (!saved || typeof saved !== 'object') return;
  var c = count();
  Object.keys(saved).forEach(function (ch) {
    var m = saved[ch];
    if (!/^[a-z]$/.test(ch) || !m || typeof m.line !== 'number' || !c) return;
    var line = clamp(Math.round(m.line), 1, c);
    if (m.text && snippet(line) !== m.text) line = nearestWithText(m.text, m.line) || line;
    marks[ch] = { line: line, text: snippet(line), at: typeof m.at === 'number' ? m.at : null };
  });
}

function saveMarks(changed) {
  VH.store.set('marks', marks);
  changed.forEach(mapMarkJump);
  VH.emit('marks', {});
}

function setMark(ch, n) {
  if (!/^[a-z]$/.test(ch) || !count()) return false;
  n = clamp(Math.round(n || cur), 1, count());
  marks[ch] = { line: n, text: snippet(n), at: here(n).at };
  saveMarks([ch]);
  return true;
}

function delMarks(chars) {
  var gone = chars.filter(function (ch) { return marks[ch]; });
  gone.forEach(function (ch) { delete marks[ch]; });
  if (gone.length) saveMarks(gone);
  return gone.length;
}

function marksAt(n) {
  return Object.keys(marks).sort().filter(function (ch) { return marks[ch].line === n; });
}

function jumpToMark(ch) {
  var m = marks[ch];
  if (!m) { VH.toast('E20: Mark not set', { kind: 'error' }); return; }
  go({ line: m.line, at: m.at }, true);
}

VH.marks = {
  all: function () {
    return Object.keys(marks).sort().map(function (ch) {
      return { mark: ch, line: marks[ch].line, text: marks[ch].text };
    });
  },
  get: function (ch) {
    var m = marks[ch];
    return m ? { mark: ch, line: m.line, text: m.text } : null;
  },
  at: marksAt,
  set: setMark,
  del: function (chars) { return delMarks(String(chars || '').split('')); },
  clear: function () { return delMarks(Object.keys(marks)); }
};

// 'a jumps are rebound whenever mark a changes: a set mark is listed (help,
// which-key) with its line, an unset one stays mapped but hidden so 'x still
// answers "E20: Mark not set" instead of passing the x through.
function mapMarkJump(ch) {
  var m = marks[ch];
  var desc = m ? 'mark ' + ch + ': ' + m.line + '  ' + m.text.slice(0, 40) : 'jump to mark ' + ch;
  VH.keys.map('normal', "'" + ch, function () { jumpToMark(ch); },
    { desc: desc, group: 'marks', hidden: !m });
  VH.keys.map('normal', '`' + ch, function () { jumpToMark(ch); },
    { desc: desc, group: 'marks', hidden: true });
}

// "a-c x" -> ['a', 'b', 'c', 'x']; null when anything else is in there.
function parseMarkList(arg) {
  var s = String(arg || '').replace(/\s+/g, '');
  var out = [];
  var re = /([a-z])(?:-([a-z]))?/y;
  var i = 0;
  while (i < s.length) {
    re.lastIndex = i;
    var m = re.exec(s);
    if (!m) return null;
    var a = m[1].charCodeAt(0), b = (m[2] || m[1]).charCodeAt(0);
    if (b < a) return null;
    for (var k = a; k <= b; k++) out.push(String.fromCharCode(k));
    i = re.lastIndex;
  }
  return out;
}

/* ------------------------------------------------------------------ links */

function linesOfAnchor(hash) {
  var id = '';
  try { id = decodeURIComponent(String(hash || '').replace(/^#/, '')); } catch (err) { return 0; }
  if (!id) return 0;
  var t = document.getElementById(id) || document.getElementsByName(id)[0];
  if (!t || VH.ui.isOurs(t)) return 0;
  var n = VH.lines.of(t);
  if (n) return n;
  // A container (a section, a div): its first line, or the first one after it.
  for (var i = 1, c = count(); i <= c; i++) {
    if (t.compareDocumentPosition(el(i)) & Node.DOCUMENT_POSITION_FOLLOWING) return i;
  }
  return 0;
}

function samePage(u) {
  return !!u.hash && u.href.split('#')[0] === location.href.split('#')[0];
}

function inPageLink(a) {
  try { return samePage(new URL(a.href, location.href)); } catch (err) { return false; }
}

// gd (the owner's Obsidian follow-link). {count}gd takes the count-th link on
// the line; after a search landing, the first link at or after the match.
function followLink(c) {
  var e = el(cur);
  if (!e) return;
  var links = Array.prototype.slice.call(e.querySelectorAll('a[href]'));
  var outer = e.parentElement && e.parentElement.closest('a[href]');
  if (outer) links.unshift(outer);
  if (!links.length) { VH.toast('No link on this line'); return; }
  var a = links[Math.min(c || 1, links.length) - 1];
  if (!c && caretRange) {
    a = links.filter(function (l) {
      return caretRange.comparePoint(l, l.childNodes.length) >= 0;
    })[0] || a;
  }
  var u;
  try { u = new URL(a.getAttribute('href'), location.href); } catch (err) { VH.toast('Bad link', { kind: 'error' }); return; }
  if (samePage(u)) {
    var n = linesOfAnchor(u.hash);
    if (n) set(n, { jump: true, scroll: 'top' });
    else VH.toast('No target for ' + u.hash, { kind: 'error' });
    return;
  }
  window.open(u.href, '_blank', 'noopener');
}

/* ---------------------------------------------------------- message area
 * A small box above the status line for :marks and the <leader>md question,
 * like nvim's message area. `asking` holds the one-key question: its keydown
 * hook is added at module load, before VH.boot() installs core's dispatcher, so
 * on window's capture phase it runs first and can take the reply key (and Esc)
 * away from the keymap. Anything else that happens closes the box.
 */

var msg = null;
var asking = null;

function closeMsg() {
  asking = null;
  if (msg) { msg.remove(); msg = null; }
}

function showMsg(title, rows, onPick) {
  closeMsg();
  var h = VH.ui.h;
  var list = rows.map(function (r) {
    return h('div', {
      'class': 'vh-msg-row' + (onPick ? ' vh-msg-pick' : ''),
      onclick: onPick ? function () { closeMsg(); onPick(r.key); } : null
    }, [h('span', { 'class': 'vh-msg-key', text: r.key }), h('span', { 'class': 'vh-msg-line', text: String(r.line) }),
        h('span', { 'class': 'vh-msg-text', text: r.text })]);
  });
  msg = h('div', { 'class': 'vh-msg', role: 'status' }, [h('div', { 'class': 'vh-msg-title', text: title })].concat(list));
  msg.style.bottom = statusH() + 'px';
  VH.ui.layer.appendChild(msg);
}

function markRows() {
  var rows = [];
  if (pcmark) rows.push({ key: "'", line: pcmark.line, text: VH.lines.text(pcmark.line) });
  return rows.concat(VH.marks.all().map(function (m) { return { key: m.mark, line: m.line, text: m.text }; }));
}

function listMarks() {
  var rows = markRows();
  if (!rows.length) { VH.toast('No marks set'); return; }
  showMsg('mark  line  text', rows, function (k) { if (k === "'") previousContext(); else jumpToMark(k); });
}

// <leader>md, the owner's map: delete the mark on the cursor line, else ask which.
function deleteMarkHere() {
  var on = marksAt(cur);
  if (on.length) { delMarks([on[0]]); VH.toast('Deleted mark: ' + on[0]); return; }
  if (!Object.keys(marks).length) { VH.toast('No marks set'); return; }
  showMsg('Mark to delete (a-z, Esc cancels):', markRows().filter(function (r) { return r.key !== "'"; }));
  asking = function (ch) {
    if (delMarks([ch])) VH.toast('Deleted mark: ' + ch);
    else VH.toast('E20: Mark not set', { kind: 'error' });
  };
}

window.addEventListener('keydown', function (e) {
  if (!msg || /^(Shift|Control|Alt|Meta|CapsLock|Fn)$/.test(e.key) || e.isComposing) return;
  var fn = asking;
  closeMsg();
  if (!fn) return;  // the :marks listing: any key dismisses it and still does its job
  e.preventDefault();
  e.stopImmediatePropagation();
  if (/^[a-z]$/.test(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey) fn(e.key);
}, true);

/* ----------------------------------------------------------------- keymap */

function map(seq, fn, desc, group, opts) {
  VH.keys.map('normal', seq, fn, Object.assign({ desc: desc, group: group || 'motion' }, opts || {}));
}

map('j', down, 'next line (count), over closed folds');
map('<Down>', down, 'next line');
map('k', up, 'previous line (count), over closed folds');
map('<Up>', up, 'previous line');
map('gg', gotoLine(firstVisible), 'first line, or line {count}');
map('G', gotoLine(lastVisible), 'last line, or line {count}');
map('}', heading(1), 'next heading');
map('{', heading(-1), 'previous heading');
map(']]', heading(1), 'next heading');
map('[[', heading(-1), 'previous heading');

map('<C-d>', function (c) { halfPage(1, c); }, 'half a page down, cursor moves with the view', 'scroll');
map('<C-u>', function (c) { halfPage(-1, c); }, 'half a page up, cursor moves with the view', 'scroll');
map('<C-f>', function (c) { page(1, c); }, 'page down', 'scroll');
map('<C-b>', function (c) { page(-1, c); }, 'page up', 'scroll');
map('<C-e>', function (c) { nudge(1, c); }, 'scroll down a row; cursor stays while visible', 'scroll');
map('<C-y>', function (c) { nudge(-1, c); }, 'scroll up a row; cursor stays while visible', 'scroll');
map('zz', align('center'), 'cursor line to the centre', 'scroll');
map('zt', align('top'), 'cursor line to the top', 'scroll');
map('zb', align('bottom'), 'cursor line to the bottom', 'scroll');

map('<C-o>', back, 'jump back (jumplist)', 'jumps');
map('<C-i>', forward, 'jump forward (jumplist)', 'jumps');
// A terminal sends Ctrl-I as Tab, so in vim Tab jumps forward too. Taking Tab
// (and Shift-Tab, which vim's normal mode ignores) also stops the browser's
// focus navigation from scrolling the page to the first or last link; insert
// mode gives both back to the page.
map('<Tab>', forward, 'jump forward (jumplist)', 'jumps');
map('<S-Tab>', function () {}, '', 'jumps', { hidden: true });
map("''", previousContext, 'back to the line before the latest jump', 'jumps');
map('``', previousContext, 'back to the line before the latest jump', 'jumps', { hidden: true });
map('gd', followLink, 'follow the link on the line ({count}: the count-th link)', 'jumps');

LETTERS.split('').forEach(function (ch) {
  map('m' + ch, function () { setMark(ch); }, 'set mark ' + ch, 'marks', { hidden: true });
  mapMarkJump(ch);
});
VH.keys.doc('normal', 'm{a-z}', 'set a mark on the cursor line', 'marks');
VH.keys.doc('normal', "'{a-z}", 'jump to a mark (` works too)', 'marks');
map('<leader>md', deleteMarkHere, 'delete the mark on this line, else ask which', 'marks');

VH.commands.add('marks', listMarks, 'list the marks');
VH.commands.add('delmarks', function (arg, bang) {
  if (bang) { VH.marks.clear(); return; }
  var chars = parseMarkList(arg);
  if (!String(arg || '').trim()) { VH.toast('E471: Argument required', { kind: 'error' }); return false; }
  if (!chars) { VH.toast('E475: Invalid argument: ' + arg.trim(), { kind: 'error' }); return false; }
  delMarks(chars);
}, 'delete marks: :delm a b-d, :delm! for all');

VH.on('goto', function (e) { set(e.line, { jump: true }); });

/* -------------------------------------------------------------------- init */

VH.init(function () {
  bar = VH.ui.h('div', { 'class': 'vh-cursorline', 'aria-hidden': 'true' });
  VH.ui.layer.insertBefore(bar, VH.ui.layer.firstChild);  // under every other piece of UI

  loadMarks();
  Object.keys(marks).forEach(mapMarkJump);

  // An address with #fragment starts there; otherwise at the top.
  anchorLine = linesOfAnchor(location.hash);
  set(anchorLine || firstVisible(), { scroll: anchorLine ? 'top' : 'none' });
  if (Object.keys(marks).length) VH.emit('marks', {});

  VH.on('layout', function () {
    visCache = null;
    if (cur > count()) cur = count();
    markEl();
    schedulePaint();
  });
  VH.on('folds', function () {
    visCache = null;
    // A fold closed over the cursor: it lands on the fold's heading, as in nvim.
    if (cur && hidden(cur)) set(step(cur, -1), { scroll: 'auto' });
    schedulePaint();
  });
  VH.on('mode', function (e) {
    closeMsg();
    if (e.to === 'normal') keepInView();
  });
  VH.on('escape', closeMsg);
  VH.on('close', closeMsg);

  var scrollRaf = 0;
  window.addEventListener('scroll', function () {
    if (scrollRaf) return;
    scrollRaf = requestAnimationFrame(function () {
      scrollRaf = 0;
      if (VH.mode.get() === 'normal') keepInView();
    });
  }, { passive: true });

  window.addEventListener('resize', schedulePaint);
  window.addEventListener('load', schedulePaint);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(schedulePaint);
  if (window.ResizeObserver) new ResizeObserver(schedulePaint).observe(document.body);

  // A click puts the cursor on the clicked line, or the nearest one (the gutter,
  // the margins), scrolling a little if it was inside the scrolloff margin, as
  // vim does. A link outside every line (the nav) is left to hashchange, and a
  // drag-selection to visual mode.
  document.addEventListener('click', function (e) {
    if (e.button !== 0 || e.defaultPrevented) return;
    var t = e.target;
    var link = t.closest && t.closest('a[href]');
    if (link && cur && inPageLink(link)) linkFrom = here(cur);
    if (VH.mode.get() !== 'normal') return;
    if (VH.ui.isOurs(t) || VH.ui.isEditable(t)) return;
    var sel = window.getSelection();
    if (sel && !sel.isCollapsed) return;
    var n = VH.lines.of(t);
    if (!n && link) return;
    if (!n || hidden(n)) n = lineAtY(e.clientY);
    if (n) set(n, { scroll: 'auto' });
  });

  // An in-page link followed by the browser (a click, Back/Forward): the cursor
  // goes with it and the jump is recorded, like gd. The browser's own scroll to
  // the target fires 'scroll' (and so keepInView) before 'hashchange' arrives,
  // so a clicked link records the line it was clicked from (linkFrom).
  window.addEventListener('hashchange', function () {
    var from = linkFrom;
    linkFrom = null;
    anchorLine = linesOfAnchor(location.hash);
    if (!anchorLine) return;
    var r = ownRect(anchorLine);
    if (from) record(from);
    set(anchorLine, { jump: !from, scroll: r && r.top >= -0.5 && r.bottom <= viewBottom() ? 'none' : 'top' });
  });
});
