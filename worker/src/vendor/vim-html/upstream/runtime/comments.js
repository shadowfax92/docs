/* comments.js -- comments: store, anchoring, editor, highlights, export (piece E).
 *
 * A comment is a note pinned to a stretch of document text. The text it was made
 * on is the anchor, so comments survive build.py rebuilds and content edits:
 *
 *   record   {id, note, anchor, created, updated, detached?}   in VH.store 'comments'
 *   anchor   {startLine, endLine, quote, prefix, suffix, whole?}
 *            quote is the commented text as it reads in the doc text model below;
 *            prefix/suffix are the CONTEXT chars around it; whole marks a
 *            line-wise anchor (gcc, V) that must cover entire lines.
 *
 * Flow:
 *   select.js (v, V, mouse) --Range or {start, end}--> compose() -> editor
 *     -> Enter/Esc/jk -> add/update/remove -> history snapshot -> VH.store
 *     -> 'comments' event -> lines.js gutter signs, panel.js, chrome.js count
 *   boot / line count change -> attachAll(): locate each quote in the current
 *     text (exact, else fuzzy) -> live DOM Range per comment -> CSS highlights
 *
 * Doc text model: each gutter line's text is VH.lines.model(n) (whitespace
 * collapsed as the browser renders it, table cells joined by " | ", <pre> lines
 * verbatim; lines.js owns the definition) and the lines are joined by "\n".
 * Quotes, prefixes and suffixes are substrings of that one string, so
 * reattaching is a substring search, and per-line offset maps turn any DOM
 * boundary into a model offset and back.
 *
 * API (PLAN.md "Comments"; (+) are additive):
 *   VH.comments.all() get(id) at(line) add({anchor, note}) update(id, note)
 *     remove(id | [ids]) clear() -> n  undo() redo()(+) -> bool
 *     compose(Range | {start, end} | {id}(+))  format(list, {header}(+))
 *     copy(list)(+)  location()(+)  lastAttach(+) {total, attached, moved, fuzzy, detached}
 *   VH.anchor.fromRange(range) fromLines(s, e)(+) toRange(anchor) -> Range | null
 */

var KEY = 'comments';
var CONTEXT = 32;       // chars of prefix/suffix kept around a quote
var FUZZ = 0.72;        // minimum bigram similarity for a fuzzy reattach
var HISTORY = 100;      // undo levels kept (in memory, like vim without undofile)
var QUOTE_MAX = 800;    // export cuts longer quotes with an ellipsis

var items = load();     // records, in insertion order; all() sorts
var ranges = {};        // id -> live DOM Range of an attached comment (never persisted)
var posOf = {};         // id -> model offset of the quote's start, for ordering
var past = [];          // undo snapshots {items, label}
var future = [];        // redo snapshots
var attachedCount = 0;  // VH.lines.count() at the last attachAll(), to spot a re-split

var HL = !!(window.CSS && CSS.highlights && window.Highlight);

function load() {
  var v = VH.store.get(KEY);
  return Array.isArray(v) ? v.filter(function (c) { return c && c.id && c.anchor; }) : [];
}

function clone(v) { return JSON.parse(JSON.stringify(v)); }

function find(id) {
  for (var i = 0; i < items.length; i++) if (items[i].id === id) return items[i];
  return null;
}

