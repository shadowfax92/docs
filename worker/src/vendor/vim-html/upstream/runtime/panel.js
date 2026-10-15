/* panel.js -- the comments sidebar (piece F).
 *
 * A right-side list of every comment in document order, for reviewing,
 * selectively copying, deleting and editing them before the export goes to an
 * agent. Opened by <leader>e, :comments, or the status line's comment count
 * (chrome.js calls VH.panel.toggle()).
 *
 * Mode coupling: the panel is open exactly while the mode is 'panel', so the
 * keymap below owns j/k/x/y/dd/... and nothing reaches the document. Another
 * mode taking over (a click into the page, the help overlay, :q's 'close')
 * closes it. The one exception is an edit: e/i hand the comment to
 * VH.comments.compose, whose editor takes insert mode; the panel hides until
 * the editor gives insert up, then comes back on the same row.
 *
 * Everything goes through comments.js's API: all, remove([ids]) (one undo step
 * however many are marked), clear, undo, format, and compose({id}) for edits.
 * comments.js owns the records and the undo history; the panel owns view state
 * only: the current row, the marked ids, and whether it has made a change the
 * Undo button can take back.
 */

var MODE = 'panel';
var ui = null;        // DOM refs, built on first open
var rows = [];        // VH.comments.all() as last rendered
var cur = 0;          // index of the current row
var marked = {};      // id -> true
var changed = 0;      // changes made from this opening of the panel, not yet undone
var isOpen = false;
var editing = null;   // {id, before} while the comment editor holds insert mode
var peeked = [];      // document line elements carrying .vh-peek

var ICONS = {
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  trash: '<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
  check: '<path d="M20 6 9 17l-5-5"/>'
};

function icon(name) {
  var s = document.createElement('span');
  s.className = 'vh-i';
  s.setAttribute('aria-hidden', 'true');
  s.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + ICONS[name] + '</svg>';
  return s;
}

function kbd(text) {
  return VH.ui.h('span', { 'class': 'vh-kbd', text: text });
}

function plural(n, word) {
  return n + ' ' + word + (n === 1 ? '' : 's');
}

// Buttons never take focus: a focused button would also act on the Space and
// Enter that the keymap uses, and a page field the reader was typing in keeps
// its caret.
function button(cls, label, name, onclick, title) {
  var b = VH.ui.h('button', { type: 'button', 'class': 'vh-pbtn ' + cls, title: title || null,
                             'aria-label': label ? null : title });
  if (name) b.appendChild(icon(name));
  if (label) b.appendChild(VH.ui.h('span', { text: label }));
  b.addEventListener('mousedown', function (e) { e.preventDefault(); });
  b.addEventListener('click', function (e) { e.stopPropagation(); onclick(e); });
  return b;
}

/* -------------------------------------------------------------------- view */

