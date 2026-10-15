/* core.js -- the vim-html runtime core (piece A). Every other module builds on it.
 *
 * build.py inlines all runtime modules into one IIFE, in this order, each in its
 * own function scope (module-level vars are private; the only shared surface is
 * the VH object it passes in):
 *
 *   core -> lines -> motions -> search -> select -> comments -> panel -> chrome
 *     core.js runs first and only defines VH.* (no DOM work).
 *     The others register: VH.init(fn), VH.keys.map(...), VH.commands.add(...).
 *     VH.boot() (last line of the IIFE) waits for DOMContentLoaded, creates
 *     VH.ui.layer, installs the key and focus listeners, runs every VH.init fn in
 *     module order, then emits 'ready'.
 *
 * Contract (PLAN.md "Runtime core contract"); items marked (+) are additive helpers:
 *   VH.cfg                     defaults <- window.VIM_HTML; docTitle is resolved at boot;
 *                              source (+) is the built file's path (build.py)
 *   VH.init(fn) VH.boot() VH.booted(+)
 *   VH.on(evt, fn) -> off(+)  VH.off(+)  VH.emit(evt, payload)
 *     'mode' {from, to}  'cursor' {line, prev}  'comments' {}  'layout' {}
 *     'scheme' {scheme}  'search' {query, index, total}  'folds' {}  'marks' {}
 *       (core only defines the bus; each module emits its own events)
 *     (+) 'ready' {}            all init fns have run
 *     (+) 'escape' {}           Esc in normal mode: owners clear highlights, popovers
 *     (+) 'goto' {line}         ':{n}' / ':$' (line Infinity); motions jumps there
 *     'pending' {seq, matches: [{seq, desc}], count(+)} while a sequence prefix
 *               is pending (which-key popup); {seq: ''} once it resolves or times out
 *     (+) 'store' {persistent}  storage became unavailable; now memory only
 *   VH.mode.get() / set(name) / is(name)(+)
 *   VH.keys.map(modes, seq, fn, {desc, group})  fn(count, event); return false = not handled
 *     seq may use '<leader>' (= <Space>, the owner's LazyVim leader): '<leader>ub'
 *   VH.keys.unmap(+) / list() / pending()(+) / timeout(+) / doc(+)
 *     map opts.hidden(+): the binding works but stays out of list() and 'pending'
 *   VH.keys.hold(on)(+)  while a pure prefix is pending, hold(true) stops it timing
 *     out: it waits for its next key, and Esc or a key that extends nothing clears
 *     it (chrome.js's which-key popup, like LazyVim's). A sequence that is also a
 *     complete mapping is not held. hold(false) restarts the timeout.
 *   VH.commands.add(name, fn, desc) / run(text) / list()(+)
 *   VH.store / VH.prefs: get(k) / set(k, v) / del(k)(+) / persistent
 *   VH.scheme.get() / set(s) / toggle()(+)   'light' | 'dark', remembered in prefs
 *   VH.clip.copy(text) -> Promise<boolean>; VH.clip.last, VH.clip.via(+)
 *   VH.toast(msg, {kind, ms})
 *   VH.ui.layer, VH.ui.h(+), isOurs(+), isEditable(+), origin(+)
 *   VH.text.rangeFrom(el, start, end) / bounds(el, start, end)(+)
 *     / offsetIn(el, node, offset) / norm(s)(+)
 *   VH.error(where, err)(+)    log a caught failure without breaking the caller
 */

var html = document.documentElement;

VH.version = 1;
VH.cfg = Object.assign(
  { source: null, storageKey: null, docTitle: null, scheme: 'light', theme: null, debug: false },
  window.VIM_HTML || {}
);

VH.error = function (where, err) {
  try { console.error('[vim-html] ' + where, err); } catch (e) { /* console may be gone */ }
  if (VH.cfg.debug && VH.ui && VH.ui.layer) VH.toast('vim-html: ' + where + ' failed', { kind: 'error' });
};

/* ------------------------------------------------------------------ events */

var handlers = {};

VH.on = function (evt, fn) {
  (handlers[evt] || (handlers[evt] = [])).push(fn);
  return function () { VH.off(evt, fn); };
};

VH.off = function (evt, fn) {
  var list = handlers[evt];
  if (list) handlers[evt] = list.filter(function (f) { return f !== fn; });
};

// Listeners are isolated: one that throws is reported and the rest still run.
VH.emit = function (evt, payload) {
  var list = (handlers[evt] || []).slice();
  payload = payload || {};
  for (var i = 0; i < list.length; i++) {
    try { list[i](payload); } catch (err) { VH.error('listener for "' + evt + '"', err); }
  }
};

/* ------------------------------------------------------------- init / boot */

var inits = [];
VH.booted = false;

VH.init = function (fn) {
  if (VH.booted) runInit(fn); else inits.push(fn);
};

function runInit(fn) {
  try { fn(); } catch (err) { VH.error('init', err); }
}

