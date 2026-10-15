/* chrome.js -- the frame around the document (piece F): status line, theme
 * toggle, which-key popup, help overlay, first-load hint, and :q.
 *
 *   status line  #vh-status, fixed at the bottom, 28px (motions, lines and
 *                doc.css all leave that much room). Laid out like the owner's
 *                lualine:  [a mode] [b comments] [c title > section] ...
 *                [x memory/search/Copy for agent] [y progress] [z L12/340],
 *                with a and z in the mode's colour. Piece D's command line
 *                covers this area while it is open; nothing here styles it.
 *   theme        #vh-theme, a sun/moon button fixed top-right (inside the status
 *                line at phone widths); <leader>ub and :theme do the same.
 *                VH.scheme (core) owns the attribute and the remembered choice;
 *                build.py's head script applies a remembered dark before first
 *                paint, so nothing flashes.
 *   which-key    from core's 'pending' event: 300 ms into a pending prefix, a
 *                bottom-right popup lists what can follow; it then holds the
 *                prefix open (VH.keys.hold) until the next key, as LazyVim's does.
 *   help         <leader>? / :help / :h, mode 'help', generated from
 *                VH.keys.list() and VH.commands.list() each time it opens.
 *   :q           emits 'close'; every sidebar, overlay and popover closes on it.
 */

var LABELS = { normal: 'NORMAL', insert: 'INSERT', visual: 'VISUAL', vline: 'V-LINE',
               command: 'COMMAND', panel: 'PANEL', help: 'HELP' };

var ICONS = {
  comment: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  alert: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4M12 17h.01"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41' +
       'M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/>',
  moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>'
};

function icon(name, cls) {
  var s = document.createElement('span');
  s.className = 'vh-i' + (cls ? ' ' + cls : '');
  s.setAttribute('aria-hidden', 'true');
  s.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + ICONS[name] + '</svg>';
  return s;
}

function h(tag, attrs, kids) { return VH.ui.h(tag, attrs, kids); }

// A button that never takes focus, so a page field keeps its caret and the
// keymap's Space/Enter never also "press" it.
function button(attrs, kids, onclick) {
  var b = h('button', Object.assign({ type: 'button' }, attrs), kids);
  b.addEventListener('mousedown', function (e) { e.preventDefault(); });
  b.addEventListener('click', onclick);
  return b;
}

function plural(n, word) {
  return n + ' ' + word + (n === 1 ? '' : 's');
}

function blurPageField() {
  var a = document.activeElement;
  if (a && a !== document.body && VH.ui.isEditable(a) && !VH.ui.isOurs(a) && a.blur) a.blur();
}

/* -------------------------------------------------------------- key labels
 * Mapped sequences are written in vim notation ('<leader>ub', '<C-d>', 'gg').
 * For display they split into tokens; a run of plain characters stays one
 * chip ('gg', ']c'), each bracketed key gets its own ('Space', 'Ctrl-d').
 */

var NAMED = { leader: 'Space', space: 'Space', cr: 'Enter', esc: 'Esc', bs: 'Backspace', tab: 'Tab',
              del: 'Delete', down: '\u2193', up: '\u2191', left: '\u2190', right: '\u2192',
              lt: '<', bar: '|', bslash: '\\', pageup: 'PageUp', pagedown: 'PageDown', home: 'Home', end: 'End' };
var MOD_NAMES = { C: 'Ctrl', A: 'Alt', M: 'Alt', D: 'Cmd', S: 'Shift' };

function tokens(seq) {
  return String(seq).match(/<[^<>\s]+>|[\s\S]/g) || [];
}

function tokenLabel(tok) {
  if (tok.length === 1 || tok.charAt(0) !== '<') return tok === ' ' ? 'Space' : tok;
  var parts = tok.slice(1, -1).split('-');
  var key = parts.pop() || '-';
  var name = NAMED[key.toLowerCase()] || key;
  return parts.map(function (m) { return MOD_NAMES[m.toUpperCase()] || m; }).concat(name).join('-');
}

function chips(seq) {
  var out = [];
  var run = '';
  tokens(seq).forEach(function (t) {
    if (t.length === 1) { run += t; return; }
    if (run) { out.push(run); run = ''; }
    out.push(tokenLabel(t));
  });
  if (run) out.push(run);
  return out;
}