function build() {
  var h = VH.ui.h;
  ui = {};
  ui.n = h('span', { 'class': 'vh-panel-n' });
  ui.sel = h('span', { 'class': 'vh-panel-sel' });
  ui.copySel = button('vh-act-copysel', 'Copy selected', 'copy', function () { copyList(markedRows()); },
                      'Copy the marked comments for the agent (y)');
  ui.copyAll = button('vh-act-copyall', 'Copy all', 'copy', function () { copyList(rows); },
                      'Copy every comment for the agent (Y)');
  ui.clear = button('vh-act-clear vh-danger', 'Clear all', 'trash', clearAll, 'Delete every comment (D)');
  ui.undo = button('vh-act-undo', 'Undo', 'undo', undo, 'Undo the last change (u)');
  ui.list = h('div', { 'class': 'vh-panel-list', role: 'listbox', 'aria-multiselectable': 'true',
                       'aria-label': 'Comments', tabindex: '-1' });
  ui.empty = h('div', { 'class': 'vh-panel-empty', hidden: true }, [
    h('p', { 'class': 'vh-panel-empty-head', text: 'No comments yet.' }),
    h('p', null, ['Select text with ', kbd('v'), ' or whole lines with ', kbd('V'), ', then press ',
                  kbd('gc'), '. Or press ', kbd('gcc'), ' to comment the cursor line.']),
    h('p', null, ['With the mouse, drag over some text and click Comment.']),
    h('p', { 'class': 'vh-panel-empty-q' }, [kbd('q'), ' closes this sidebar.'])
  ]);
  var hints = [['j k', 'move'], ['x', 'mark'], ['y', 'copy'], ['Y', 'all'], ['dd', 'delete'],
               ['D', 'clear'], ['e', 'edit'], ['u', 'undo'], ['Enter', 'jump'], ['q', 'close']];
  ui.root = h('div', { id: 'vh-panel', 'class': 'vh-panel', role: 'complementary', 'aria-label': 'Comments', hidden: true }, [
    h('div', { 'class': 'vh-panel-head' }, [
      h('span', { 'class': 'vh-panel-title', text: 'Comments' }), ui.n, ui.sel,
      button('vh-panel-close', '', 'x', function () { close(); }, 'Close (q)')
    ]),
    h('div', { 'class': 'vh-panel-tools' }, [ui.copySel, ui.copyAll, ui.clear, ui.undo]),
    ui.list,
    ui.empty,
    h('div', { 'class': 'vh-panel-keys' }, hints.map(function (k) {
      return h('span', { 'class': 'vh-panel-hint' }, [kbd(k[0]), ' ' + k[1]]);
    }))
  ]);
  VH.ui.layer.appendChild(ui.root);
}

function ref(a) {
  return 'L' + a.startLine + (a.endLine > a.startLine ? '-' + a.endLine : '');
}

// The section a comment sits in, without the document title the status line
// already shows.
function crumb(c) {
  if (c.detached || !VH.lines || !VH.lines.sectionPath) return '';
  return VH.lines.sectionPath(c.anchor.startLine);
}

function rowEl(c, i) {
  var h = VH.ui.h;
  var a = c.anchor || {};
  var check = h('span', { 'class': 'vh-pi-check', role: 'checkbox', 'aria-label': 'Select', title: 'Select (x)' },
                [icon('check')]);
  check.addEventListener('click', function (e) { e.stopPropagation(); setCur(i); toggleMark(c.id); });
  var refEl = h('button', { type: 'button', 'class': 'vh-pi-ref',
                            text: c.detached ? 'detached \u00b7 was ' + ref(a) : ref(a),
                            title: c.detached ? 'Its text is no longer in the page' : 'Jump to the line (Enter)' });
  refEl.addEventListener('mousedown', function (e) { e.preventDefault(); });
  refEl.addEventListener('click', function (e) { e.stopPropagation(); jump(i); });
  var where = crumb(c);
  var quote = VH.text.norm(a.quote || '');
  var body = h('div', { 'class': 'vh-pi-body' }, [
    h('div', { 'class': 'vh-pi-meta' }, [refEl, where ? h('span', { 'class': 'vh-pi-path', text: where }) : null]),
    quote ? h('div', { 'class': 'vh-pi-quote', text: quote.length > 240 ? quote.slice(0, 240) + '\u2026' : quote }) : null,
    h('div', { 'class': 'vh-pi-note', text: c.note })
  ]);
  var acts = h('div', { 'class': 'vh-pi-acts' }, [
    button('vh-pi-edit', '', 'edit', function () { setCur(i); edit(); }, 'Edit the note (e)'),
    button('vh-pi-del vh-danger', '', 'trash', function () { setCur(i); removeIds([c.id]); }, 'Delete (dd)')
  ]);
  var el = h('div', { 'class': 'vh-pi' + (c.detached ? ' vh-detached' : ''), role: 'option',
                      id: 'vh-pi-' + i, 'data-id': c.id }, [check, body, acts]);
  el.addEventListener('click', function () { setCur(i); });
  el.addEventListener('dblclick', function () { jump(i); });
  return el;
}

