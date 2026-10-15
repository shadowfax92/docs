/* select.js -- visual modes, mouse selection and yank (piece E).
 *
 * Two visual modes, both ending in a comment (comments.js) or a yank:
 *   visual  'v', or any mouse drag-selection in normal mode. The selection is the
 *           browser's own: motions extend it with Selection.modify (character,
 *           word, lineboundary) or, for j k gg G } {, by moving its focus to
 *           another gutter line. Copy, find and the ::selection colour all work
 *           as usual because nothing is simulated.
 *   vline   'V'. Whole gutter lines from an anchor line to a head line, painted
 *           with the .vh-vline class (--vh-visual); no native selection.
 * In both the cursor line follows the moving end, so relative numbers and the
 * status line track it as in nvim.
 *
 *   gc c <CR>   VH.comments.compose(Range | {start, end})  -> editor (insert)
 *   y <leader>y copy the text (the doc text model's reading of it)
 *   Y           copy it as an agent reference: VH.comments.format block, no note
 *   <Esc>       back to normal; v / V toggle or switch kinds; o swaps the ends
 *
 * After a search, v starts at the match: search lands with
 * VH.cursor.set(n, {caret: range}) and caretOn() reads VH.cursor.caret().
 *
 * Normal-mode yanks live here too: yy / <leader>yy (cursor line text, count =
 * lines) and Y (cursor line as a reference). comments.js loads after this file,
 * so VH.comments / VH.anchor are only touched at key time, never at load.
 */

var vis = null;     // {kind: 'char', mouse} | {kind: 'line', anchor, head}
var painted = [];   // elements carrying .vh-vline
var btn = null;     // the floating comment button for mouse selections

function sel() { return window.getSelection(); }

function count() { return VH.lines.count(); }

function clampLine(n) { return Math.max(1, Math.min(count(), n)); }

// One gutter line further in direction step, skipping closed folds when C1
// provides that (VH.lines.next).
function step(n, dir, times) {
  for (var i = 0; i < (times || 1); i++) {
    var m = VH.lines.next ? VH.lines.next(n, dir) : clampLine(n + dir);
    if (!m || m === n) break;
    n = m;
  }
  return n;
}

function headingLines() {
  if (VH.lines.headings) return VH.lines.headings().map(function (h) { return h.line; });
  var out = [];
  for (var n = 1; n <= count(); n++) if (/^H[1-6]$/.test(VH.lines.el(n).tagName)) out.push(n);
  return out;
}

function nextHeading(n, dir, times) {
  var hs = headingLines();
  for (var i = 0; i < (times || 1); i++) {
    var hit = dir > 0 ? hs.filter(function (h) { return h > n; })[0] : hs.filter(function (h) { return h < n; }).pop();
    n = hit == null ? (dir > 0 ? count() : 1) : hit;
  }
  return n;
}

// First and last non-blank raw offsets of a line (VH.text offsets).
function firstText(el) {
  var i = el.textContent.search(/\S/);
  return i < 0 ? 0 : i;
}

function lastText(el) {
  return el.textContent.replace(/\s+$/, '').length;
}

function point(el, raw) {
  var r = VH.text.rangeFrom(el, raw, raw);
  return [r.startContainer, r.startOffset];
}

function inDocument(node) {
  return !!node && !VH.ui.isOurs(node) && !VH.ui.isEditable(node.nodeType === 1 ? node : node.parentElement);
}

/* ------------------------------------------------------- character visual */