function newId() {
  return 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

/* --------------------------------------------------------- doc text model
 * Each gutter line's text is VH.lines.model(n) (lines.js "line text model":
 * {text, raw2n, nStart, nEnd, rawLen}), the one definition search, the pickers
 * and yank read too; raw offsets are VH.text offsets and map both ways.
 */

// The whole document as one string; starts[n] is line n's offset in it.
function buildDoc() {
  var count = VH.lines.count();
  var lines = [null], starts = [0], texts = [], pos = 0;
  for (var n = 1; n <= count; n++) {
    var m = VH.lines.model(n);
    lines.push(m);
    starts.push(pos);
    texts.push(m.text);
    pos += m.text.length + 1;
  }
  return { count: count, lines: lines, starts: starts, text: texts.join('\n') };
}

function lineAt(doc, off) {
  var lo = 1, hi = doc.count;
  while (lo < hi) {
    var mid = (lo + hi + 1) >> 1;
    if (doc.starts[mid] <= off) lo = mid; else hi = mid - 1;
  }
  return lo;
}

function lineEnd(doc, n) { return doc.starts[n] + doc.lines[n].text.length; }

// A DOM boundary -> model offset. A boundary between lines (in a gap the line
// model does not cover) snaps forward to the next line's start, or for the end
// of a range back to the previous line's end.
function boundary(doc, node, offset, isEnd) {
  var n = VH.lines.of(node);
  if (n && n <= doc.count) {
    var m = doc.lines[n];
    var raw = VH.text.offsetIn(VH.lines.el(n), node, offset);
    return doc.starts[n] + m.raw2n[Math.max(0, Math.min(raw, m.rawLen))];
  }
  var probe = document.createRange();
  var lo = 1, hi = doc.count + 1;
  try {
    probe.setStart(node, offset);
    probe.collapse(true);
    while (lo < hi) {
      var mid = (lo + hi) >> 1;
      if (probe.comparePoint(VH.lines.el(mid), 0) >= 0) hi = mid; else lo = mid + 1;
    }
  } catch (err) { return isEnd ? doc.text.length : 0; }
  if (isEnd) return lo > 1 ? lineEnd(doc, lo - 1) : 0;
  return lo <= doc.count ? doc.starts[lo] : doc.text.length;
}

// A Range -> trimmed model span {a, b}, or null when it holds no document text.
function rangeSpan(doc, range) {
  if (!doc.count) return null;
  var a = boundary(doc, range.startContainer, range.startOffset, false);
  var b = boundary(doc, range.endContainer, range.endOffset, true);
  var t = doc.text;
  while (a < b && /\s/.test(t.charAt(a))) a++;
  while (b > a && /\s/.test(t.charAt(b - 1))) b--;
  return b > a ? { a: a, b: b } : null;
}

function linesSpan(doc, s, e) {
  return { a: doc.starts[s], b: lineEnd(doc, e), s: s, e: e };
}

function anchorOf(doc, span, whole) {
  var t = doc.text;
  var s = span.s || lineAt(doc, span.a);
  var e = span.e || (whole ? lineAt(doc, span.b) : lineAt(doc, Math.max(span.a, span.b - 1)));
  var a = { startLine: s, endLine: Math.max(s, e), quote: t.slice(span.a, span.b),
            prefix: t.slice(Math.max(0, span.a - CONTEXT), span.a), suffix: t.slice(span.b, span.b + CONTEXT) };
  if (whole) a.whole = true;
  return a;
}

// Model span -> live DOM Range, from the first char to the last, so a line-wise
// range stops short of nested lines it does not own. A line with no text (an
// image) is covered as an element.
function spanRange(doc, span) {
  var r = document.createRange();
  var s = lineAt(doc, span.a);
  if (span.b <= span.a) {
    r.selectNodeContents(VH.lines.el(s));
    return r;
  }
  var ms = doc.lines[s], la = span.a - doc.starts[s];
  var rawA = la >= ms.text.length ? ms.rawLen : ms.nStart[la];
  var en = lineAt(doc, Math.max(span.a, span.b - 1));
  var me = doc.lines[en], lb = span.b - doc.starts[en];
  var rawB = lb <= 0 ? 0 : me.nEnd[Math.min(lb, me.text.length) - 1];
  var rs = VH.text.rangeFrom(VH.lines.el(s), rawA, rawA);
  var re = VH.text.rangeFrom(VH.lines.el(en), 0, rawB);
  r.setStart(rs.startContainer, rs.startOffset);
  r.setEnd(re.endContainer, re.endOffset);
  return r;
}

/* -------------------------------------------------------------- reattach
 * locate(doc, anchor) -> {a, b, how} | null
 *   exact: every occurrence of the quote (line-aligned ones only for a whole
 *     anchor), best first by how much prefix/suffix context still matches, then
 *     by nearness to the old startLine (PLAN.md);
 *   fuzzy: the quote was reworded. Regions of as many lines as the quote has are
 *     filtered by shared character bigrams, then the best window in each is
 *     scored by Dice similarity; FUZZ or better reattaches. This is what keeps a
 *     comment on a sentence the agent tightened instead of detaching it.
 */

function commonTail(a, b) {
  var n = 0;
  while (n < a.length && n < b.length && a.charAt(a.length - 1 - n) === b.charAt(b.length - 1 - n)) n++;
  return n;
}

function commonHead(a, b) {
  var n = 0;
  while (n < a.length && n < b.length && a.charAt(n) === b.charAt(n)) n++;
  return n;
}

function locate(doc, anchor) {
  if (!doc.count) return null;
  var q = anchor.quote || '';
  var t = doc.text;
  var cands = [];
  if (q) {
    for (var i = t.indexOf(q); i >= 0; i = t.indexOf(q, i + 1)) cands.push({ a: i, b: i + q.length });
  } else if (anchor.whole) {
    for (var n = 1; n <= doc.count; n++) if (!doc.lines[n].text) cands.push({ a: doc.starts[n], b: doc.starts[n] });
  }
  if (anchor.whole) {
    cands = cands.filter(function (c) {
      var s = lineAt(doc, c.a), e = lineAt(doc, c.b);
      return c.a === doc.starts[s] && c.b === lineEnd(doc, e);
    });
  }
  var best = null;
  cands.forEach(function (c) {
    var ctx = commonTail(t.slice(Math.max(0, c.a - CONTEXT), c.a), anchor.prefix || '') +
              commonHead(t.slice(c.b, c.b + CONTEXT), anchor.suffix || '');
    var dist = Math.abs(lineAt(doc, c.a) - (anchor.startLine || 1));
    if (!best || ctx > best.ctx || (ctx === best.ctx && dist < best.dist)) best = { a: c.a, b: c.b, ctx: ctx, dist: dist };
  });
  if (best) return { a: best.a, b: best.b, how: 'exact' };
  return fuzzy(doc, anchor);
}

function grams(s) {
  s = s.toLowerCase().replace(/\s+/g, ' ');
  var map = {}, total = 0;
  for (var i = 0; i < s.length - 1; i++) {
    var g = s.substr(i, 2);
    map[g] = (map[g] || 0) + 1;
    total++;
  }
  return { map: map, total: total };
}

function overlap(A, B) {
  var n = 0;
  for (var g in A.map) if (B.map[g]) n += Math.min(A.map[g], B.map[g]);
  return n;
}

function dice(A, B) {
  return A.total + B.total ? 2 * overlap(A, B) / (A.total + B.total) : 0;
}

function fuzzy(doc, anchor) {
  var q = anchor.quote || '';
  if (q.replace(/\s/g, '').length < 12) return null;  // too short to judge similarity
  var parts = q.split('\n');
  var k = parts.length;
  var qg = grams(q);
  var lineGrams = [];
  function lg(n) { return lineGrams[n] || (lineGrams[n] = grams(doc.lines[n].text)); }
  var best = null;
  for (var i = 1; i + k - 1 <= doc.count; i++) {
    var shared = 0;
    for (var j = i; j < i + k; j++) shared += overlap(qg, lg(j));
    if (Math.min(shared, qg.total) < qg.total * 0.5) continue;
    var span = anchor.whole ? linesSpan(doc, i, i + k - 1)
      : k === 1 ? bestWindow(doc, i, q, qg) : edgeSpan(doc, i, k, parts);
    if (!span || span.b <= span.a) continue;
    var score = dice(qg, grams(doc.text.slice(span.a, span.b)));
    if (score < FUZZ) continue;
    var dist = Math.abs(i - (anchor.startLine || 1));
    if (!best || score > best.score + 1e-9 || (Math.abs(score - best.score) <= 1e-9 && dist < best.dist)) {
      best = { a: span.a, b: span.b, score: score, dist: dist };
    }
  }
  return best && { a: best.a, b: best.b, how: 'fuzzy' };
}

// The word-aligned window of line n that reads most like q.
function bestWindow(doc, n, q, qg) {
  var T = doc.lines[n].text, base = doc.starts[n];
  if (T.length <= q.length * 1.25) return { a: base, b: base + T.length };
  var starts = [], ends = [];
  for (var i = 0; i < T.length; i++) {
    if (T.charAt(i) !== ' ' && (i === 0 || T.charAt(i - 1) === ' ')) starts.push(i);
    if (T.charAt(i) !== ' ' && (i + 1 === T.length || T.charAt(i + 1) === ' ')) ends.push(i + 1);
  }
  var slack = Math.ceil(q.length * 0.25) + 3;
  var best = null;
  starts.forEach(function (s) {
    ends.forEach(function (e) {
      if (e <= s || Math.abs(e - s - q.length) > slack) return;
      var sc = dice(qg, grams(T.slice(s, e)));
      if (!best || sc > best.sc) best = { a: base + s, b: base + e, sc: sc };
    });
  });
  return best;
}

// A multi-line partial quote: assume it still starts as far from the end of its
// first line, and ends as far into its last line, as it did; snap to words.
function edgeSpan(doc, i, k, parts) {
  var first = doc.lines[i].text, last = doc.lines[i + k - 1].text;
  var a = Math.max(0, first.length - parts[0].length);
  var b = Math.min(last.length, parts[k - 1].length);
  while (a > 0 && first.charAt(a - 1) !== ' ') a--;
  while (b < last.length && last.charAt(b) !== ' ') b++;
  return { a: doc.starts[i] + a, b: doc.starts[i + k - 1] + b };
}

function sameAnchor(x, y) {
  return x.startLine === y.startLine && x.endLine === y.endLine && x.quote === y.quote &&
    x.prefix === y.prefix && x.suffix === y.suffix && !!x.whole === !!y.whole;
}

// Resolve every comment against the current document: refresh anchors that moved
// or were reworded, flag the rest detached, rebuild ranges and highlights.
function attachAll() {
  var doc = buildDoc();
  var stats = { total: items.length, attached: 0, moved: 0, fuzzy: 0, detached: 0 };
  var dirty = false;
  ranges = {};
  posOf = {};
  items.forEach(function (c) {
    var hit = locate(doc, c.anchor);
    if (!hit) {
      stats.detached++;
      if (!c.detached) { c.detached = true; dirty = true; }
      return;
    }
    var fresh = anchorOf(doc, hit, c.anchor.whole);
    if (fresh.startLine !== c.anchor.startLine) stats.moved++;
    if (hit.how === 'fuzzy') stats.fuzzy++;
    stats.attached++;
    if (c.detached || !sameAnchor(fresh, c.anchor)) {
      c.anchor = fresh;
      delete c.detached;
      dirty = true;
    }
    ranges[c.id] = spanRange(doc, hit);
    posOf[c.id] = hit.a;
  });
  attachedCount = doc.count;
  VH.comments.lastAttach = stats;
  if (dirty) VH.store.set(KEY, items);
  paint();
  VH.emit('comments', {});
  return stats;
}

// A record restored by undo, or added through the API, gets its range here.
function attachOne(doc, c) {
  if (ranges[c.id] && !c.detached) return;
  var hit = locate(doc, c.anchor);
  if (!hit) { c.detached = true; return; }
  delete c.detached;
  c.anchor = anchorOf(doc, hit, c.anchor.whole);
  ranges[c.id] = spanRange(doc, hit);
  posOf[c.id] = hit.a;
}

/* ------------------------------------------------------------- highlights
 * The CSS Custom Highlight API paints commented text without touching the
 * document's DOM (no wrapper spans, so anchors and the line model never see
 * our marks). Without it the gutter sign from lines.js is the only marker.
 *   vh-comment        every attached comment
 *   vh-comment-cur    the comment K shows or ]c / [c landed on
 *   vh-comment-draft  the text the open editor is commenting on
 */

var curIds = [];

function paint() {
  if (!HL) return;
  var all = [], cur = [];
  items.forEach(function (c) {
    var r = !c.detached && ranges[c.id];
    if (!r) return;
    all.push(r);
    if (curIds.indexOf(c.id) >= 0) cur.push(r);
  });
  setHighlight('vh-comment', all, 0);
  setHighlight('vh-comment-cur', cur, 1);
}

function setHighlight(name, list, priority) {
  if (!HL) return;
  if (!list.length) { CSS.highlights.delete(name); return; }
  var h = new Highlight();
  list.forEach(function (r) { h.add(r); });
  h.priority = priority;
  CSS.highlights.set(name, h);
}

function setCurrent(ids) {
  curIds = ids || [];
  paint();
}

/* ---------------------------------------------------------------- history
 * Every change goes through change(): it snapshots the records first, so u and
 * Ctrl-r can step through adds, edits, deletes and :clear, several levels deep.
 */

function commit() {
  VH.store.set(KEY, items);
  paint();
  VH.emit('comments', {});
}

function change(label, fn) {
  var before = clone(items);
  var r = fn();
  past.push({ items: before, label: label });
  if (past.length > HISTORY) past.shift();
  future = [];
  commit();
  return r;
}

function restore(from, to) {
  if (!from.length) return null;
  var snap = from.pop();
  to.push({ items: clone(items), label: snap.label });
  items = snap.items;
  var doc = null;
  items.forEach(function (c) {
    if (!ranges[c.id] || c.detached) attachOne(doc || (doc = buildDoc()), c);
  });
  commit();
  return snap.label;
}

function plural(n, word) { return n + ' ' + word + (n === 1 ? '' : 's'); }

/* -------------------------------------------------------------------- API */

function byPosition(a, b) {
  return ((a.detached ? 1 : 0) - (b.detached ? 1 : 0)) ||
    (a.anchor.startLine - b.anchor.startLine) ||
    ((posOf[a.id] || 0) - (posOf[b.id] || 0)) ||
    (a.created - b.created);
}

VH.anchor = {
  fromRange: function (range) {
    if (!range) return null;
    var doc = buildDoc();
    var span = rangeSpan(doc, range);
    return span ? anchorOf(doc, span, false) : null;
  },
  fromLines: function (s, e) {
    var doc = buildDoc();
    if (!doc.count) return null;
    s = Math.max(1, Math.min(doc.count, s | 0));
    e = Math.max(s, Math.min(doc.count, (e == null ? s : e) | 0));
    return anchorOf(doc, linesSpan(doc, s, e), true);
  },
  toRange: function (anchor) {
    if (!anchor) return null;
    var doc = buildDoc();
    var hit = locate(doc, anchor);
    return hit ? spanRange(doc, hit) : null;
  }
};

VH.comments = {
  lastAttach: null,

  all: function () { return clone(items.slice().sort(byPosition)); },

  get: function (id) {
    var c = find(id);
    return c ? clone(c) : null;
  },

  at: function (line) {
    return clone(items.filter(function (c) {
      return !c.detached && c.anchor.startLine <= line && line <= c.anchor.endLine;
    }).sort(byPosition));
  },

  add: function (o) {
    var note = String(o && o.note != null ? o.note : '').trim();
    if (!note || !o.anchor) return null;
    var now = Date.now();
    var rec = { id: newId(), note: note, anchor: clone(o.anchor), created: now, updated: now };
    change('add comment', function () {
      items.push(rec);
      attachOne(buildDoc(), rec);
    });
    return clone(rec);
  },

  update: function (id, note) {
    var c = find(id);
    if (!c) return false;
    note = String(note == null ? '' : note).trim();
    if (!note) return VH.comments.remove(id);
    if (note === c.note) return true;
    change('edit comment', function () {
      c.note = note;
      c.updated = Date.now();
    });
    return true;
  },

  remove: function (ids) {
    ids = [].concat(ids);
    var hit = items.filter(function (c) { return ids.indexOf(c.id) >= 0; });
    if (!hit.length) return false;
    change(hit.length === 1 ? 'delete comment' : 'delete ' + plural(hit.length, 'comment'), function () {
      items = items.filter(function (c) { return ids.indexOf(c.id) < 0; });
    });
    return true;
  },

  clear: function () {
    var n = items.length;
    if (n) change('clear ' + plural(n, 'comment'), function () { items = []; });
    return n;
  },

  undo: function () { return restore(past, future) !== null; },
  redo: function () { return restore(future, past) !== null; },

  compose: compose,
  format: format,
  location: docLocation,

  copy: function (list) {
    list = list || VH.comments.all();
    if (!list.length) { VH.toast('No comments to copy'); return Promise.resolve(false); }
    return VH.clip.copy(format(list)).then(function (ok) {
      if (ok) VH.toast('Copied ' + plural(list.length, 'comment') + ' for the agent');
      return ok;
    });
  }
};

/* ----------------------------------------------------------------- editor
 * compose() opens the editor under the last commented line. It is insert mode
 * (the status line shows INSERT): core's dispatcher lets typed keys reach the
 * textarea and routes <CR> here; <S-CR> is not mapped, so the textarea gets its
 * newline. Esc, jk and jj go through core's leaveInsert(), which switches the
 * mode before it blurs; the 'mode' listener below then reads the textarea and
 * keeps what was typed. The textarea is focused on the next tick: focusing
 * inside the keydown that opened it lets the c of gcc land in the box on input
 * paths that deliver the character separately (CDP typing).
 */

var editor = null;  // {box, ta, anchor, whole, id, focused} while open

function clampLine(n) {
  return Math.max(1, Math.min(VH.lines.count(), n | 0));
}

function lineRef(a) {
  return 'L' + a.startLine + (a.endLine > a.startLine ? '-' + a.endLine : '');
}

// target: a Range (character visual, mouse), {start, end} lines (gcc, V), or
// {id} to edit a stored comment (panel). An identical existing anchor is edited.
function compose(target) {
  if (!target) return false;
  var doc = buildDoc();
  if (!doc.count) return false;
  var existing = null, span = null, whole = false;
  if (target.id) {
    existing = find(target.id);
    if (!existing) return false;
    whole = !!existing.anchor.whole;
    var hit = !existing.detached && locate(doc, existing.anchor);
    span = hit || null;
  } else if (target.startContainer) {
    span = rangeSpan(doc, target);
  } else if (target.start) {
    var s = clampLine(target.start), e = clampLine(target.end || target.start);
    span = linesSpan(doc, Math.min(s, e), Math.max(s, e));
    whole = true;
  }
  if (!existing && !span) { VH.toast('Nothing to comment on there'); return false; }
  var anchor = existing ? existing.anchor : anchorOf(doc, span, whole);
  if (!existing) {
    existing = items.filter(function (c) {
      return !c.detached && !!c.anchor.whole === whole && c.anchor.startLine === anchor.startLine &&
        c.anchor.endLine === anchor.endLine && c.anchor.quote === anchor.quote;
    })[0] || null;
  }
  finish('leave');
  open(anchor, span, whole, existing, doc);
  return true;
}

function open(anchor, span, whole, existing, doc) {
  var line = existing && existing.detached ? (VH.cursor.get() || 1) : anchor.endLine;
  if (VH.folds && VH.folds.reveal) VH.folds.reveal(line);
  var ta = VH.ui.h('textarea', { 'class': 'vh-editor-note', rows: '2', spellcheck: 'true',
                                 placeholder: 'Comment for the agent', 'aria-label': 'Comment' });
  ta.value = existing ? existing.note : '';
  var path = VH.lines.headingPath ? VH.lines.headingPath(anchor.startLine) : '';
  var quote = anchor.quote.length > 280 ? anchor.quote.slice(0, 280) + '\u2026' : anchor.quote;
  var box = VH.ui.h('div', { 'class': 'vh-editor', role: 'dialog', 'aria-label': 'Comment editor' }, [
    VH.ui.h('div', { 'class': 'vh-editor-head' }, [
      VH.ui.h('span', { 'class': 'vh-editor-ref', text: (existing && existing.detached ? 'detached, was ' : '') + lineRef(anchor) }),
      path ? VH.ui.h('span', { 'class': 'vh-editor-path', text: path }) : null,
      VH.ui.h('span', { 'class': 'vh-editor-state', text: existing ? 'edit' : 'new' })
    ]),
    quote ? VH.ui.h('div', { 'class': 'vh-editor-quote', text: quote }) : null,
    ta,
    VH.ui.h('div', { 'class': 'vh-editor-hint' }, [
      kbd('Enter'), ' save  ', kbd('Shift-Enter'), ' newline  ', kbd('Esc'), ' keep',
      existing ? '  \u00b7  empty + Enter deletes' : ''
    ])
  ]);
  // Clicks on the frame keep focus in the textarea, so they do not end the edit.
  box.addEventListener('mousedown', function (e) { if (e.target !== ta) e.preventDefault(); });
  ta.addEventListener('input', function () { grow(ta); });
  ta.addEventListener('focus', function () { if (editor && editor.ta === ta) editor.focused = true; });
  ta.addEventListener('blur', function () {
    // Focus moved elsewhere on the page (a click outside): keep the text, close.
    // A window blur leaves activeElement on the textarea, so switching apps does not.
    setTimeout(function () {
      if (!editor || editor.ta !== ta || document.activeElement === ta) return;
      finish('leave');
      if (VH.mode.get() === 'insert') VH.mode.set('normal');
    }, 0);
  });
  VH.ui.layer.appendChild(box);
  place(box, line);
  editor = { box: box, ta: ta, anchor: anchor, whole: whole, id: existing && existing.id };
  if (span && HL) setHighlight('vh-comment-draft', [spanRange(doc, span)], 2);
  VH.mode.set('insert');
  // Under a burst of input the browser runs this timer after queued key and
  // mouse events, so focus only if nothing has focused the textarea yet: once
  // catchUp or a click did, the reader may already have clicked away again.
  setTimeout(function () {
    if (!editor || editor.ta !== ta) return;
    if (!editor.focused) {
      ta.focus({ preventScroll: true });
      ta.setSelectionRange(ta.value.length, ta.value.length);
    }
    grow(ta);
    keepVisible(box);
  }, 0);
}

function kbd(t) { return VH.ui.h('kbd', { text: t }); }

function grow(ta) {
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight + 2, 240) + 'px';
}