function kbd(text) {
  return h('span', { 'class': 'vh-kbd', text: text });
}

function keyEl(seq) {
  return h('span', { 'class': 'vh-keys', 'data-vh-seq': seq }, chips(seq).map(kbd));
}

/* ------------------------------------------------------------- status line */

var st = {};
// The last 'search' payload with something highlighted. search.js reports
// index and total 0 once nothing is (Esc, :noh, the cursor moving off, a
// pattern that found nothing), and the status line then shows no count, as
// nvim's does; a stale "[0/0]" would read as a live search that failed.
var search = null;

function buildStatus() {
  st.mode = h('span', { 'class': 'vh-st-mode' });
  st.n = h('span', { 'class': 'vh-st-n' });
  st.word = h('span', { 'class': 'vh-st-word' });
  st.count = button({ 'class': 'vh-st-count', title: 'Comments sidebar (Space e)' },
    [icon('comment'), h('span', { 'class': 'vh-st-label' }, [st.n, st.word])],
    function () { if (VH.panel) VH.panel.toggle(); });
  st.title = h('span', { 'class': 'vh-st-title', text: VH.cfg.docTitle });
  st.crumb = h('span', { 'class': 'vh-st-crumb' });
  st.mem = h('span', { 'class': 'vh-st-mem', hidden: true,
    title: 'This browser blocks storage here: comments and marks last only until the tab closes. Copy them out before you go.' },
    [icon('alert'), h('span', { text: 'memory only' })]);
  st.search = h('span', { 'class': 'vh-st-search', hidden: true });
  st.copy = button({ 'class': 'vh-st-copy',
                     title: 'Copy every comment with the page location, ready to paste to an agent (gy, :w)' },
    [icon('copy'), h('span', { 'class': 'vh-st-copy-l', text: 'Copy for agent' })], copyForAgent);
  // Phone widths have no margin for the top-right toggle; this one stands in.
  st.theme = button({ 'class': 'vh-st-theme', 'aria-label': 'Dark theme' },
    [icon('moon', 'vh-i-moon'), icon('sun', 'vh-i-sun')], function () { VH.scheme.toggle(); });
  st.prog = h('span', { 'class': 'vh-st-prog' });
  st.pos = h('span', { 'class': 'vh-st-pos' });
  st.root = h('div', { id: 'vh-status', 'class': 'vh-status', 'aria-label': 'Status line' }, [
    h('span', { 'class': 'vh-st-a' }, [st.mode]),
    h('span', { 'class': 'vh-st-b' }, [st.count]),
    h('span', { 'class': 'vh-st-c' }, [st.title, st.crumb]),
    h('span', { 'class': 'vh-st-x' }, [st.mem, st.search, st.copy, st.theme]),
    h('span', { 'class': 'vh-st-y' }, [st.prog]),
    h('span', { 'class': 'vh-st-z' }, [st.pos])
  ]);
  VH.ui.layer.appendChild(st.root);
}

// lualine's "progress": Top / Bot at the ends, else how far the cursor is.
function progress(n, total) {
  if (!total || n <= 1) return 'Top';
  if (n >= total) return 'Bot';
  return Math.floor(n / total * 100) + '%';
}

// The crumb after the title; lines.js leaves out an h1 the title already names.
function section(n) {
  if (!n || !VH.lines || !VH.lines.sectionPath) return '';
  var path = VH.lines.sectionPath(n);
  return path ? ' \u203a ' + path : '';
}

// update() runs several times per keypress (cursor, search, layout...), so a
// field is written only when its text changes: every text write is a DOM
// mutation, and those cost more on a page full of highlight ranges.
function put(el, text) {
  if (el.textContent !== text) el.textContent = text;
}

function update() {
  if (!st.root) return;
  var m = VH.mode.get();
  if (st.root.getAttribute('data-mode') !== m) st.root.setAttribute('data-mode', m);
  put(st.mode, LABELS[m] || m.toUpperCase());
  var n = VH.cursor ? VH.cursor.get() : 0;
  var total = VH.lines ? VH.lines.count() : 0;
  put(st.pos, 'L' + n + '/' + total);
  put(st.prog, progress(n, total));
  put(st.crumb, section(n));
  var c = VH.comments ? VH.comments.all().length : 0;
  put(st.n, String(c));
  put(st.word, c === 1 ? ' comment' : ' comments');
  st.count.classList.toggle('vh-zero', !c);
  st.copy.classList.toggle('vh-zero', !c);
  st.mem.hidden = VH.store.persistent;
  st.search.hidden = !search;
  if (search) {
    put(st.search, '[' + (search.index || 0) + '/' + search.total + ']');
    st.search.title = '/' + search.query;
  }
}