VH.boot = function () {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
};

function start() {
  if (VH.booted) return;
  VH.cfg.docTitle = resolveTitle();
  html.setAttribute('data-vh-scheme', initialScheme());
  html.setAttribute('data-vh-mode', mode);
  layer();
  installListeners();
  // A field that already has focus (autofocus) means the reader is typing.
  var active = deepActive();
  if (isEditable(active) && !isOurs(active)) VH.mode.set('insert');
  var queued = inits;
  inits = [];
  VH.booted = true;  // set before running, so an init that calls VH.init runs at once
  queued.forEach(runInit);
  html.setAttribute('data-vh-booted', '');
  VH.emit('ready', {});
}

function resolveTitle() {
  if (VH.cfg.docTitle) return String(VH.cfg.docTitle);
  if (document.title && document.title.trim()) return document.title.trim();
  var h1 = document.querySelector('h1');
  return (h1 && VH.text.norm(h1.textContent)) || 'Untitled';
}

/* ------------------------------------------------------------------- modes */

var MODES = ['normal', 'insert', 'visual', 'vline', 'command', 'panel', 'help'];
var mode = 'normal';

VH.mode = {
  get: function () { return mode; },
  is: function (name) { return mode === name; },
  set: function (to) {
    if (MODES.indexOf(to) < 0) throw new Error('vim-html: unknown mode "' + to + '"');
    if (to === mode) return;
    var from = mode;
    mode = to;
    resetPending();
    jk = null;
    html.setAttribute('data-vh-mode', to);
    VH.emit('mode', { from: from, to: to });
  }
};

/* --------------------------------------------------------------- key tokens
 * Every key is reduced to one vim-style token, both when a mapping is declared
 * (parseSeq) and when an event arrives (eventToken), through the same canon(),
 * so the two always agree:
 *   plain printable chars as themselves ('j' 'G' '?' ']'), '<' as '<lt>';
 *   named keys and anything with Ctrl/Alt/Cmd in brackets, modifiers in the
 *   fixed order C- A- D- S-: '<CR>' '<S-CR>' '<C-d>' '<A-j>' '<D-c>' '<Space>'.
 * Shift is folded into printable characters ('G', not '<S-g>') and into Space,
 * as a terminal sends Shift-Space as Space: '<leader>?' typed with Shift held
 * a beat early is still the leader, never the browser's Shift-Space page-up.
 * '<leader>' in a declared sequence is the token '<Space>'; only its display
 * keeps the name.
 */

var LEADER = '<Space>';

var MODIFIER_KEYS = { Shift: 1, Control: 1, Alt: 1, Meta: 1, AltGraph: 1, CapsLock: 1, Fn: 1, FnLock: 1, Hyper: 1, Super: 1, OS: 1, NumLock: 1, ScrollLock: 1 };
var EVENT_NAMES = {
  Enter: 'CR', Escape: 'Esc', Tab: 'Tab', Backspace: 'BS', Delete: 'Del', Insert: 'Insert',
  ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
  PageUp: 'PageUp', PageDown: 'PageDown', Home: 'Home', End: 'End'
};
var SPEC_NAMES = {
  cr: 'CR', enter: 'CR', return: 'CR', esc: 'Esc', escape: 'Esc', tab: 'Tab',
  bs: 'BS', backspace: 'BS', del: 'Del', delete: 'Del', insert: 'Insert',
  up: 'Up', down: 'Down', left: 'Left', right: 'Right',
  pageup: 'PageUp', pagedown: 'PageDown', home: 'Home', end: 'End',
  space: 'Space', lt: '<', bar: '|', bslash: '\\'
};

function canon(mods, name) {
  var cad = mods.C || mods.A || mods.D;
  if (name.length === 1) {
    if (/[a-z]/i.test(name)) {
      if (cad) name = name.toLowerCase();
      else { if (mods.S) name = name.toUpperCase(); mods.S = false; }
    } else {
      mods.S = false;  // shift is already part of the character
    }
    if (!cad) return name === '<' ? '<lt>' : name;
  }
  if (/^f\d{1,2}$/i.test(name)) name = name.toUpperCase();
  if (name === 'Space' && !cad) mods.S = false;
  return '<' + (mods.C ? 'C-' : '') + (mods.A ? 'A-' : '') + (mods.D ? 'D-' : '') +
    (mods.S ? 'S-' : '') + name + '>';
}

function eventToken(e) {
  var k = e.key;
  if (!k || k === 'Dead' || k === 'Unidentified' || k === 'Process' || MODIFIER_KEYS[k]) return null;
  var mods = { C: e.ctrlKey, A: e.altKey, D: e.metaKey, S: e.shiftKey };
  // AltGr on Windows/Linux reports Ctrl+Alt while typing a plain character.
  if (mods.C && mods.A && !mods.D && k.length === 1) mods.C = mods.A = false;
  var name;
  if (k === ' ') {
    name = 'Space';
  } else if (k.length === 1) {
    name = k;
    // macOS Option turns letters into symbols (Option-j is a delta); use the physical key.
    var phys = mods.A && /^(?:Key([A-Z])|Digit(\d))$/.exec(e.code || '');
    if (phys) name = phys[1] ? phys[1].toLowerCase() : phys[2];
  } else {
    name = EVENT_NAMES[k] || k;
  }
  return canon(mods, name);
}