// Under line n, aligned with the text column, as wide as the column allows.
function place(box, n) {
  var r = VH.lines.rect(n) || { bottom: 80, left: 80, width: 480 };
  var o = VH.ui.origin();
  var col = document.querySelector('main, article') || document.body;
  var cr = col.getBoundingClientRect();
  var left = Math.max(8, Math.min(r.left, cr.left));
  var width = Math.min(Math.max(cr.width, 320), 620, window.innerWidth - left - 12);
  box.style.top = (r.bottom - o.top + 8) + 'px';
  box.style.left = (left - o.left) + 'px';
  box.style.width = width + 'px';
}

// Keep the whole box clear of the fixed status line at the bottom.
function keepVisible(box) {
  var b = box.getBoundingClientRect();
  var over = b.bottom - (window.innerHeight - 40);
  if (over > 0) window.scrollBy({ top: Math.min(over, b.top - 8), left: 0, behavior: 'instant' });
}

// how: 'enter' saves, and an emptied existing comment is deleted; 'leave' (Esc,
// jk, jj, a click away) saves non-empty text and otherwise changes nothing.
function finish(how) {
  if (!editor) return;
  var ed = editor;
  editor = null;
  var note = ed.ta.value.trim();
  ed.box.remove();
  if (HL) CSS.highlights.delete('vh-comment-draft');
  var old = ed.id && find(ed.id);
  if (old) {
    if (note) VH.comments.update(ed.id, note);
    else if (how === 'enter') {
      VH.comments.remove(ed.id);
      VH.toast('Deleted comment \u2014 u to undo');
    }
  } else if (note) {
    VH.comments.add({ anchor: ed.anchor, note: note });
  }
}