// Where v starts on cursor line n, first match wins:
//   1. VH.cursor.caret(): the Range a search landed with (search calls
//      VH.cursor.set(n, {caret}); motions.js keeps it until the cursor moves).
//      Search may clear the native selection, so this is the reliable source.
//   2. a collapsed native selection on the line (a click put it there);
//   3. null, and the caller starts at the line's first non-blank.
// Either source counts only when it lies on line n. VH.cursor.caret is optional,
// so this works against a motions.js that does not provide it.
function caretOn(n) {
  var c = VH.cursor.caret && VH.cursor.caret();
  if (c && c.startContainer && c.startContainer.isConnected && VH.lines.of(c.startContainer) === n) {
    return [c.startContainer, c.startOffset];
  }
  var s = sel();
  if (s.rangeCount && inDocument(s.focusNode) && VH.lines.of(s.focusNode) === n) {
    var r = s.getRangeAt(0);
    return [r.startContainer, r.startOffset];
  }
  return null;
}

// v selects one character from caretOn(), else from the first non-blank.
function startChar() {
  var n = VH.cursor.get();
  if (!n) return;
  var el = VH.lines.el(n);
  if (!el.textContent.trim()) { startLine(); return; }
  var s = sel();
  var at = caretOn(n) || point(el, firstText(el));
  s.setBaseAndExtent(at[0], at[1], at[0], at[1]);
  s.modify('extend', 'forward', 'character');
  vis = { kind: 'char' };
  VH.mode.set('visual');
}

function modify(dir, unit, times) {
  var s = sel();
  for (var i = 0; i < (times || 1); i++) s.modify('extend', dir, unit);
  follow();
}

function focusLine() {
  var s = sel();
  return (s.rangeCount && VH.lines.of(s.focusNode)) || VH.cursor.get();
}

// The cursor line tracks the selection's moving end.
function follow() {
  hideButton();
  var n = focusLine();
  if (n && n !== VH.cursor.get()) VH.cursor.set(n);
}

// j / k: the focus goes to the same column (counted from the first non-blank)
// of another gutter line.
function vertical(dir, times) {
  var s = sel();
  if (!s.rangeCount) return;
  var n = focusLine();
  var el = VH.lines.el(n);
  var col = el.contains(s.focusNode) ? VH.text.offsetIn(el, s.focusNode, s.focusOffset) - firstText(el) : 0;
  var m = step(n, dir, times);
  if (m === n) return;
  var to = VH.lines.el(m);
  var raw = Math.max(firstText(to), Math.min(firstText(to) + Math.max(col, 0), lastText(to)));
  var p = point(to, raw);
  s.extend(p[0], p[1]);
  follow();
}

function focusTo(m, atEnd) {
  var to = VH.lines.el(m);
  if (!to) return;
  var p = point(to, atEnd ? lastText(to) : firstText(to));
  sel().extend(p[0], p[1]);
  follow();
}

function swapEnds() {
  var s = sel();
  if (!s.rangeCount) return;
  s.setBaseAndExtent(s.focusNode, s.focusOffset, s.anchorNode, s.anchorOffset);
  follow();
}

/* ------------------------------------------------------------ line visual */

function startLine(from) {
  var n = from || VH.cursor.get();
  if (!n) return;
  vis = { kind: 'line', anchor: n, head: n };
  var s = sel();
  if (s.rangeCount && inDocument(s.anchorNode)) s.removeAllRanges();
  paintLines();
  VH.mode.set('vline');
}

function lineBounds() {
  return [Math.min(vis.anchor, vis.head), Math.max(vis.anchor, vis.head)];
}

function paintLines() {
  unpaint();
  if (!vis || vis.kind !== 'line') return;
  var b = lineBounds();
  for (var n = b[0]; n <= b[1]; n++) {
    var el = VH.lines.el(n);
    if (el) { el.classList.add('vh-vline'); painted.push(el); }
  }
}

function unpaint() {
  painted.forEach(function (el) { el.classList.remove('vh-vline'); });
  painted = [];
}

function moveHead(n) {
  vis.head = clampLine(n);
  paintLines();
  VH.cursor.set(vis.head);
}

/* --------------------------------------------------------- switching kinds */