// Returns the canonical tokens; out.show holds each token as the author wrote
// it, so list() and 'pending' print '<leader>ub' rather than '<Space>ub'.
function parseSeq(seq) {
  var out = [];
  var show = out.show = [];
  var re = /<([^<>\s]+)>|([\s\S])/g;
  var m;
  function add(tok, shown) { out.push(tok); show.push(shown || tok); }
  while ((m = re.exec(seq))) {
    if (m[2] !== undefined) {
      add(m[2] === ' ' ? '<Space>' : canon({}, m[2]));
      continue;
    }
    if (m[1].toLowerCase() === 'leader') {
      add(LEADER, '<leader>');
      continue;
    }
    var parts = m[1].split('-');
    var key = parts.pop();
    if (key === '' && parts.length) { parts.pop(); key = '-'; }  // <C-->
    var mods = {};
    parts.forEach(function (p) {
      var c = p.toUpperCase();
      if (c === 'M') c = 'A';                 // vim's Meta is Alt in a browser
      if (c === 'C' || c === 'A' || c === 'D' || c === 'S') mods[c] = true;
      else throw new Error('vim-html: bad modifier "' + p + '" in "' + seq + '"');
    });
    var name = SPEC_NAMES[key.toLowerCase()] || key;
    if (name === '|' || name === '\\' || name === '<') {
      add(canon(mods, name));
    } else if (name.length === 1 || /^(CR|Esc|Tab|BS|Del|Insert|Up|Down|Left|Right|PageUp|PageDown|Home|End|Space|F\d{1,2})$/i.test(name)) {
      add(canon(mods, name.length === 1 ? name : normalName(name)));
    } else {
      throw new Error('vim-html: unknown key "<' + m[1] + '>" in "' + seq + '"');
    }
  }
  return out;
}

function normalName(name) {
  var hit = SPEC_NAMES[name.toLowerCase()];
  return hit || name.toUpperCase();
}

function isPrintable(tok) {
  return tok.length === 1 || tok === '<lt>' || tok === '<Space>';
}

/* ------------------------------------------------------------------ keymap */

var SEP = '\u0001';
var maps = {};      // mode -> { 'g\u0001g': binding }
var prefixes = {};  // mode -> { 'g': true } for every proper prefix of a mapped sequence
var entries = [];   // bindings in registration order, for list()

// Digits are counts here; in insert and command they are typed text.
var COUNT_MODES = { normal: 1, visual: 1, vline: 1, panel: 1, help: 1 };
var TYPING_MODES = { insert: 1, command: 1 };

function rebuildPrefixes() {
  prefixes = {};
  Object.keys(maps).forEach(function (m) {
    var p = prefixes[m] = {};
    Object.keys(maps[m]).forEach(function (k) {
      var toks = k.split(SEP);
      for (var i = 1; i < toks.length; i++) p[toks.slice(0, i).join(SEP)] = true;
    });
  });
}

function modeList(modes) {
  var list = [].concat(modes);
  list.forEach(function (m) {
    if (MODES.indexOf(m) < 0) throw new Error('vim-html: unknown mode "' + m + '"');
  });
  return list;
}