// Rebuild the rows from the store; the current row follows its comment by id.
function render() {
  if (!ui) return;
  var keep = rows[cur] && rows[cur].id;
  rows = VH.comments ? VH.comments.all() : [];
  var ids = {};
  rows.forEach(function (c) { ids[c.id] = true; });
  Object.keys(marked).forEach(function (id) { if (!ids[id]) delete marked[id]; });
  var at = keep ? indexOf(keep) : -1;
  cur = at >= 0 ? at : Math.max(0, Math.min(cur, rows.length - 1));
  ui.list.textContent = '';
  rows.forEach(function (c, i) { ui.list.appendChild(rowEl(c, i)); });
  paint();
}

function indexOf(id) {
  for (var i = 0; i < rows.length; i++) if (rows[i].id === id) return i;
  return -1;
}

// Classes, counts and button states, without rebuilding the rows.
function paint() {
  var n = 0;
  Array.prototype.forEach.call(ui.list.children, function (el, i) {
    var on = !!marked[rows[i].id];
    if (on) n++;
    el.classList.toggle('vh-on', on);
    el.classList.toggle('vh-cur', i === cur);
    el.setAttribute('aria-selected', on ? 'true' : 'false');
    el.firstChild.setAttribute('aria-checked', on ? 'true' : 'false');
  });
  if (rows.length) ui.list.setAttribute('aria-activedescendant', 'vh-pi-' + cur);
  else ui.list.removeAttribute('aria-activedescendant');
  ui.n.textContent = String(rows.length);
  ui.sel.textContent = n ? n + ' selected' : '';
  ui.sel.hidden = !n;
  ui.empty.hidden = rows.length > 0;
  ui.list.hidden = !rows.length;
  ui.copySel.disabled = !n;
  ui.copySel.lastChild.textContent = n ? 'Copy ' + n + ' selected' : 'Copy selected';
  ui.copyAll.disabled = ui.clear.disabled = !rows.length;
  ui.undo.hidden = !changed;
}

function setCur(i) {
  if (!rows.length) return;
  cur = Math.max(0, Math.min(rows.length - 1, i));
  paint();
  var el = ui.list.children[cur];
  if (el) {
    var L = ui.list;
    var top = el.offsetTop;
    var bottom = top + el.offsetHeight;
    if (top < L.scrollTop) L.scrollTop = top;
    else if (bottom > L.scrollTop + L.clientHeight) L.scrollTop = bottom - L.clientHeight;
  }
  peek();
}

/* ------------------------------------------------------------------- peek
 * While the sidebar leaves part of the document visible (desktop widths), the
 * current comment's lines are outlined and scrolled into view, like a
 * quickfix preview. Lines inside a closed fold are not opened for a preview.
 */

var STATUS_H = 28;

function unpeek() {
  peeked.forEach(function (el) { el.classList.remove('vh-peek'); });
  peeked = [];
}

function lineEls(a) {
  var out = [];
  if (!VH.lines) return out;
  for (var n = a.startLine; n <= Math.min(a.endLine || a.startLine, a.startLine + 60); n++) {
    var el = VH.lines.el(n);
    if (el) out.push(el);
  }
  return out;
}

function hiddenLine(n) {
  return !!(VH.lines && VH.lines.hidden && VH.lines.hidden(n));
}

function bringIntoView(el) {
  var r = el.getBoundingClientRect();
  var bottom = window.innerHeight - STATUS_H;
  if (r.top >= 0 && r.bottom <= bottom) return;
  window.scrollBy({ top: r.top + r.height / 2 - bottom / 2, left: 0, behavior: 'instant' });
}

function peek() {
  unpeek();
  var c = rows[cur];
  if (!isOpen || editing || !c || c.detached || hiddenLine(c.anchor.startLine)) return;
  if (ui.root.getBoundingClientRect().left < 240) return;  // the sidebar covers the page
  peeked = lineEls(c.anchor);
  peeked.forEach(function (el) { el.classList.add('vh-peek'); });
  if (peeked[0]) bringIntoView(peeked[0]);
}

/* ---------------------------------------------------------------- actions */