// v in vline (or V in visual) keeps both ends and changes the kind, as in vim.
function toChar() {
  var b = lineBounds();
  var forward = vis.head >= vis.anchor;
  var first = VH.lines.el(b[0]), last = VH.lines.el(b[1]);
  var p = point(first, firstText(first)), q = point(last, lastText(last));
  unpaint();
  vis = { kind: 'char' };
  if (forward) sel().setBaseAndExtent(p[0], p[1], q[0], q[1]);
  else sel().setBaseAndExtent(q[0], q[1], p[0], p[1]);
  VH.mode.set('visual');
}

function toLine() {
  var s = sel();
  var a = (s.rangeCount && VH.lines.of(s.anchorNode)) || VH.cursor.get();
  var h = focusLine();
  hideButton();
  startLine(a);
  if (h !== a) moveHead(h);
}

function endVisual() {
  unpaint();
  hideButton();
  var s = sel();
  if (vis && vis.kind === 'char' && s.rangeCount && inDocument(s.anchorNode)) s.removeAllRanges();
  vis = null;
}

// Any way out of visual (Esc, a comment opening the editor, a click into a page
// field) drops the selection; switching between visual and vline does not.
VH.on('mode', function (e) {
  var was = e.from === 'visual' || e.from === 'vline';
  var is = e.to === 'visual' || e.to === 'vline';
  if (was && !is) endVisual();
});

/* ------------------------------------------------------- comment and yank */

// What the current visual selection covers, as compose() takes it.
function target() {
  if (!vis) return null;
  if (vis.kind === 'line') { var b = lineBounds(); return { start: b[0], end: b[1] }; }
  var s = sel();
  return s.rangeCount && !s.isCollapsed ? s.getRangeAt(0).cloneRange() : null;
}

function targetAnchor(t) {
  if (!t) return null;
  return t.startContainer ? VH.anchor.fromRange(t) : VH.anchor.fromLines(t.start, t.end);
}

function commentVisual() {
  var t = target();
  if (!t) { VH.mode.set('normal'); return; }
  if (VH.comments.compose(t) === false) VH.mode.set('normal');
}

function plural(n, word) { return n + ' ' + word + (n === 1 ? '' : 's'); }

function yankText(anchor, what) {
  if (!anchor) { VH.toast('Nothing to yank'); return; }
  VH.clip.copy(anchor.quote).then(function (ok) { if (ok) VH.toast('Yanked ' + what); });
}

function yankRef(anchor) {
  if (!anchor) { VH.toast('Nothing to yank'); return; }
  var text = VH.comments.format([{ anchor: anchor }], { header: false });
  VH.clip.copy(text).then(function (ok) {
    var a = anchor;
    if (ok) VH.toast('Yanked L' + a.startLine + (a.endLine > a.startLine ? '-' + a.endLine : '') + ' as a reference');
  });
}

// vim leaves the cursor at the start of what was yanked.
function leave(anchor) {
  VH.mode.set('normal');
  if (anchor) VH.cursor.set(anchor.startLine, { scroll: false });
}

function yankVisual(asRef) {
  var t = target();
  var anchor = targetAnchor(t);
  if (asRef) yankRef(anchor);
  else if (anchor) {
    var n = anchor.endLine - anchor.startLine + 1;
    yankText(anchor, vis.kind === 'line' || n > 1 ? plural(n, 'line') : plural(anchor.quote.length, 'character'));
  } else yankText(null);
  leave(anchor);
}

function cursorLines(times) {
  var n = VH.cursor.get();
  return n ? VH.anchor.fromLines(n, n + (times || 1) - 1) : null;
}

/* ------------------------------------------------------- mouse selection
 * A drag (or double/triple click) that leaves a non-empty selection in the
 * document while in normal mode enters visual with that selection as is, and a
 * small button at its end comments it in one click. In visual, a plain click
 * that collapses the selection goes back to normal. Insert mode is left alone:
 * there the page behaves like any web page.
 */