VH.keys = {
  timeout: 800,  // ms a partial sequence waits for its next key (the owner's timeoutlen)

  // A later map of the same mode + sequence replaces the earlier one.
  // opts.hidden keeps a family of bindings (m{a-z}) out of the help and the
  // which-key popup; doc() then lists the family once.
  map: function (modes, seq, fn, opts) {
    var tokens = parseSeq(seq);
    if (!tokens.length) throw new Error('vim-html: empty key sequence');
    if (typeof fn !== 'function') throw new Error('vim-html: no handler for "' + seq + '"');
    opts = opts || {};
    var b = { modes: modeList(modes), tokens: tokens, show: tokens.show, seq: tokens.show.join(''),
              fn: fn, desc: opts.desc || '', group: opts.group || '', hidden: !!opts.hidden };
    var k = tokens.join(SEP);
    b.modes.forEach(function (m) { (maps[m] || (maps[m] = {}))[k] = b; });
    entries.push(b);
    rebuildPrefixes();
    return b;
  },

  // A display-only row for list(), e.g. ('normal', 'm{a-z}', 'set a mark').
  doc: function (modes, seq, desc, group) {
    entries.push({ display: true, modes: modeList(modes), tokens: [], seq: seq,
                   desc: desc || '', group: group || '' });
  },

  unmap: function (modes, seq) {
    var k = parseSeq(seq).join(SEP);
    modeList(modes).forEach(function (m) { if (maps[m]) delete maps[m][k]; });
    rebuildPrefixes();
  },

  // [{modes, seq, desc, group}] for the help overlay; modes reflect later overrides.
  list: function () {
    var out = [];
    entries.forEach(function (b) {
      var k = b.tokens.join(SEP);
      var live = b.display ? b.modes : b.modes.filter(function (m) { return maps[m] && maps[m][k] === b; });
      if (live.length && !b.hidden) out.push({ modes: live, seq: b.seq, desc: b.desc, group: b.group });
    });
    return out;
  },

  // The 'pending' payload for the current state: {seq, matches: [{seq, desc}], count}.
  pending: function () {
    var matches = [];
    var shown = '';
    var n = pend.tokens.length;
    if (n) {
      var tbl = maps[mode] || {};
      var head = pend.tokens.join(SEP) + SEP;
      Object.keys(tbl).forEach(function (k) {
        if (k.indexOf(head) !== 0 || tbl[k].hidden) return;
        matches.push({ seq: tbl[k].seq, desc: tbl[k].desc });
        if (!shown) shown = tbl[k].show.slice(0, n).join('');
      });
      matches.sort(function (a, b) { return a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0; });
    }
    return { seq: n ? shown || pend.tokens.join('') : '', matches: matches,
             count: pend.count ? parseInt(pend.count, 10) : null };
  },

  // Returns whether the pending sequence is now held. Only a pure prefix can be:
  // a complete mapping keeps its timeout so it still resolves to itself.
  hold: function (on) {
    if (!on) {
      if (pend.held) { pend.held = false; armTimeout(null); }
      return false;
    }
    if (!pend.tokens.length || (maps[mode] || {})[pend.tokens.join(SEP)]) return false;
    clearTimeout(pend.timer);
    pend.held = true;
    return true;
  }
};

/* -------------------------------------------------------------- dispatcher
 * One capture-phase keydown listener on window sees every key before the page.
 *   typing context (insert/command mode, or focus in an editable): printable
 *     keys always go to the field; only mapped non-printable tokens (<CR>,
 *     <Esc>, <C-x>...) dispatch. Insert also watches for jk / jj.
 *   otherwise: [1-9][0-9]* builds a count, then tokens accumulate until they
 *     match a mapping exactly. A sequence that is also a prefix of a longer one
 *     waits VH.keys.timeout ms. A key that extends nothing resolves what is
 *     pending and is then tried on its own.
 * Handled keys get preventDefault + stopPropagation. Unmapped keys, and keys
 * whose handler returns false, are left alone, so browser and OS shortcuts
 * (Cmd/Ctrl+C, Cmd+F, Tab...) keep working unless something maps them.
 */

var pend = { count: '', tokens: [], timer: 0, held: false };
var lastPending = '';

function emitPending() {
  var sig = pend.count + '|' + pend.tokens.join('');
  if (sig === lastPending) return;
  lastPending = sig;
  VH.emit('pending', VH.keys.pending());
}

function resetPending() {
  clearTimeout(pend.timer);
  pend.held = false;
  pend.count = '';
  pend.tokens = [];
  emitPending();
}

function takeCount() {
  var c = pend.count ? Math.min(parseInt(pend.count, 10), 99999) : null;
  pend.count = '';
  return c;
}

function consume(e) {
  if (!e) return;
  e.preventDefault();
  e.stopPropagation();
}

function invoke(b, count, e) {
  var r;
  try { r = b.fn(count, e); } catch (err) { VH.error('key ' + b.seq, err); }
  if (r === false) return false;
  consume(e);
  return true;
}

function onKeydown(e) {
  if (e.isComposing || e.keyCode === 229) return;  // IME composition owns these keys
  if (clipDialog) {
    if (e.key === 'Escape') { consume(e); closeClipDialog(); }
    return;  // everything else (Cmd/Ctrl+C) goes to the dialog's textarea
  }
  var tok = eventToken(e);
  if (!tok) return;  // a bare modifier must not disturb a pending sequence
  if (mode === 'insert' && insertJk(e, tok)) return;

  var typing = TYPING_MODES[mode] || isEditable(targetOf(e));
  if (typing && isPrintable(tok)) {
    if (pend.tokens.length || pend.count) resetPending();
    return;
  }
  if (COUNT_MODES[mode] && !typing && !pend.tokens.length &&
      (/^[1-9]$/.test(tok) || (tok === '0' && pend.count))) {
    pend.count = (pend.count + tok).slice(0, 6);
    consume(e);
    emitPending();
    return;
  }
  feed(tok, e);
}