VH.keys.map('insert', '<CR>', function () {
  var a = document.activeElement;
  if (!editor || (a !== editor.ta && VH.ui.isEditable(a))) return false;  // Enter in a page field
  finish('enter');
  VH.mode.set('normal');
}, { desc: 'save the comment (Shift-Enter: newline)', group: 'comments' });

// Keys typed before the next-tick focus lands (a fast typist, or a test driving
// CDP) would otherwise fall on <body>. The first printable key core did not
// consume focuses the textarea inside its own keydown, so its character goes
// in. The keydown that opened the editor was consumed (defaultPrevented), so
// the c of gcc never does.
function catchUp(e) {
  if (!editor || e.defaultPrevented || document.activeElement === editor.ta) return;
  if (!e.key || e.key.length !== 1 || e.ctrlKey || e.metaKey || e.altKey) return;
  editor.ta.focus({ preventScroll: true });
}

VH.on('mode', function (e) {
  if (editor && e.from === 'insert' && e.to !== 'insert') finish('leave');
  if (pop) closePopover();
});

/* ---------------------------------------------------------- K popover */

var pop = null;

function closePopover() {
  if (!pop) return;
  pop.remove();
  pop = null;
  setCurrent([]);
}

function showPopover() {
  if (pop) { closePopover(); return; }
  var n = VH.cursor.get();
  var list = VH.comments.at(n);
  if (!list.length) { VH.toast('No comment on this line'); return; }
  pop = VH.ui.h('div', { 'class': 'vh-pop', role: 'tooltip' }, list.map(function (c) {
    return VH.ui.h('div', { 'class': 'vh-pop-item' }, [
      VH.ui.h('div', { 'class': 'vh-pop-ref', text: lineRef(c.anchor) }),
      VH.ui.h('div', { 'class': 'vh-pop-note', text: c.note })
    ]);
  }).concat(VH.ui.h('div', { 'class': 'vh-pop-hint' }, [kbd('gcc'), ' edit  ', kbd('dc'), ' delete  ', kbd(']c'), ' next'])));
  VH.ui.layer.appendChild(pop);
  var r = VH.lines.rect(n), o = VH.ui.origin();
  pop.style.top = (r.bottom - o.top + 6) + 'px';
  pop.style.left = (r.left - o.left) + 'px';
  setCurrent(list.map(function (c) { return c.id; }));
  keepVisible(pop);
}