// One click from anywhere: exactly what :w and gy put on the clipboard.
function copyForAgent() {
  var list = VH.comments ? VH.comments.all() : [];
  if (!list.length) { VH.toast('No comments yet: select with v or V and press gc, or press gcc on a line'); return; }
  VH.clip.copy(VH.comments.format(list)).then(function (ok) {
    if (ok) VH.toast('Copied ' + plural(list.length, 'comment') + ' for the agent');
  });
}

/* ------------------------------------------------------------ theme toggle */

var toggle = null;

function buildToggle() {
  toggle = button({ id: 'vh-theme', 'class': 'vh-theme', 'aria-label': 'Dark theme' },
    [icon('moon', 'vh-i-moon'), icon('sun', 'vh-i-sun')], function () { VH.scheme.toggle(); });
  VH.ui.layer.appendChild(toggle);
  labelToggle();
}

// The icon is the scheme a click switches to; CSS picks it from <html>'s
// attribute, so it is right from the first frame. A toggle button keeps one
// label and reports its state through aria-pressed.
function labelToggle() {
  var dark = VH.scheme.get() === 'dark';
  [toggle, st.theme].forEach(function (b) {
    if (!b) return;
    b.setAttribute('aria-pressed', dark ? 'true' : 'false');
    b.title = 'Switch to the ' + (dark ? 'light' : 'dark') + ' theme (Space u b)';
  });
}

function setTheme(arg) {
  var a = String(arg || '').trim().toLowerCase();
  if (a === 'dark' || a === 'light') VH.scheme.set(a);
  else if (!a || a === 'toggle') VH.scheme.toggle();
  else { VH.toast('Usage: :theme [light | dark]', { kind: 'error' }); return false; }
}

/* --------------------------------------------------------------- which-key
 * Rows are the distinct next keys after the pending prefix. A key that only
 * leads further ('u' under <leader>, for <leader>ub and <leader>ul) is a group
 * row, named from LazyVim's which-key groups where there is one.
 */

var WK_DELAY = 300;
// The prefixes the plan gives a popup (what LazyVim's which-key triggers on);
// anything else, test-only sequences included, keeps core's plain timeout.
var WK_PREFIXES = { '<leader>': 1, '<Space>': 1, g: 1, z: 1, '[': 1, ']': 1, d: 1, y: 1, m: 1, "'": 1, '`': 1 };
var GROUP_NAMES = {
  '<leader>c': 'code', '<leader>s': 'search', '<leader>u': 'ui', '<leader>m': 'marks', '<leader>y': 'yank',
  'g': 'goto', 'gc': 'comment', 'z': 'fold', '[': 'prev', ']': 'next', 'd': 'delete', 'y': 'yank',
  'm': 'mark', "'": 'jump to mark', '`': 'jump to mark'
};
var wk = { el: null, timer: 0, shown: false };

function groupName(prefixToks, members) {
  var key = prefixToks.map(function (t) { return t === '<Space>' ? '<leader>' : t; }).join('');
  if (GROUP_NAMES[key]) return GROUP_NAMES[key];
  return plural(members, 'keymap');
}