function feed(tok, e) {
  var tbl = maps[mode] || {};
  var pre = prefixes[mode] || {};
  var tokens = pend.tokens.concat(tok);
  var k = tokens.join(SEP);
  var exact = tbl[k];
  var longer = pre[k];
  clearTimeout(pend.timer);
  pend.held = false;  // every key ends a hold; a new prefix is held again by its owner

  if (exact && !longer) {
    var count = takeCount();
    pend.tokens = [];
    emitPending();
    if (invoke(exact, count, e) === false && tok === '<Esc>') escFallback(e);
    return;
  }
  if (exact || longer) {
    pend.tokens = tokens;
    consume(e);
    armTimeout(exact);  // before 'pending', so a listener may hold the prefix at once
    emitPending();
    return;
  }
  if (pend.tokens.length) {
    // `tok` extends nothing: settle the pending prefix, then retry `tok` alone.
    var prev = tbl[pend.tokens.join(SEP)];
    var c = takeCount();
    pend.tokens = [];
    emitPending();
    if (prev) invoke(prev, c, null);
    feed(tok, e);
    return;
  }
  if (pend.count) { pend.count = ''; emitPending(); }
  if (tok === '<Esc>') escFallback(e);
  // anything else unmapped: pass through untouched
}

// A pending prefix drops after VH.keys.timeout ms; one that is also a complete
// mapping (`exact`) then runs it.
function armTimeout(exact) {
  clearTimeout(pend.timer);
  pend.timer = setTimeout(function () {
    var c = takeCount();
    pend.tokens = [];
    emitPending();
    if (exact) invoke(exact, c, null);
  }, VH.keys.timeout);
}

// No mode may trap the reader: an Esc nobody handles returns to normal.
function escFallback(e) {
  consume(e);
  if (mode === 'normal') VH.emit('escape', {});
  else VH.mode.set('normal');
}

/* ------------------------------------------------------------- insert mode
 * In insert mode vim keys are off and the page behaves like any web page. Esc
 * returns to normal; so does j then k, or j then j, within JK_MS on the same
 * target (both are mapped in the owner's nvim), in which case the first j, which
 * already went into a text field, is taken back out. Focusing an editable
 * element that is not ours enters insert; when focus leaves editables entirely,
 * insert ends. Our own UI (command line, comment editor) sets modes itself.
 */

var JK_MS = 300;
var jk = null;  // { t, el } of the last j typed in insert mode (it passed through)

function insertJk(e, tok) {
  var el = targetOf(e);
  var now = Date.now();
  if ((tok === 'k' || tok === 'j') && jk && now - jk.t <= JK_MS && jk.el === el) {
    jk = null;
    consume(e);
    takeBackJ(el);
    leaveInsert();
    return true;
  }
  jk = tok === 'j' ? { t: now, el: el } : null;
  return false;
}

function takeBackJ(el) {
  try {
    if (el && el.isContentEditable) {
      var sel = window.getSelection();
      var n = sel && sel.isCollapsed && sel.anchorNode;
      if (n && n.nodeType === 3 && sel.anchorOffset > 0 && n.data.charAt(sel.anchorOffset - 1) === 'j') {
        document.execCommand('delete');
      }
      return;
    }
    if (!el || typeof el.value !== 'string' || !isEditable(el)) return;
    var p = el.selectionStart;
    if (p == null) {  // email/number inputs expose no caret
      if (/j$/.test(el.value)) { el.value = el.value.slice(0, -1); fireInput(el); }
    } else if (p > 0 && p === el.selectionEnd && el.value.charAt(p - 1) === 'j') {
      el.setRangeText('', p - 1, p, 'end');
      fireInput(el);
    }
  } catch (err) { VH.error('jk', err); }
}