function markedRows() {
  return rows.filter(function (c) { return marked[c.id]; });
}

// The marked comments, or the current one when nothing is marked.
function chosen() {
  var m = markedRows();
  return m.length ? m : rows[cur] ? [rows[cur]] : [];
}

function toggleMark(id) {
  if (marked[id]) delete marked[id]; else marked[id] = true;
  paint();
}

// Called synchronously from a key or click handler, so the clipboard write
// keeps the reader's user activation.
function copyList(list) {
  if (!list.length) { VH.toast('No comments to copy'); return; }
  var n = list.length;
  VH.clip.copy(VH.comments.format(list)).then(function (ok) {
    if (ok) VH.toast('Copied ' + plural(n, 'comment') + ' for the agent');
  });
}

function removeIds(ids) {
  if (!ids.length) { VH.toast('No comments to delete'); return; }
  ids.forEach(function (id) { delete marked[id]; });
  VH.comments.remove(ids);
  changed++;
  paint();
  VH.toast('Deleted ' + plural(ids.length, 'comment') + ' \u00b7 u undoes');
}

function clearAll() {
  var n = rows.length;
  if (!n) { VH.toast('No comments to clear'); return; }
  marked = {};
  VH.comments.clear();
  changed++;
  paint();
  VH.toast('Cleared ' + plural(n, 'comment') + ' \u00b7 u undoes');
}

function snapshot() {
  return JSON.stringify(VH.comments ? VH.comments.all() : []);
}

function undo() {
  var ok = VH.comments.undo() !== false;
  if (ok && changed) changed--;
  paint();
  VH.toast(ok ? 'Undone' : 'Nothing to undo');
}

function jump(i) {
  var c = rows[i == null ? cur : i];
  if (!c) return;
  if (c.detached) { VH.toast('This comment is detached: its text is no longer in the page'); return; }
  var n = c.anchor.startLine;
  close();
  if (VH.folds && VH.folds.reveal) VH.folds.reveal(n);
  if (VH.cursor) VH.cursor.set(n);
}

// The editor belongs to comments.js: compose({id}) opens it on that comment
// (a detached one included) and takes insert mode; the 'mode' listener below
// brings the panel back once insert ends.
function edit() {
  var c = rows[cur];
  if (!c) return;
  editing = { id: c.id, before: snapshot() };
  unpeek();
  ui.root.hidden = true;
  var first = !c.detached && VH.lines && VH.lines.el(c.anchor.startLine);
  if (first && !hiddenLine(c.anchor.startLine)) bringIntoView(first);
  var ok = false;
  try { ok = VH.comments.compose({ id: c.id }) !== false; } catch (err) { VH.error('panel edit', err); }
  if (!ok || VH.mode.get() === MODE) {  // no editor came up: stay in the panel
    editing = null;
    ui.root.hidden = false;
    peek();
  }
}

function resume() {
  if (!isOpen || !editing) return;
  var ed = editing;
  editing = null;
  if (snapshot() !== ed.before) changed++;
  if (VH.mode.get() !== 'normal') { hide(); return; }  // something else took over
  ui.root.hidden = false;
  render();
  VH.mode.set(MODE);
  var at = indexOf(ed.id);
  setCur(at >= 0 ? at : cur);
}

/* ------------------------------------------------------------ open / close */

function nearCursor() {
  var line = VH.cursor ? VH.cursor.get() : 0;
  for (var i = 0; i < rows.length; i++) {
    if (!rows[i].detached && rows[i].anchor.endLine >= line) return i;
  }
  return Math.max(0, rows.length - 1);
}

function open() {
  if (isOpen) return;
  if (!ui) build();
  // A page field keeping focus would turn the panel's keys into typing.
  var a = document.activeElement;
  if (a && a !== document.body && VH.ui.isEditable(a) && !VH.ui.isOurs(a) && a.blur) a.blur();
  isOpen = true;
  changed = 0;
  rows = [];
  render();
  ui.root.hidden = false;
  VH.mode.set(MODE);
  setCur(nearCursor());
}