['escape', 'close', 'cursor', 'comments'].forEach(function (evt) {
  VH.on(evt, function () {
    if (pop) closePopover();
    else if (curIds.length && evt !== 'comments') setCurrent([]);
  });
});

/* ------------------------------------------------------------ normal keys */

function commentLine() {
  var n = VH.cursor.get();
  if (!n) return;
  var here = VH.comments.at(n);
  // gcc on a commented line edits: prefer the line-wise comment of exactly this line.
  var mine = here.filter(function (c) { return c.anchor.whole && c.anchor.startLine === n && c.anchor.endLine === n; })[0] || here[0];
  compose(mine ? { id: mine.id } : { start: n, end: n });
}

// ]c / [c: the count-th comment start after / before the cursor line, wrapping.
function jump(dir, count) {
  var starts = [];
  items.forEach(function (c) {
    if (!c.detached && starts.indexOf(c.anchor.startLine) < 0) starts.push(c.anchor.startLine);
  });
  if (!starts.length) { VH.toast('No comments'); return; }
  starts.sort(function (a, b) { return a - b; });
  var cur = VH.cursor.get(), n = cur, wrapped = false;
  for (var i = 0; i < (count || 1); i++) {
    var next = dir > 0 ? starts.filter(function (s) { return s > n; })[0]
                       : starts.filter(function (s) { return s < n; }).pop();
    if (next == null) { next = dir > 0 ? starts[0] : starts[starts.length - 1]; wrapped = true; }
    n = next;
  }
  if (VH.folds && VH.folds.reveal) VH.folds.reveal(n);
  VH.cursor.set(n, { jump: true });
  if (wrapped) VH.toast(dir > 0 ? 'Wrapped to the first comment' : 'Wrapped to the last comment');
  setCurrent(VH.comments.at(n).filter(function (c) { return c.anchor.startLine === n; }).map(function (c) { return c.id; }));
}