function fireInput(el) {
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

function leaveInsert() {
  jk = null;
  var a = deepActive();
  VH.mode.set('normal');  // listeners (comment editor) read their field first
  if (a && a !== document.body && isEditable(a) && a.blur) a.blur();
}

function onFocusIn(e) {
  var t = targetOf(e);
  if (mode !== 'insert' && isEditable(t) && !isOurs(t)) VH.mode.set('insert');
}

function onFocusOut(e) {
  var t = targetOf(e);
  if (!isEditable(t) || isOurs(t)) return;
  // Decide after focus settles: moving to another field (or our own editor), or
  // the window losing focus (activeElement stays put), keeps insert.
  setTimeout(function () {
    if (mode !== 'insert') return;
    if (isEditable(deepActive())) return;
    VH.mode.set('normal');
  }, 0);
}

/* ---------------------------------------------------------------- commands */

var cmds = {};

VH.commands = {
  add: function (name, fn, desc) {
    if (!/^[A-Za-z][\w-]*$/.test(name)) throw new Error('vim-html: bad command name "' + name + '"');
    cmds[name] = { name: name, fn: fn, desc: desc || '' };
  },

  list: function () {
    return Object.keys(cmds).sort().map(function (n) { return { name: n, desc: cmds[n].desc }; });
  },

  // ':w', 'w', ':12', ':clear!', ':theme dark'. Unique prefixes resolve (':com'
  // -> comments); ':W' finds 'w'. Returns true when a command ran and did not
  // return false.
  run: function (text) {
    var s = String(text == null ? '' : text).replace(/^[\s:]+/, '').trim();
    if (!s) return true;
    if (/^\d+$/.test(s) || s === '$') {
      VH.emit('goto', { line: s === '$' ? Infinity : parseInt(s, 10) });
      return true;
    }
    var m = /^([A-Za-z][\w-]*)(!?)\s*([\s\S]*)$/.exec(s);
    var hit = m ? resolveCommand(m[1]) : { error: 'Not a command: ' + s };
    if (hit.error) { VH.toast(hit.error, { kind: 'error' }); return false; }
    try {
      return hit.cmd.fn(m[3], m[2] === '!') !== false;
    } catch (err) {
      VH.error(':' + hit.cmd.name, err);
      VH.toast(':' + hit.cmd.name + ' failed', { kind: 'error' });
      return false;
    }
  }
};

function resolveCommand(name) {
  if (cmds[name]) return { cmd: cmds[name] };
  var lower = name.toLowerCase();
  if (cmds[lower]) return { cmd: cmds[lower] };  // :W, :Q (the owner's typo guards)
  var hits = Object.keys(cmds).filter(function (n) { return n.indexOf(name) === 0; }).sort();
  if (hits.length === 1) return { cmd: cmds[hits[0]] };
  if (hits.length) return { error: 'Ambiguous: :' + name + ' (' + hits.join(', ') + ')' };
  return { error: 'Not a command: :' + name };
}

/* ------------------------------------------------------------------- store
 * One JSON object per bucket in localStorage. The in-memory copy is the source
 * of truth after load; every localStorage access is in try/catch, and the first
 * failure (private mode, sandboxed file://, quota) flips the bucket to memory
 * only for the rest of the session: values keep working, persistent = false,
 * and 'store' fires so the status line can warn. Values are deep-copied in and
 * out, so callers can never mutate stored state by accident.
 *
 * Every docs-CLI upload shares one origin and gets a new path, which is why the
 * per-document key is the source file's path (docKey).
 */

function clone(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}

function bucket(name, onLost) {
  var mem = {};
  var ls = null;
  var persistent = true;
  try {
    ls = window.localStorage;
    var raw = ls.getItem(name);
    if (raw) {
      try {
        var parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) mem = parsed;
      } catch (err) { /* corrupt entry: start empty, overwrite on next set */ }
    }
  } catch (err) {
    ls = null;
    persistent = false;
  }
  function write() {
    if (!ls) return;
    try {
      ls.setItem(name, JSON.stringify(mem));
    } catch (err) {
      ls = null;
      persistent = false;
      if (onLost) onLost();
    }
  }
  var api = {
    key: name,
    get: function (k) { return Object.prototype.hasOwnProperty.call(mem, k) ? clone(mem[k]) : null; },
    set: function (k, v) {
      if (v === undefined || v === null) delete mem[k]; else mem[k] = clone(v);
      write();
      return persistent;
    },
    del: function (k) { delete mem[k]; write(); return persistent; }
  };
  Object.defineProperty(api, 'persistent', { get: function () { return persistent; }, enumerable: true });
  return api;
}

// --key wins; else the source file build.py baked, so every copy and upload of
// one source shares its comments and two sources never do; a page built
// without one falls back to its own address.
function docKey() {
  if (VH.cfg.storageKey) return String(VH.cfg.storageKey);
  if (VH.cfg.source) return 'source:' + VH.cfg.source;
  // location.origin is "null" for file: in some browsers; build it by hand.
  return location.protocol + '//' + location.host + location.pathname;
}

VH.store = bucket('vim-html:v1:' + docKey(), function () { VH.emit('store', { persistent: false }); });
VH.prefs = bucket('vim-html:prefs');  // global; build.py's pre-paint script reads 'scheme' here

/* ------------------------------------------------------------------ scheme
 * Light unless the reader chose dark (remembered globally in prefs). The
 * attribute on <html> is the whole switch; themes define both token sets.
 */

function initialScheme() {
  var s = VH.prefs.get('scheme') || VH.cfg.scheme;
  return s === 'dark' ? 'dark' : 'light';
}

VH.scheme = {
  get: function () { return html.getAttribute('data-vh-scheme') === 'dark' ? 'dark' : 'light'; },
  set: function (s) {
    s = s === 'dark' ? 'dark' : 'light';
    html.setAttribute('data-vh-scheme', s);
    VH.prefs.set('scheme', s);
    VH.emit('scheme', { scheme: s });
    return s;
  },
  toggle: function () { return VH.scheme.set(VH.scheme.get() === 'dark' ? 'light' : 'dark'); }
};

/* --------------------------------------------------------------- clipboard
 * Three tiers, because file:// pages, plain-http pages and Safari each break a
 * different one:
 *   1. navigator.clipboard.writeText, called synchronously inside the key or
 *      click handler so it keeps the user activation;
 *   2. execCommand('copy') on a hidden textarea;
 *   3. a dialog with the text selected for the reader to copy by hand.
 * Resolves true when 1 or 2 succeeded. VH.clip.last records the text of every
 * attempt (tests read it); VH.clip.via says which tier was used.
 */