// The UI half of closing; the mode is left to whoever took over.
function hide() {
  if (!isOpen) return;
  isOpen = false;
  editing = null;
  changed = 0;
  unpeek();
  ui.root.hidden = true;
}

function close() {
  hide();
  if (VH.mode.get() === MODE) VH.mode.set('normal');
}

VH.panel = {
  open: open,
  close: close,
  toggle: function () { if (isOpen) close(); else open(); },
  isOpen: function () { return isOpen; }
};

VH.on('mode', function (e) {
  if (!isOpen) return;
  if (editing) {
    if (e.from === 'insert' && e.to !== MODE) setTimeout(resume, 0);
    return;
  }
  if (e.from === MODE && e.to !== MODE) hide();
});

VH.on('comments', function () { if (isOpen) render(); });
VH.on('close', close);

VH.init(function () {
  // A click on the document while the sidebar is open goes to the document.
  // The page scrollbar reports <html> as its target; dragging it keeps the sidebar.
  document.addEventListener('pointerdown', function (e) {
    if (isOpen && !editing && e.target !== document.documentElement && !VH.ui.isOurs(e.target)) close();
  }, true);
});

/* ------------------------------------------------------------------ keymap */

var G = 'sidebar';

VH.keys.map('normal', '<leader>e', function () { VH.panel.toggle(); }, { desc: 'comments sidebar', group: G });
VH.commands.add('comments', function () { VH.panel.toggle(); }, 'toggle the comments sidebar');

function down(c) { setCur(cur + (c || 1)); }
function up(c) { setCur(cur - (c || 1)); }
function markNext(c) {
  for (var i = 0; i < (c || 1) && rows[cur]; i++) {
    toggleMark(rows[cur].id);
    if (cur < rows.length - 1) setCur(cur + 1);
  }
}

VH.keys.map(MODE, 'j', down, { desc: 'next comment', group: G });
VH.keys.map(MODE, '<Down>', down, { desc: 'next comment', group: G });
VH.keys.map(MODE, 'k', up, { desc: 'previous comment', group: G });
VH.keys.map(MODE, '<Up>', up, { desc: 'previous comment', group: G });
VH.keys.map(MODE, 'gg', function (c) { setCur(c ? c - 1 : 0); }, { desc: 'first comment', group: G });
VH.keys.map(MODE, 'G', function (c) { setCur(c ? c - 1 : rows.length - 1); }, { desc: 'last comment', group: G });
VH.keys.map(MODE, '<C-d>', function () { down(5); }, { desc: 'down five comments', group: G });
VH.keys.map(MODE, '<C-u>', function () { up(5); }, { desc: 'up five comments', group: G });
VH.keys.map(MODE, '<CR>', function () { jump(); }, { desc: 'jump to the comment and close', group: G });
VH.keys.map(MODE, 'x', markNext, { desc: 'mark / unmark, then next', group: G });
VH.keys.map(MODE, '<Space>', markNext, { desc: 'mark / unmark, then next', group: G });
VH.keys.map(MODE, 'y', function () { copyList(chosen()); }, { desc: 'copy the marked comments (or this one)', group: G });
VH.keys.map(MODE, 'Y', function () { copyList(rows); }, { desc: 'copy all comments', group: G });
VH.keys.map(MODE, 'dd', function () { removeIds(chosen().map(function (c) { return c.id; })); },
  { desc: 'delete the marked comments (or this one)', group: G });
VH.keys.map(MODE, 'D', clearAll, { desc: 'delete all comments', group: G });
VH.keys.map(MODE, 'e', edit, { desc: 'edit the note', group: G });
VH.keys.map(MODE, 'i', edit, { desc: 'edit the note', group: G });
VH.keys.map(MODE, 'u', undo, { desc: 'undo the last change', group: G });
VH.keys.map(MODE, 'q', function () { close(); }, { desc: 'close the sidebar', group: G });
VH.keys.map(MODE, '<Esc>', function () { close(); }, { desc: 'close the sidebar', group: G });