function onMouseUp(e) {
  if (e.button !== 0 || VH.ui.isOurs(e.target)) return;
  // Double and triple clicks settle their selection after mouseup.
  setTimeout(settleMouse, 0);
}

function settleMouse() {
  var m = VH.mode.get();
  if (m !== 'normal' && m !== 'visual' && m !== 'vline') return;
  var s = sel();
  var has = s.rangeCount && !s.isCollapsed && inDocument(s.anchorNode) && inDocument(s.focusNode) &&
    /\S/.test(s.toString());
  if (!has) {
    if (m !== 'normal') VH.mode.set('normal');
    return;
  }
  if (m === 'vline') unpaint();
  vis = { kind: 'char', mouse: true };
  if (m !== 'visual') VH.mode.set('visual');
  var n = focusLine();
  if (n && n !== VH.cursor.get()) VH.cursor.set(n, { scroll: false });
  showButton();
}

function showButton() {
  hideButton();
  var s = sel();
  if (!s.rangeCount) return;
  var rect = null;
  try {
    var r = document.createRange();
    r.setStart(s.focusNode, s.focusOffset);
    rect = r.getBoundingClientRect();
    if (!rect || (!rect.width && !rect.height)) {
      var rects = s.getRangeAt(0).getClientRects();
      rect = rects[rects.length - 1];
    }
  } catch (err) { rect = null; }
  if (!rect) return;
  var o = VH.ui.origin();
  btn = VH.ui.h('button', { type: 'button', 'class': 'vh-sel-btn', title: 'Comment on the selection (gc)',
                            'aria-label': 'Comment on the selection' },
    [VH.ui.h('span', { 'class': 'vh-sel-btn-icon', 'aria-hidden': 'true', text: '+' }), 'Comment',
     VH.ui.h('kbd', { text: 'gc' })]);
  // mousedown would collapse the selection before click fires.
  btn.addEventListener('mousedown', function (e) { e.preventDefault(); });
  btn.addEventListener('click', function (e) { e.preventDefault(); commentVisual(); });
  VH.ui.layer.appendChild(btn);
  var left = Math.min(rect.right + 4, window.innerWidth - btn.offsetWidth - 12);
  btn.style.top = (rect.bottom - o.top + 4) + 'px';
  btn.style.left = (Math.max(8, left) - o.left) + 'px';
}

function hideButton() {
  if (btn) { btn.remove(); btn = null; }
}

VH.init(function () {
  document.addEventListener('mouseup', onMouseUp, true);
});

/* ----------------------------------------------------------------- keymap */

var G = 'visual';
var V = ['visual', 'vline'];

VH.keys.map('normal', 'v', startChar, { desc: 'visual mode (characters)', group: G });
VH.keys.map('normal', 'V', function () { startLine(); }, { desc: 'visual line mode', group: G });

VH.keys.map('visual', 'v', function () { VH.mode.set('normal'); }, { desc: 'leave visual', group: G });
VH.keys.map('visual', 'V', toLine, { desc: 'switch to visual line', group: G });
VH.keys.map('vline', 'V', function () { VH.mode.set('normal'); }, { desc: 'leave visual line', group: G });
VH.keys.map('vline', 'v', toChar, { desc: 'switch to visual (characters)', group: G });