var clipDialog = null;

VH.clip = {
  last: null,
  via: null,
  copy: function (text) {
    text = String(text);
    VH.clip.last = text;
    VH.clip.via = null;
    var asyncTry = null;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) asyncTry = navigator.clipboard.writeText(text);
    } catch (err) { asyncTry = null; }
    if (!asyncTry) return Promise.resolve(fallbackCopy(text));
    // A permission prompt can leave writeText pending forever; give up after 1.5 s.
    var timeout = new Promise(function (resolve) { setTimeout(function () { resolve(false); }, 1500); });
    return Promise.race([asyncTry.then(function () { return true; }, function () { return false; }), timeout])
      .then(function (ok) {
        if (!ok) return fallbackCopy(text);
        VH.clip.via = 'clipboard';
        return true;
      });
  }
};

function fallbackCopy(text) {
  if (execCopy(text)) { VH.clip.via = 'execCommand'; return true; }
  VH.clip.via = 'dialog';
  openClipDialog(text);
  return false;
}

function execCopy(text) {
  var prevFocus = document.activeElement;
  var sel = window.getSelection();
  var saved = [];
  for (var i = 0; sel && i < sel.rangeCount; i++) saved.push(sel.getRangeAt(i));
  var ta = VH.ui.h('textarea', { readonly: '', 'aria-hidden': 'true', tabindex: '-1', 'class': 'vh-clip-sink' });
  ta.value = text;
  layer().appendChild(ta);
  var ok = false;
  try {
    ta.focus({ preventScroll: true });
    ta.select();
    ok = document.execCommand('copy') === true;
  } catch (err) {
    ok = false;
  }
  ta.remove();
  try {
    if (prevFocus && prevFocus !== document.body && prevFocus.focus) prevFocus.focus({ preventScroll: true });
    if (sel) { sel.removeAllRanges(); saved.forEach(function (r) { sel.addRange(r); }); }
  } catch (err) { /* restoring is best effort */ }
  return ok;
}

function openClipDialog(text) {
  closeClipDialog();
  var mac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '');
  var ta = VH.ui.h('textarea', { readonly: '', 'class': 'vh-clipdlg-text', 'aria-label': 'Text to copy' });
  ta.value = text;
  var box = VH.ui.h('div', { 'class': 'vh-clipdlg', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Copy text' }, [
    VH.ui.h('div', { 'class': 'vh-clipdlg-head' }, [
      VH.ui.h('span', { text: 'Copying was blocked. Press ' + (mac ? '⌘C' : 'Ctrl+C') + ' to copy, Esc to close.' }),
      VH.ui.h('button', { type: 'button', 'class': 'vh-clipdlg-close', text: 'Close', onclick: closeClipDialog })
    ]),
    ta
  ]);
  ta.addEventListener('copy', function () {
    setTimeout(function () { closeClipDialog(); VH.toast('Copied'); }, 0);
  });
  clipDialog = { box: box, prevFocus: document.activeElement };
  layer().appendChild(box);
  ta.focus({ preventScroll: true });
  ta.select();
}

function closeClipDialog() {
  if (!clipDialog) return;
  var d = clipDialog;
  clipDialog = null;
  d.box.remove();
  try { if (d.prevFocus && d.prevFocus.focus && d.prevFocus !== document.body) d.prevFocus.focus({ preventScroll: true }); } catch (err) { /* gone */ }
}

/* ------------------------------------------------------------------- toast */

var toastEl = null;
var toastTimer = 0;

VH.toast = function (msg, opts) {
  opts = opts || {};
  if (!toastEl) {
    toastEl = VH.ui.h('div', { 'class': 'vh-toast', role: 'status', 'aria-live': 'polite' });
    layer().appendChild(toastEl);
  }
  toastEl.textContent = String(msg);
  toastEl.className = 'vh-toast vh-show' + (opts.kind ? ' vh-toast-' + opts.kind : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { toastEl.classList.remove('vh-show'); }, opts.ms || 2600);
};

/* ---------------------------------------------------------------------- ui
 * VH.ui.layer (<div id="vh-ui" data-vh-ui>) holds every element the runtime
 * adds, so the line model, print styles and the auto-insert rule can tell our
 * UI from the document by one attribute. It is absolutely positioned at its
 * containing block's origin; VH.ui.origin() gives that origin in viewport
 * coordinates, so a module places an element over the document with
 *   top = rect.top - origin.top   (rect from getBoundingClientRect)
 * no matter how the host page positions <body>.
 */

function layer() {
  if (!VH.ui.layer) {
    var el = document.createElement('div');
    el.id = 'vh-ui';
    el.setAttribute('data-vh-ui', '');
    (document.body || html).appendChild(el);
    VH.ui.layer = el;
  }
  return VH.ui.layer;
}