function wkRows(p) {
  var depth = tokens(p.seq).length;
  var byKey = {};
  var order = [];
  (p.matches || []).forEach(function (m) {
    var t = tokens(m.seq);
    var next = t[depth];
    if (!next) return;
    var row = byKey[next];
    if (!row) {
      row = byKey[next] = { key: next, desc: null, members: 0, prefix: t.slice(0, depth + 1) };
      order.push(row);
    }
    if (t.length > depth + 1) row.members++;
    else row.desc = m.desc || '';
  });
  order.forEach(function (r) {
    if (r.desc === null) { r.group = true; r.desc = '+' + groupName(r.prefix, r.members); }
  });
  // Families mapped hidden and documented once with VH.keys.doc ('m{a-z}')
  // show as one row, so m and ' still say what they take.
  var mode = VH.mode.get();
  VH.keys.list().forEach(function (k) {
    var rest = k.seq.slice(p.seq.length);
    if (k.seq.indexOf(p.seq) === 0 && /^\{.+\}$/.test(rest) && k.modes.indexOf(mode) >= 0 && !byKey[rest]) {
      byKey[rest] = { key: rest, desc: k.desc, family: true };
      order.push(byKey[rest]);
    }
  });
  // which-key's alphanum order: punctuation, then letters with lowercase first.
  function rank(k) {
    var c = k.length === 1 ? k : '\uffff' + k;
    return [/[a-z]/i.test(c) ? 1 : 0, c.toLowerCase(), c === c.toLowerCase() ? 0 : 1];
  }
  return order.sort(function (a, b) {
    var x = rank(a.key), y = rank(b.key);
    for (var i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
    return 0;
  });
}

function showWk(p) {
  var rows = wkRows(p);
  if (!rows.length) { hideWk(); return; }
  if (!wk.el) {
    wk.el = h('div', { id: 'vh-whichkey', 'class': 'vh-wk', role: 'tooltip', hidden: true });
    VH.ui.layer.appendChild(wk.el);
  }
  var title = h('div', { 'class': 'vh-wk-title' },
    [p.count ? h('span', { 'class': 'vh-wk-count', text: String(p.count) }) : null, keyEl(p.seq)]);
  var list = h('div', { 'class': 'vh-wk-list' + (rows.length > 14 ? ' vh-wk-wide' : '') }, rows.map(function (r) {
    return h('div', { 'class': 'vh-wk-row' + (r.group ? ' vh-wk-group' : ''), 'data-vh-key': r.key }, [
      h('span', { 'class': 'vh-wk-key', text: r.family ? r.key : tokenLabel(r.key) }),
      h('span', { 'class': 'vh-wk-sep', text: '\u279c' }),
      h('span', { 'class': 'vh-wk-desc', text: r.desc })
    ]);
  }));
  wk.el.textContent = '';
  wk.el.appendChild(title);
  wk.el.appendChild(list);
  wk.el.hidden = false;
  wk.shown = true;
  // Once the reader can see the choices, wait for their pick instead of
  // dropping the prefix at the 800 ms timeout. A prefix that is itself a
  // mapping is not held (core decides) and still resolves to that mapping.
  if (VH.keys.hold) VH.keys.hold(true);
}

function hideWk() {
  clearTimeout(wk.timer);
  if (wk.el) wk.el.hidden = true;
  wk.shown = false;
}

VH.on('pending', function (p) {
  clearTimeout(wk.timer);
  if (!p || !p.seq || !WK_PREFIXES[tokens(p.seq)[0]]) { hideWk(); return; }
  if (wk.shown) { showWk(p); return; }
  wk.timer = setTimeout(function () {
    var now = VH.keys.pending();
    if (now.seq && WK_PREFIXES[tokens(now.seq)[0]]) showWk(now);
  }, WK_DELAY);
});

/* -------------------------------------------------------------------- help
 * Sections follow each mapping's group in a reading order; rows with the same
 * description and modes merge ('j' and '<Down>'). Inside a section, normal-mode
 * rows come first and other modes' rows follow under "in the sidebar" style
 * subheadings, so a key is always read with the mode it works in.
 */

var HELP = 'help';
var GROUP_ORDER = ['modes', 'motion', 'motions', 'scroll', 'jump', 'jumps', 'marks', 'folds', 'fold',
                   'lines', 'gutter', 'search', 'visual', 'select', 'selection', 'yank', 'comments',
                   'sidebar', 'ui', 'help'];
var GROUP_TITLES = { modes: 'Modes', motion: 'Moving', motions: 'Moving', ui: 'Interface',
                     sidebar: 'Comments sidebar', help: 'This help', '': 'Other' };
var MODE_NAMES = { normal: 'normal mode', insert: 'insert mode', visual: 'visual', vline: 'visual line',
                   command: 'the command line', panel: 'the sidebar', help: 'this help' };
var help = null;  // {root, body} while open

function groupTitle(g) {
  if (GROUP_TITLES[g] !== undefined) return GROUP_TITLES[g];
  return g.charAt(0).toUpperCase() + g.slice(1);
}

function helpSections() {
  var groups = {};
  var order = [];
  VH.keys.list().forEach(function (k) {
    var g = k.group || '';
    var sec = groups[g];
    if (!sec) { sec = groups[g] = { group: g, byId: {}, modeSets: {}, modeOrder: [] }; order.push(g); }
    var modes = k.modes.slice().sort().join(',');
    var id = k.desc + '\u0001' + modes;
    var row = sec.byId[id];
    if (!row) {
      row = sec.byId[id] = { seqs: [], desc: k.desc };
      if (!sec.modeSets[modes]) { sec.modeSets[modes] = []; sec.modeOrder.push(modes); }
      sec.modeSets[modes].push(row);
    }
    if (row.seqs.indexOf(k.seq) < 0) row.seqs.push(k.seq);
  });
  function rank(g) {
    var i = GROUP_ORDER.indexOf(g);
    return i < 0 ? GROUP_ORDER.length + order.indexOf(g) : i;
  }
  return order.sort(function (a, b) { return rank(a) - rank(b); }).map(function (g) { return groups[g]; });
}

function modesLabel(key) {
  var names = key.split(',').map(function (m) { return MODE_NAMES[m] || m; });
  return 'in ' + (names.length > 1 ? names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1] : names[0]);
}