// character motions
[['h', 'backward', 'character'], ['<Left>', 'backward', 'character'],
 ['l', 'forward', 'character'], ['<Right>', 'forward', 'character'],
 ['w', 'forward', 'word'], ['e', 'forward', 'word'], ['b', 'backward', 'word'],
 ['0', 'backward', 'lineboundary'], ['$', 'forward', 'lineboundary']
].forEach(function (m) {
  VH.keys.map('visual', m[0], function (c) { modify(m[1], m[2], c); },
    { desc: 'extend ' + m[1] + ' by ' + m[2], group: G });
});
VH.keys.map('visual', 'j', function (c) { vertical(1, c); }, { desc: 'extend down a line', group: G });
VH.keys.map('visual', '<Down>', function (c) { vertical(1, c); }, { desc: 'extend down a line', group: G });
VH.keys.map('visual', 'k', function (c) { vertical(-1, c); }, { desc: 'extend up a line', group: G });
VH.keys.map('visual', '<Up>', function (c) { vertical(-1, c); }, { desc: 'extend up a line', group: G });
VH.keys.map('visual', 'gg', function (c) { focusTo(clampLine(c || 1), false); }, { desc: 'extend to the first line (or line {count})', group: G });
VH.keys.map('visual', 'G', function (c) { focusTo(clampLine(c || count()), !c); }, { desc: 'extend to the last line (or line {count})', group: G });
VH.keys.map('visual', '}', function (c) { focusTo(nextHeading(focusLine(), 1, c), false); }, { desc: 'extend to the next heading', group: G });
VH.keys.map('visual', '{', function (c) { focusTo(nextHeading(focusLine(), -1, c), false); }, { desc: 'extend to the previous heading', group: G });
VH.keys.map('visual', 'o', swapEnds, { desc: 'swap the ends of the selection', group: G });

// line motions
VH.keys.map('vline', 'j', function (c) { moveHead(step(vis.head, 1, c)); }, { desc: 'extend down a line', group: G });
VH.keys.map('vline', '<Down>', function (c) { moveHead(step(vis.head, 1, c)); }, { desc: 'extend down a line', group: G });
VH.keys.map('vline', 'k', function (c) { moveHead(step(vis.head, -1, c)); }, { desc: 'extend up a line', group: G });
VH.keys.map('vline', '<Up>', function (c) { moveHead(step(vis.head, -1, c)); }, { desc: 'extend up a line', group: G });
VH.keys.map('vline', 'gg', function (c) { moveHead(c || 1); }, { desc: 'extend to the first line (or line {count})', group: G });
VH.keys.map('vline', 'G', function (c) { moveHead(c || count()); }, { desc: 'extend to the last line (or line {count})', group: G });
VH.keys.map('vline', '}', function (c) { moveHead(nextHeading(vis.head, 1, c)); }, { desc: 'extend to the next heading', group: G });
VH.keys.map('vline', '{', function (c) { moveHead(nextHeading(vis.head, -1, c)); }, { desc: 'extend to the previous heading', group: G });
VH.keys.map('vline', 'o', function () {
  var a = vis.anchor;
  vis.anchor = vis.head;
  moveHead(a);
}, { desc: 'swap the ends of the selection', group: G });

// both
['gc', 'c', '<CR>'].forEach(function (seq) {
  VH.keys.map(V, seq, commentVisual, { desc: 'comment the selection', group: 'comments' });
});
VH.keys.map(V, 'y', function () { yankVisual(false); }, { desc: 'yank the selection to the clipboard', group: 'yank' });
VH.keys.map(V, '<leader>y', function () { yankVisual(false); }, { desc: 'yank the selection to the clipboard', group: 'yank' });
VH.keys.map(V, 'Y', function () { yankVisual(true); }, { desc: 'yank the selection as an agent reference', group: 'yank' });
VH.keys.map(V, '<Esc>', function () { VH.mode.set('normal'); }, { desc: 'back to normal mode', group: G });

// normal-mode yanks
function yankLines(c) {
  var a = cursorLines(c);
  yankText(a, a ? plural(a.endLine - a.startLine + 1, 'line') : '');
}
VH.keys.map('normal', 'yy', yankLines, { desc: 'yank the cursor line ({count} lines)', group: 'yank' });
VH.keys.map('normal', '<leader>yy', yankLines, { desc: 'yank the cursor line ({count} lines)', group: 'yank' });
VH.keys.map('normal', 'Y', function (c) { yankRef(cursorLines(c)); },
  { desc: 'yank the cursor line as an agent reference', group: 'yank' });