// h('div', {class: 'x', text: 'hi', onclick: fn, 'aria-label': 'y'}, [children or strings])
function h(tag, attrs, kids) {
  var el = document.createElement(tag);
  Object.keys(attrs || {}).forEach(function (k) {
    var v = attrs[k];
    if (v == null || v === false) return;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.slice(0, 2) === 'on' && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  });
  [].concat(kids || []).forEach(function (kid) {
    if (kid != null) el.appendChild(typeof kid === 'string' ? document.createTextNode(kid) : kid);
  });
  return el;
}

var NON_TEXT_INPUTS = { button: 1, checkbox: 1, radio: 1, submit: 1, reset: 1, file: 1, image: 1, range: 1, color: 1, hidden: 1 };

function isEditable(el) {
  if (!el || el.nodeType !== 1) return false;
  if (el.isContentEditable) return true;
  if (el.tagName === 'TEXTAREA') return !el.readOnly && !el.disabled;
  if (el.tagName === 'INPUT') return !NON_TEXT_INPUTS[(el.type || 'text').toLowerCase()] && !el.readOnly && !el.disabled;
  if (el.tagName === 'SELECT') return !el.disabled;
  return false;
}

function isOurs(node) {
  var el = node && node.nodeType === 1 ? node : node && node.parentElement;
  return !!(el && el.closest && el.closest('[data-vh-ui]'));
}

function targetOf(e) {
  var path = e.composedPath && e.composedPath();
  return (path && path[0]) || e.target;
}

function deepActive() {
  var a = document.activeElement;
  while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
  return a;
}

VH.ui = {
  layer: null,
  h: h,
  isOurs: isOurs,
  isEditable: isEditable,
  origin: function () {
    var r = layer().getBoundingClientRect();
    return { top: r.top, left: r.left };
  }
};

/* -------------------------------------------------------------------- text
 * Offsets are positions in el.textContent, i.e. counted over every Text node
 * under el in document order. Comment anchors are stored this way, so these two
 * functions must stay exact inverses of each other.
 */

VH.text = {
  norm: function (s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); },

  rangeFrom: function (el, start, end) {
    var b = VH.text.bounds(el, start, end);
    var r = document.createRange();
    r.setStart(b[0], b[1]);
    r.setEnd(b[2], b[3]);
    return r;
  },

  // (+) rangeFrom's boundary points, [startNode, startOffset, endNode,
  // endOffset], without creating a Range. Every live Range stays registered
  // with the document until it is garbage-collected, and each DOM mutation
  // walks them all, so hot paths (search painting hundreds of matches per n)
  // build StaticRanges from these instead.
  bounds: function (el, start, end) {
    var total = el.textContent.length;
    start = Math.max(0, Math.min(start | 0, total));
    end = end == null ? start : Math.max(start, Math.min(end | 0, total));
    var w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    var pos = 0, n, last = null, s = null, t = null;
    while ((n = w.nextNode())) {
      var len = n.data.length;
      // At a boundary the start goes to the later node and the end to the earlier
      // one, so the range never begins or ends on an empty edge of a neighbour.
      if (!s && start < pos + len) s = [n, start - pos];
      if (!t && end > pos && end <= pos + len) t = [n, end - pos];
      last = n;
      pos += len;
      if (s && t) break;
    }
    if (!last) return [el, 0, el, 0];
    if (!s) s = [last, last.data.length];
    if (!t || start === end) t = s;
    return [s[0], s[1], t[0], t[1]];
  },

  offsetIn: function (el, node, offset) {
    if (node !== el && !el.contains(node)) {
      return el.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_PRECEDING ? 0 : el.textContent.length;
    }
    var r = document.createRange();
    r.setStart(el, 0);
    r.setEnd(node, offset);
    return r.toString().length;
  }
};

/* --------------------------------------------------------------- listeners */

function installListeners() {
  window.addEventListener('keydown', onKeydown, true);
  document.addEventListener('focusin', onFocusIn, true);
  document.addEventListener('focusout', onFocusOut, true);
  window.addEventListener('blur', function () { resetPending(); jk = null; });
}

/* ------------------------------------------------------------ core keymaps */

VH.keys.map('normal', 'i', function () { VH.mode.set('insert'); },
  { desc: 'insert mode: keys go to the page', group: 'modes' });
VH.keys.map('normal', '<Esc>', function () { VH.emit('escape', {}); },
  { desc: 'clear pending keys, highlights and popovers', group: 'modes' });
VH.keys.map('insert', '<Esc>', function () { leaveInsert(); },
  { desc: 'back to normal mode', group: 'modes' });
// jk and jj are detected in insertJk, not the keymap; these entries only document them.
['jk', 'jj'].forEach(function (seq) {
  entries.push({ display: true, modes: ['insert'], tokens: seq.split(''), seq: seq,
                 desc: 'back to normal mode (typed within 300 ms)', group: 'modes' });
});