function deleteAtCursor() {
  var list = VH.comments.at(VH.cursor.get());
  if (!list.length) { VH.toast('No comment on this line'); return; }
  VH.comments.remove(list.map(function (c) { return c.id; }));
  VH.toast('Deleted ' + plural(list.length, 'comment') + ' \u2014 u to undo');
}

function undoKey(redo) {
  var stack = redo ? future : past;
  var label = stack.length ? stack[stack.length - 1].label : null;
  if (!(redo ? VH.comments.redo() : VH.comments.undo())) {
    VH.toast(redo ? 'Already at newest change' : 'Already at oldest change');
    return;
  }
  VH.toast((redo ? 'Redo: ' : 'Undo: ') + label);
}

function clearAll() {
  var n = VH.comments.clear();
  VH.toast(n ? 'Cleared ' + plural(n, 'comment') + ' \u2014 u to undo' : 'No comments to clear');
}

function copyAll() { VH.comments.copy(); }

VH.keys.map('normal', 'gcc', commentLine, { desc: 'comment the cursor line (edit if it has one)', group: 'comments' });
VH.keys.map('normal', ']c', function (c) { jump(1, c); }, { desc: 'next comment', group: 'comments' });
VH.keys.map('normal', '[c', function (c) { jump(-1, c); }, { desc: 'previous comment', group: 'comments' });
VH.keys.map('normal', 'K', showPopover, { desc: 'show the note on the cursor line', group: 'comments' });
VH.keys.map('normal', 'dc', deleteAtCursor, { desc: 'delete the comment(s) on the cursor line', group: 'comments' });
VH.keys.map('normal', 'u', function () { undoKey(false); }, { desc: 'undo a comment change', group: 'comments' });
VH.keys.map('normal', '<C-r>', function () { undoKey(true); }, { desc: 'redo a comment change', group: 'comments' });
VH.keys.map('normal', 'gy', copyAll, { desc: 'copy all comments for the agent (:w)', group: 'comments' });
VH.keys.map('normal', '<leader>cP', function () {
  var loc = docLocation();
  VH.clip.copy(loc).then(function (ok) { if (ok) VH.toast('Copied ' + loc); });
}, { desc: 'copy the page location', group: 'yank' });
VH.keys.map('normal', '<leader>cU', function () {
  var text = docText();
  VH.clip.copy(text).then(function (ok) { if (ok) VH.toast('Copied the document text (' + plural(VH.lines.count(), 'line') + ')'); });
}, { desc: 'copy the whole document text', group: 'yank' });