function helpRow(r) {
  return h('div', { 'class': 'vh-help-row' }, [
    h('span', { 'class': 'vh-help-k' }, r.seqs.map(keyEl)),
    h('span', { 'class': 'vh-help-d', text: r.desc || '\u2014' })
  ]);
}

function helpContent() {
  var cols = helpSections().map(function (sec) {
    var keys = sec.modeOrder.slice().sort(function (a, b) {
      return (a === 'normal' ? 0 : 1) - (b === 'normal' ? 0 : 1) || sec.modeOrder.indexOf(a) - sec.modeOrder.indexOf(b);
    });
    var rows = [];
    keys.forEach(function (key) {
      if (key !== 'normal') rows.push(h('div', { 'class': 'vh-help-in', text: modesLabel(key) }));
      sec.modeSets[key].forEach(function (r) { rows.push(helpRow(r)); });
    });
    return h('section', { 'class': 'vh-help-sec' }, [
      h('div', { 'class': 'vh-help-h', role: 'heading', 'aria-level': '2', text: groupTitle(sec.group) }),
      h('div', { 'class': 'vh-help-rows' }, rows)
    ]);
  });
  var cmds = VH.commands.list();
  if (cmds.length) {
    cols.push(h('section', { 'class': 'vh-help-sec' }, [
      h('div', { 'class': 'vh-help-h', role: 'heading', 'aria-level': '2', text: 'Commands' }),
      h('div', { 'class': 'vh-help-rows' }, cmds.map(function (c) {
        return h('div', { 'class': 'vh-help-row' }, [
          h('span', { 'class': 'vh-help-k' }, [h('span', { 'class': 'vh-cmd', 'data-vh-cmd': c.name, text: ':' + c.name })]),
          h('span', { 'class': 'vh-help-d', text: c.desc || '\u2014' })
        ]);
      }))
    ]));
  }
  return cols;
}

function openHelp() {
  closeHelpUI();
  blurPageField();
  var body = h('div', { 'class': 'vh-help-body', tabindex: '-1' }, helpContent());
  var box = h('div', { 'class': 'vh-help-box', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Keys' }, [
    h('div', { 'class': 'vh-help-head' }, [
      h('span', { 'class': 'vh-help-title', text: 'Keys' }),
      h('span', { 'class': 'vh-help-sub' }, ['normal mode unless a section says otherwise \u00b7 ', kbd('j'), kbd('k'),
        ' scroll \u00b7 ', kbd('q'), ' or ', kbd('Esc'), ' closes']),
      button({ 'class': 'vh-help-close', 'aria-label': 'Close (q)', title: 'Close (q)' }, [icon('x')], closeHelp)
    ]),
    body
  ]);
  var root = h('div', { id: 'vh-help', 'class': 'vh-help' }, [box]);
  root.addEventListener('mousedown', function (e) { if (e.target === root) { e.preventDefault(); closeHelp(); } });
  VH.ui.layer.appendChild(root);
  help = { root: root, body: body };
  VH.mode.set(HELP);
}

function closeHelpUI() {
  if (!help) return;
  help.root.remove();
  help = null;
}

function closeHelp() {
  closeHelpUI();
  if (VH.mode.get() === HELP) VH.mode.set('normal');
}