VH.commands.add('w', copyAll, 'copy all comments for the agent');
VH.commands.add('copy', copyAll, 'copy all comments for the agent');
VH.commands.add('clear', clearAll, 'delete all comments (u undoes)');

/* ----------------------------------------------------------------- export
 * PLAN.md "Export format": the owner's editor instruction syntax (> note,
 * @path#Lstart-end, fenced quote), the same shape tmcmt drafts use, so an agent
 * reads it with no explanation. Y in select.js prints the same block without
 * the header and the note.
 */

// The decoded filesystem path for file: pages, else the URL without its hash.
function docLocation() {
  var url = location.href.split('#')[0];
  if (location.protocol !== 'file:') return url;
  var p = location.pathname;
  try { p = decodeURIComponent(p); } catch (err) { /* keep it encoded */ }
  return /^\/[A-Za-z]:\//.test(p) ? p.slice(1) : p;  // file:///C:/x -> C:/x
}

// The file an agent edits, for the export's @ lines: the source path build.py
// baked (VIM_HTML.source) unless this page is being viewed from that very file;
// a docs upload's URL alone cannot lead a new session back to it. The export's
// header keeps the live URL. A page built without a source uses its own place.
function sourceLocation() {
  var here = docLocation();
  var src = VH.cfg.source && String(VH.cfg.source);
  if (!src) return here;
  var same = location.protocol === 'file:' && here.replace(/\\/g, '/') === src.replace(/\\/g, '/');
  return same ? here : src;
}