function scrollHelp(dy) {
  if (help) help.body.scrollBy({ top: dy, left: 0, behavior: 'instant' });
}

function helpPage() { return help ? help.body.clientHeight : 0; }

/* -------------------------------------------------------- first-load hint */

var hint = null;

function showHint() {
  if (VH.prefs.get('hinted')) return;
  VH.prefs.set('hinted', true);
  hint = h('div', { 'class': 'vh-hint', role: 'note' }, [
    h('b', { text: 'NORMAL' }), ' \u2014 ', kbd('Space'), kbd('?'), ' for keys, ', kbd('i'), ' to type'
  ]);
  VH.ui.layer.appendChild(hint);
  requestAnimationFrame(function () { if (hint) hint.classList.add('vh-show'); });
  window.addEventListener('keydown', hideHint, true);
  setTimeout(hideHint, 9000);
}

function hideHint() {
  window.removeEventListener('keydown', hideHint, true);
  if (!hint) return;
  var el = hint;
  hint = null;
  el.classList.remove('vh-show');
  setTimeout(function () { el.remove(); }, 250);
}

/* -------------------------------------------------------------- lifecycle */

VH.init(function () {
  // --theme none has no doc.css to leave room above the status line.
  if (VH.cfg.theme === 'none') document.documentElement.classList.add('vh-status-room');
  buildStatus();
  buildToggle();
  update();
  ['mode', 'cursor', 'comments', 'store', 'layout', 'folds', 'ready'].forEach(function (evt) { VH.on(evt, update); });
  showHint();
});

VH.on('search', function (e) {
  search = e && e.query && e.total ? e : null;
  update();
});

VH.on('scheme', labelToggle);

VH.on('mode', function (e) {
  if (help && e.from === HELP && e.to !== HELP) closeHelpUI();
});

VH.on('escape', hideHint);

VH.on('close', function () {
  closeHelp();
  hideHint();
  if (wk.shown && VH.keys.hold) VH.keys.hold(false);
  hideWk();
});

VH.commands.add('q', function () { VH.emit('close', {}); }, 'close sidebars and overlays');
VH.commands.add('help', function () { openHelp(); }, 'list every key and command');
VH.commands.add('h', function () { openHelp(); }, 'same as :help');
VH.commands.add('theme', setTheme, 'toggle light / dark (or :theme dark, :theme light)');

VH.keys.map('normal', '<leader>ub', function () { VH.scheme.toggle(); }, { desc: 'toggle light / dark', group: 'ui' });
VH.keys.map('normal', '<leader>?', openHelp, { desc: 'keymap help', group: 'help' });

VH.keys.map(HELP, 'j', function (c) { scrollHelp(40 * (c || 1)); }, { desc: 'scroll down', group: 'help' });
VH.keys.map(HELP, '<Down>', function (c) { scrollHelp(40 * (c || 1)); }, { desc: 'scroll down', group: 'help' });
VH.keys.map(HELP, 'k', function (c) { scrollHelp(-40 * (c || 1)); }, { desc: 'scroll up', group: 'help' });
VH.keys.map(HELP, '<Up>', function (c) { scrollHelp(-40 * (c || 1)); }, { desc: 'scroll up', group: 'help' });
VH.keys.map(HELP, '<C-d>', function () { scrollHelp(helpPage() / 2); }, { desc: 'half page down', group: 'help' });
VH.keys.map(HELP, '<C-u>', function () { scrollHelp(-helpPage() / 2); }, { desc: 'half page up', group: 'help' });
VH.keys.map(HELP, '<C-f>', function () { scrollHelp(helpPage() - 40); }, { desc: 'page down', group: 'help' });
VH.keys.map(HELP, '<C-b>', function () { scrollHelp(40 - helpPage()); }, { desc: 'page up', group: 'help' });
VH.keys.map(HELP, 'gg', function () { scrollHelp(-1e9); }, { desc: 'top', group: 'help' });
VH.keys.map(HELP, 'G', function () { scrollHelp(1e9); }, { desc: 'bottom', group: 'help' });
VH.keys.map(HELP, 'q', closeHelp, { desc: 'close the help', group: 'help' });
VH.keys.map(HELP, '<Esc>', closeHelp, { desc: 'close the help', group: 'help' });
VH.keys.map(HELP, '<leader>?', closeHelp, { desc: 'close the help', group: 'help' });