function block(c, loc) {
  var a = c.anchor;
  var ref = '#L' + a.startLine + (a.endLine > a.startLine ? '-' + a.endLine : '');
  var quote = a.quote.length > QUOTE_MAX ? a.quote.slice(0, QUOTE_MAX) + '\u2026' : a.quote;
  var fence = quote.indexOf('```') >= 0 ? '~~~~' : '```';
  var out = [];
  if (c.note) String(c.note).split('\n').forEach(function (l) { out.push('> ' + l); });
  out.push(c.detached ? '@' + loc + ' (detached; was ' + ref + ')' : '@' + loc + ref);
  out.push(fence, quote, fence);
  return out.join('\n');
}

// list: records as all() returns them. opts.header false drops the three header
// lines (Y uses that with note-less entries).
function format(list, opts) {
  var loc = sourceLocation();
  var parts = (list || []).map(function (c) { return block(c, loc); });
  if (opts && opts.header === false) return parts.join('\n\n');
  var head = ['Comments on "' + VH.cfg.docTitle + '"', location.href.split('#')[0],
              "Line numbers are the page's gutter lines."].join('\n');
  return [head].concat(parts).join('\n\n');
}

// <leader>cU: every gutter line as read, a blank line before each heading.
function docText() {
  var doc = buildDoc();
  var out = [];
  for (var n = 1; n <= doc.count; n++) {
    if (n > 1 && /^H[1-6]$/.test(VH.lines.el(n).tagName)) out.push('');
    out.push(doc.lines[n].text);
  }
  return out.join('\n');
}

/* ------------------------------------------------------------------- boot */

VH.init(function () {
  // Registered after core's capture listener (boot installs core's first), so
  // core has already consumed or passed the key when catchUp sees it.
  window.addEventListener('keydown', catchUp, true);
  attachAll();
  // A line model rebuilt with a different shape (C1 re-splitting a <pre>, a page
  // adding content) shifts line numbers: resolve every anchor again.
  VH.on('layout', function () {
    if (VH.lines.count() !== attachedCount) attachAll();
  });
});
