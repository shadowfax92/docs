/* Keymap search: Space s k opens a small searchable list of this page's live
 * vim keymaps, after the owner's LazyVim <leader>sk keymap picker. It lists
 * what VH.keys.list() returns when opened (the skill's maps, docs' dC, and
 * anything registered later), and it only lists: nothing selected here runs.
 *
 * Ownership and hosting: a private docs module, not part of the skill.
 * generate.py appends this file to both served layers:
 *   enhanced pages  inside the runtime bundle's `if (!window.__VH)` guard,
 *                   after host.js, so it only ever meets the runtime that
 *                   bundle just created;
 *   baked pages     after baked-hook.js in the served startup script, so
 *                   the guard below re-checks the same live instance, version
 *                   and boot timing before touching the baked runtime.
 * Either way it is one more registrant on the authentic runtime: one keymap
 * (so Space ? and which-key list it), one 'mode' listener, and DOM inside
 * VH.ui.layer. No second core, config, store, dispatcher or page listener.
 *
 * Keyboard handoff: while open, the picker holds the runtime's 'command' mode,
 * the rule search.js's own pickers (Space s b, Space s s) follow. In that mode
 * core types printable keys into the focused field, so j, k, q, :, Space and
 * dC become query text, never commands; mapped special keys (arrows, Tab,
 * Ctrl-n...) go to search.js's owner, which is empty while this picker is open
 * and declines them, so they reach the keydown listener here. Esc is core's:
 * its "no mode may trap the reader" fallback returns to normal, and the 'mode'
 * listener closes the picker. Every other way out of 'command' (Vim off, a
 * click into a page field) closes it as well.
 */
(function () {
  'use strict';
  var VH = window.__VH;
  // Same gate as baked-hook.js: a v1 runtime still parsing, not yet booted,
  // with every part of the interface used below. A replaced, unknown or
  // already-booted instance is left exactly as it is.
  if (document.readyState !== 'loading' || !VH || VH.version !== 1 || VH.booted !== false ||
      typeof VH.init !== 'function' || typeof VH.on !== 'function' || !VH.keys ||
      typeof VH.keys.map !== 'function' || typeof VH.keys.list !== 'function' || !VH.mode ||
      typeof VH.mode.get !== 'function' || typeof VH.mode.set !== 'function' || !VH.ui ||
      typeof VH.ui.h !== 'function') return;
  var keys = VH.keys;
  var h = VH.ui.h;

  var MAX_QUERY = 64;   // the input's maxlength; ranking reads no more
  var MAX_TERMS = 8;
  var MAX_ROWS = 300;   // rows rendered at once; the count still reports all
  var MODE_TAGS = { normal: 'n', insert: 'i', visual: 'v', vline: 'V', command: 'c', panel: 'sidebar', help: 'help' };
  var MODE_NAMES = { normal: 'normal', insert: 'insert', visual: 'visual', vline: 'visual line',
                     command: 'command line', panel: 'sidebar', help: 'help' };
  // Key labels as chrome.js prints them in Space ? and which-key, so one key
  // reads the same everywhere: '<leader>sk' -> Space sk, '<C-d>' -> Ctrl-d.
  var NAMED = { leader: 'Space', space: 'Space', cr: 'Enter', esc: 'Esc', bs: 'Backspace', tab: 'Tab',
                del: 'Delete', down: '\u2193', up: '\u2191', left: '\u2190', right: '\u2192',
                lt: '<', bar: '|', bslash: '\\', pageup: 'PageUp', pagedown: 'PageDown', home: 'Home', end: 'End' };
  var MOD_NAMES = { C: 'Ctrl', A: 'Alt', M: 'Alt', D: 'Cmd', S: 'Shift' };

  var picker = null;  // the one open picker: {root, input, list, count, items, results, rows, sel, prev}
  var style = null;

  VH.init(function () {
    // The page may have replaced window.__VH while it parsed; only the
    // instance inspected above gets the key.
    if (window.__VH !== VH || VH.keys !== keys) return;
    // An authored Space s k (or an earlier copy of this module) keeps the key.
    if (taken()) return;
    VH.keys.map('normal', '<leader>sk', function () { open(); },
      { desc: 'search keymaps', group: 'search' });
    VH.on('mode', function (e) {
      if (!picker || e.from !== 'command' || e.to === 'command') return;
      // Back to normal is Esc (core's fallback): return focus as a dismissal.
      // Anything else (insert from a click into a page field, Vim off) leaves
      // focus wherever the reader or the host put it.
      dismiss(e.to === 'normal');
    });
  });

  function taken() {
    return VH.keys.list().some(function (k) {
      return [].concat(k.modes).indexOf('normal') >= 0 &&
        String(k.seq).replace(/<(?:leader|space)>/gi, ' ') === ' sk';
    });
  }

  /* ------------------------------------------------------------ key labels */

  function tokens(seq) {
    return String(seq).match(/<[^<>\s]+>|[\s\S]/g) || [];
  }

  function label(tok) {
    if (tok.length === 1 || tok.charAt(0) !== '<') return tok === ' ' ? 'Space' : tok;
    var parts = tok.slice(1, -1).split('-');
    var key = parts.pop() || '-';
    var name = NAMED[key.toLowerCase()] || key;
    return parts.map(function (m) { return MOD_NAMES[m.toUpperCase()] || m; }).concat(name).join('-');
  }

  // A run of plain characters stays one chip ('gg', 'dC'); each bracketed key
  // gets its own ('Space', 'Ctrl-d').
  function chips(seq) {
    var out = [];
    var run = '';
    tokens(seq).forEach(function (t) {
      if (t.length === 1 && t !== ' ') { run += t; return; }
      if (run) { out.push(run); run = ''; }
      out.push(label(t));
    });
    if (run) out.push(run);
    return out;
  }

  /* --------------------------------------------------------------- ranking
   * Inert matching only: strings are compared with indexOf, never compiled as
   * a pattern, and the query is capped at MAX_QUERY characters and MAX_TERMS
   * words. Case-insensitive throughout; an exact-case key match only ranks
   * higher (dC before dc for "dC"), it never hides the other.
   *   whole query as a key   'dC', '<leader>s', 'Space s', 'sk' (leader-less)
   *   every word, anywhere   key, description (word starts first), group,
   *                          mode
   *   fuzzy, as a fallback   only when nothing matches literally: a word of 3+
   *                          letters may then match a description by its letters
   *                          in order, close together ('cmnts' -> comments), so
   *                          'delete' never drags in 'deliberately'
   * Ties keep registration order, like fzf-lua's keymaps (tiebreak=index).
   */

  // Lowercase without changing length, so match positions index the original.
  function fold(s) {
    var l = s.toLowerCase();
    if (l.length === s.length) return l;
    return s.split('').map(function (c) { var x = c.toLowerCase(); return x.length === 1 ? x : c; }).join('');
  }

  function toItem(k, i) {
    var seq = String(k.seq == null ? '' : k.seq);
    var desc = String(k.desc == null ? '' : k.desc);
    var group = String(k.group == null ? '' : k.group);
    var modes = [].concat(k.modes == null ? [] : k.modes).map(String);
    var shown = chips(seq);
    // What a reader may type for a key: as mapped, as shown, one key per word
    // ('Space s k'), and without the leader.
    var forms = [seq, shown.join(' '), tokens(seq).map(label).join(' ')];
    if (/^<(?:leader|space)>./i.test(seq)) forms.push(seq.replace(/^<(?:leader|space)>/i, ''));
    forms = forms.filter(function (f, n) { return f && forms.indexOf(f) === n; });
    return {
      i: i, seq: seq, desc: desc, group: group, modes: modes, chips: shown, forms: forms,
      formsLow: forms.map(fold), descLow: fold(desc), groupLow: fold(group),
      modesLow: modes.map(function (m) { return fold(MODE_NAMES[m] || m); })
    };
  }

  function rank(items, query) {
    var q = String(query).slice(0, MAX_QUERY).replace(/\s+/g, ' ').trim();
    if (!q) return items.map(function (it) { return { it: it, score: 0, hits: null, keyHit: false }; });
    var terms = q.split(' ').slice(0, MAX_TERMS);
    function pass(fuzzyOk) {
      var out = [];
      items.forEach(function (it) {
        var r = score(it, q, terms, fuzzyOk);
        if (r) out.push(r);
      });
      return out;
    }
    var out = pass(false);
    if (!out.length) out = pass(true);
    return out.sort(function (a, b) { return (b.score - a.score) || (a.it.i - b.it.i); });
  }

  function score(it, q, terms, fuzzyOk) {
    var whole = keyScore(it, q);
    var total = whole;
    var hits = [];
    var keyHit = whole > 0;
    for (var n = 0; n < terms.length; n++) {
      var r = termScore(it, terms[n], hits, fuzzyOk);
      if (!r.score && !whole) return null;
      total += r.score;
      keyHit = keyHit || r.key;
    }
    return { it: it, score: total, hits: hits, keyHit: keyHit };
  }

  function keyScore(it, q) {
    var ql = fold(q);
    var best = 0;
    it.forms.forEach(function (f, n) {
      var fl = it.formsLow[n];
      var s = f === q ? 1000 : fl === ql ? 900 : f.indexOf(q) === 0 ? 700 : fl.indexOf(ql) === 0 ? 600 : 0;
      // Of two prefix matches, the shorter remainder is the likelier key.
      if (s && s < 900) s -= Math.min(99, f.length - q.length);
      if (s > best) best = s;
    });
    return best;
  }

  // Score one word; description positions it matched are pushed onto `hits`.
  function termScore(it, t, hits, fuzzyOk) {
    var tl = fold(t);
    var best = 0;
    var key = false;
    for (var n = 0; n < it.forms.length; n++) {
      if (it.forms[n].indexOf(t) >= 0) { best = Math.max(best, 60); key = true; }
      else if (it.formsLow[n].indexOf(tl) >= 0) { best = Math.max(best, 45); key = true; }
    }
    // A single letter counts in a description only where it starts a word;
    // inside words it would match, and mark, nearly every row.
    var word = wordStart(it.descLow, tl);
    var at = word >= 0 ? word : tl.length > 1 ? it.descLow.indexOf(tl) : -1;
    if (at >= 0) {
      best = Math.max(best, word >= 0 ? 40 : 25);
      for (var i = 0; i < tl.length; i++) hits.push(at + i);
    }
    var g = it.groupLow.indexOf(tl);
    if (g >= 0) best = Math.max(best, g === 0 ? 30 : 20);
    if (it.modesLow.some(function (m) { return m.indexOf(tl) === 0; })) best = Math.max(best, 20);
    if (!best && fuzzyOk && tl.length >= 3) {
      var f = fuzzy(it.descLow, tl);
      if (f) { best = f.score; Array.prototype.push.apply(hits, f.pos); }
    }
    return { score: best, key: key };
  }

  // Index of `t` where it starts a word in `s`, or -1.
  function wordStart(s, t) {
    for (var at = s.indexOf(t); at >= 0; at = s.indexOf(t, at + 1)) {
      if (at === 0 || !/[a-z0-9]/i.test(s.charAt(at - 1))) return at;
    }
    return -1;
  }

  // The letters of `pat` in order within the first 200 characters of `hay`,
  // tightened to the shortest window that ends where they end. More skipped
  // characters than letters reads as noise ('here' in 'the first line'), so
  // that is no match; 'cmnts' still finds 'comments'.
  function fuzzy(hay, pat) {
    hay = hay.slice(0, 200);
    var pi = 0;
    var end = -1;
    for (var i = 0; i < hay.length && end < 0; i++) {
      if (hay.charAt(i) === pat.charAt(pi) && ++pi === pat.length) end = i;
    }
    if (end < 0) return null;
    var pos = [];
    pi = pat.length - 1;
    for (i = end; i >= 0 && pi >= 0; i--) {
      if (hay.charAt(i) === pat.charAt(pi)) { pos.unshift(i); pi--; }
    }
    var gaps = end - pos[0] + 1 - pat.length;
    if (gaps > pat.length) return null;
    return { score: Math.max(1, 15 - gaps), pos: pos };
  }

  /* ---------------------------------------------------------------- picker
   * One picker at a time, built fresh on open and removed whole on dismiss:
   * every listener below lives on its own nodes, so nothing outlives a close
   * and reopening never stacks handlers. Descriptions, groups and the query
   * reach the page only as text (VH.ui.h's text and string children), so an
   * HTML-looking description or query stays inert.
   */

  function open() {
    if (picker || VH.disabled || VH.mode.get() !== 'normal') return;
    var entries = [];
    try { entries = VH.keys.list(); } catch (err) { report(err); }
    var items = entries.map(toItem);
    var count = h('span', { 'class': 'docs-ks-count', 'aria-live': 'polite' });
    var input = h('input', {
      type: 'text', 'class': 'docs-ks-input', maxlength: String(MAX_QUERY), spellcheck: 'false',
      autocomplete: 'off', autocapitalize: 'off', placeholder: 'Search keys, descriptions, modes',
      role: 'combobox', 'aria-expanded': 'true', 'aria-controls': 'docs-ks-list',
      'aria-autocomplete': 'list', 'aria-label': 'Search keymaps'
    });
    var list = h('div', { id: 'docs-ks-list', 'class': 'docs-ks-list', role: 'listbox', 'aria-label': 'Keymaps' });
    var close = h('button', { type: 'button', 'class': 'docs-ks-close', tabindex: '-1', 'aria-label': 'Close (Esc)',
                             title: 'Close (Esc)', text: '\u00d7' });
    var box = h('div', { 'class': 'docs-ks-box', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'docs-ks-title' }, [
      h('div', { 'class': 'docs-ks-bar' }, [h('span', { id: 'docs-ks-title', 'class': 'docs-ks-title', text: 'Keymaps' }), count, close]),
      h('div', { 'class': 'docs-ks-prompt' }, [h('span', { 'class': 'docs-ks-caret', 'aria-hidden': 'true', text: '\u203a' }), input]),
      list,
      h('div', { 'class': 'docs-ks-foot' }, [
        h('span', null, [kbd('\u2191'), kbd('\u2193'), 'move']),
        h('span', null, [kbd('Esc'), 'close']),
        h('span', { 'class': 'docs-ks-note', text: 'lists keys only; nothing runs' })
      ])
    ]);
    var root = h('div', { 'class': 'docs-ks', 'data-docs-keymap-search': '' }, [box]);
    var p = { root: root, input: input, list: list, count: count, items: items, results: [], rows: [], sel: -1,
              prev: activeElement() };

    input.addEventListener('input', function () { refilter(p); });
    box.addEventListener('keydown', function (e) { onKey(p, e); });
    // Query typing ends here: authored key handlers never see it bubble up.
    box.addEventListener('keypress', stop);
    box.addEventListener('keyup', stop);
    // Pointer: the backdrop dismisses, rows only select, and the query keeps focus.
    root.addEventListener('mousedown', function (e) {
      if (e.target === root) { e.preventDefault(); dismiss(true); }
    });
    box.addEventListener('mousedown', function (e) { if (e.target !== input) e.preventDefault(); });
    close.addEventListener('click', function () { dismiss(true); });
    list.addEventListener('click', function (e) {
      for (var el = e.target; el && el !== list; el = el.parentNode) {
        var i = el.getAttribute && el.getAttribute('data-i');
        if (i != null) { select(p, +i); return; }
      }
    });

    if (!style) {
      style = h('style', { 'data-docs-keymap-search': '', text: CSS });
      VH.ui.layer.appendChild(style);
    }
    VH.ui.layer.appendChild(root);
    picker = p;
    VH.mode.set('command');
    input.focus({ preventScroll: true });
    refilter(p);
  }

  function dismiss(restore) {
    if (!picker) return;
    var p = picker;
    picker = null;  // first, so the 'mode' event below finds nothing to close
    p.root.remove();
    if (VH.mode.get() === 'command') VH.mode.set('normal');
    var prev = p.prev;
    if (restore && prev && prev !== document.body && prev.isConnected !== false && typeof prev.focus === 'function') {
      try { prev.focus({ preventScroll: true }); } catch (err) { /* it may have gone */ }
    }
  }

  function onKey(p, e) {
    stop(e);
    if (e.isComposing || e.keyCode === 229) return;  // the IME owns these keys
    var k = e.key;
    var ctrl = e.ctrlKey && !e.altKey && !e.metaKey;
    var lower = ctrl && k ? k.toLowerCase() : '';
    var step = 0;
    if (k === 'ArrowDown' || lower === 'n' || lower === 'j' || (k === 'Tab' && !e.shiftKey)) step = 1;
    else if (k === 'ArrowUp' || lower === 'p' || lower === 'k' || (k === 'Tab' && e.shiftKey)) step = -1;
    else if (k === 'PageDown' || k === 'PageUp') step = (k === 'PageDown' ? 1 : -1) * pageRows(p);
    else if (k === 'Escape' || lower === 'c') { e.preventDefault(); dismiss(true); return; }
    else if (lower === 'u') { e.preventDefault(); killToStart(p); return; }
    else if (k === 'Enter') { e.preventDefault(); explain(p); return; }
    else return;  // anything else is the input's own editing
    e.preventDefault();
    if (p.rows.length) select(p, Math.max(0, Math.min(p.rows.length - 1, p.sel + step)));
  }

  // Enter would run the key in nvim; here it says how to use it instead.
  function explain(p) {
    var r = p.results[p.sel];
    if (r && typeof VH.toast === 'function') {
      VH.toast('Listing only. Esc, then press ' + (r.it.chips.join(' ') || r.it.seq));
    }
  }

  function killToStart(p) {
    var input = p.input;
    var end = input.selectionEnd == null ? input.value.length : input.selectionEnd;
    input.value = input.value.slice(end);
    input.setSelectionRange(0, 0);
    refilter(p);
  }

  function refilter(p) {
    p.results = rank(p.items, p.input.value);
    render(p);
  }

  function render(p) {
    var res = p.results;
    p.count.textContent = res.length + '/' + p.items.length;
    p.list.textContent = '';
    p.rows = [];
    p.sel = -1;
    if (!res.length) {
      p.input.removeAttribute('aria-activedescendant');
      p.list.appendChild(h('div', { 'class': 'docs-ks-empty', role: 'status' }, [
        'No keymaps match \u201c' + p.input.value.trim() + '\u201d',
        h('span', { text: 'Try a key such as dC or gg, or a word such as fold or comment.' })
      ]));
      return;
    }
    var n = Math.min(res.length, MAX_ROWS);
    for (var i = 0; i < n; i++) {
      var row = rowEl(res[i], i);
      p.rows.push(row);
      p.list.appendChild(row);
    }
    if (res.length > n) {
      p.list.appendChild(h('div', { 'class': 'docs-ks-more', text: (res.length - n) + ' more: keep typing to narrow' }));
    }
    p.list.scrollTop = 0;
    select(p, 0);
  }

  function rowEl(r, i) {
    var it = r.it;
    var meta = it.modes.map(function (m) {
      return h('span', { 'class': 'docs-ks-mode', title: MODE_NAMES[m] || m, text: MODE_TAGS[m] || m });
    });
    // A group that only repeats the mode ('sidebar' in the sidebar) is shown once.
    var tags = it.modes.map(function (m) { return MODE_TAGS[m] || m; });
    if (it.group && tags.indexOf(it.group) < 0) meta.push(h('span', { 'class': 'docs-ks-group', text: it.group }));
    return h('div', { id: 'docs-ks-opt-' + i, 'class': 'docs-ks-row', role: 'option', 'data-i': String(i),
                      'aria-selected': 'false' }, [
      h('span', { 'class': 'docs-ks-keys' + (r.keyHit ? ' docs-ks-keyhit' : '') }, it.chips.map(kbd)),
      h('span', { 'class': 'docs-ks-desc' }, marked(it.desc || '\u2014', it.desc ? r.hits : null)),
      h('span', { 'class': 'docs-ks-meta' }, meta)
    ]);
  }

  // The description as text runs, matched characters in <mark>.
  function marked(text, hits) {
    if (!hits || !hits.length) return [text];
    var on = {};
    hits.forEach(function (x) { on[x] = true; });
    var out = [];
    var run = '';
    var hit = false;
    for (var i = 0; i <= text.length; i++) {
      var now = i < text.length && !!on[i];
      if (i === text.length || now !== hit) {
        if (run) out.push(hit ? h('mark', { 'class': 'docs-ks-hit', text: run }) : run);
        run = '';
        hit = now;
      }
      if (i < text.length) run += text.charAt(i);
    }
    return out;
  }

  function select(p, i) {
    var old = p.rows[p.sel];
    if (old) old.setAttribute('aria-selected', 'false');
    p.sel = i;
    var row = p.rows[i];
    if (!row) return;
    row.setAttribute('aria-selected', 'true');
    p.input.setAttribute('aria-activedescendant', row.id);
    // Scroll the list only, never the page behind the fixed picker.
    var list = p.list;
    var top = row.offsetTop;
    var bottom = top + row.offsetHeight;
    if (top < list.scrollTop) list.scrollTop = top;
    else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight;
  }

  function pageRows(p) {
    var first = p.rows[0];
    var rowH = first && first.offsetHeight ? first.offsetHeight : 28;
    return Math.max(1, Math.floor(p.list.clientHeight / rowH) - 1);
  }

  function kbd(text) {
    return h('span', { 'class': 'docs-ks-kbd', text: text });
  }

  function stop(e) {
    e.stopPropagation();
  }

  function activeElement() {
    var a = document.activeElement;
    while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
    return a;
  }

  function report(err) {
    if (typeof VH.error === 'function') VH.error('keymap search', err);
  }

  /* ---------------------------------------------------------------- styles
   * Injected once, on first open, inside VH.ui.layer. Every selector is under
   * #vh-ui, which outranks authored element and class rules (the first line
   * resets the inherited and box properties those rules commonly set), and
   * every colour, font and radius is a runtime token, so the picker follows the
   * page's light/dark scheme and a baked page's own theme without changing either.
   * Stacked with the help overlay (6): the two are never open together, and
   * the runtime's toast (8) stays readable above it.
   */
  var CSS = [
    '#vh-ui .docs-ks, #vh-ui .docs-ks * { margin: 0; padding: 0; float: none; letter-spacing: normal; word-spacing: normal; text-indent: 0; text-transform: none; text-shadow: none; }',
    '#vh-ui .docs-ks { position: fixed; top: 0; right: 0; bottom: 0; left: 0; z-index: 6; display: flex; align-items: flex-start; justify-content: center; padding: 12vh 16px 16px; background: rgba(0, 0, 0, 0.14); }',
    ':root[data-vh-scheme="dark"] #vh-ui .docs-ks { background: rgba(0, 0, 0, 0.42); }',
    '#vh-ui .docs-ks-box { display: flex; flex-direction: column; width: min(680px, 100%); max-height: 100%; overflow: hidden; border: 1px solid var(--vh-edge, #d4d4d8); border-radius: var(--vh-radius, 6px); background: var(--vh-surface, #f7f7f8); color: var(--vh-ink, #18181b); box-shadow: var(--vh-shadow, 0 6px 24px rgba(24, 24, 27, 0.14)); font: 13px/1.45 var(--vh-font-body, system-ui, sans-serif); text-align: left; }',
    '#vh-ui .docs-ks-bar { display: flex; flex: none; align-items: center; gap: 10px; padding: 8px 8px 0 14px; color: var(--vh-muted, #52525b); font-size: 12px; }',
    '#vh-ui .docs-ks-title { font-weight: 700; letter-spacing: 0.02em; color: var(--vh-accent-ink, #1d4ed8); }',
    '#vh-ui .docs-ks-count { margin-left: auto; font-family: var(--vh-font-mono, ui-monospace, monospace); font-variant-numeric: tabular-nums; }',
    '#vh-ui .docs-ks-close { display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px; border: 0; border-radius: 4px; background: transparent; color: var(--vh-muted, #52525b); font: 18px/1 var(--vh-font-body, system-ui, sans-serif); cursor: pointer; }',
    '#vh-ui .docs-ks-close:hover { background: var(--vh-sunk, #f1f1f3); color: var(--vh-ink, #18181b); }',
    '#vh-ui .docs-ks-close:focus-visible { outline: 2px solid var(--vh-accent, #2563eb); outline-offset: 1px; }',
    '#vh-ui .docs-ks-prompt { display: flex; flex: none; align-items: center; gap: 8px; height: 36px; margin: 8px; padding: 0 10px; border: 1px solid var(--vh-line, #e4e4e7); border-radius: calc(var(--vh-radius, 6px) * 0.7); background: var(--vh-bg, #ffffff); }',
    '#vh-ui .docs-ks-prompt:focus-within { border-color: var(--vh-accent, #2563eb); box-shadow: 0 0 0 2px var(--vh-accent-soft, #dbeafe); }',
    '#vh-ui .docs-ks-caret { color: var(--vh-accent-ink, #1d4ed8); font: 700 15px/1 var(--vh-font-mono, ui-monospace, monospace); }',
    '#vh-ui .docs-ks-input { flex: 1; min-width: 0; width: auto; height: auto; border: 0; border-radius: 0; outline: 0; box-shadow: none; background: transparent; color: var(--vh-ink, #18181b); caret-color: var(--vh-accent, #2563eb); font: 15px/1.4 var(--vh-font-mono, ui-monospace, monospace); -webkit-appearance: none; appearance: none; }',
    '#vh-ui .docs-ks-input::placeholder { color: var(--vh-faint, #a1a1aa); opacity: 1; }',
    '#vh-ui .docs-ks-list { position: relative; flex: 0 1 auto; min-height: 0; max-height: min(52vh, 460px); padding-bottom: 6px; overflow-y: auto; overscroll-behavior: contain; }',
    '#vh-ui .docs-ks-row { display: grid; grid-template-columns: minmax(6.5rem, 10rem) minmax(0, 1fr) auto; align-items: baseline; gap: 2px 12px; padding: 5px 12px 5px 10px; border-left: 2px solid transparent; color: var(--vh-ink, #18181b); cursor: default; }',
    '#vh-ui .docs-ks-row:hover { background: var(--vh-sunk, #f1f1f3); }',
    '#vh-ui .docs-ks-row[aria-selected="true"] { background: var(--vh-accent-soft, #dbeafe); border-left-color: var(--vh-accent, #2563eb); }',
    '#vh-ui .docs-ks-keys { display: flex; flex-wrap: wrap; gap: 3px; min-width: 0; }',
    '#vh-ui .docs-ks-kbd { display: inline-block; min-width: 1.7em; max-width: 100%; padding: 0 5px; overflow-wrap: anywhere; border: 1px solid var(--vh-line, #e4e4e7); border-bottom-width: 2px; border-radius: 4px; background: var(--vh-bg, #ffffff); color: var(--vh-ink, #18181b); font: 600 11px/17px var(--vh-font-mono, ui-monospace, monospace); text-align: center; }',
    '#vh-ui .docs-ks-keyhit .docs-ks-kbd { border-color: var(--vh-accent, #2563eb); color: var(--vh-accent-ink, #1d4ed8); }',
    '#vh-ui .docs-ks-desc { min-width: 0; overflow-wrap: anywhere; }',
    '#vh-ui .docs-ks-hit { background: none; color: var(--vh-accent-ink, #1d4ed8); font-weight: 700; text-decoration: underline; text-underline-offset: 2px; }',
    '#vh-ui .docs-ks-meta { display: flex; flex-wrap: wrap; justify-content: flex-end; align-items: baseline; gap: 2px 6px; min-width: 0; color: var(--vh-faint, #a1a1aa); font: 11px/1.5 var(--vh-font-mono, ui-monospace, monospace); }',
    '#vh-ui .docs-ks-mode { color: var(--vh-muted, #52525b); }',
    '#vh-ui .docs-ks-empty { padding: 14px; color: var(--vh-muted, #52525b); overflow-wrap: anywhere; }',
    '#vh-ui .docs-ks-empty span { display: block; margin-top: 4px; color: var(--vh-faint, #a1a1aa); font-size: 12px; }',
    '#vh-ui .docs-ks-more { padding: 6px 14px; color: var(--vh-faint, #a1a1aa); font-size: 12px; }',
    '#vh-ui .docs-ks-foot { display: flex; flex: none; flex-wrap: wrap; align-items: center; gap: 4px 14px; padding: 7px 12px 8px; border-top: 1px solid var(--vh-line, #e4e4e7); color: var(--vh-faint, #a1a1aa); font-size: 11.5px; }',
    '#vh-ui .docs-ks-foot .docs-ks-kbd { min-width: 1.5em; margin-right: 3px; font-size: 10.5px; line-height: 15px; }',
    '#vh-ui .docs-ks-note { margin-left: auto; }',
    '@media (max-width: 560px) {',
    '  #vh-ui .docs-ks { padding: 8px; }',
    '  #vh-ui .docs-ks-list { max-height: none; }',
    '  #vh-ui .docs-ks-row { grid-template-columns: minmax(0, 1fr) auto; }',
    '  #vh-ui .docs-ks-desc { grid-column: 1 / -1; grid-row: 2; }',
    '  #vh-ui .docs-ks-input { font-size: 16px; }',
    '  #vh-ui .docs-ks-note { margin-left: 0; }',
    '}',
    '@media (prefers-reduced-motion: no-preference) { #vh-ui .docs-ks-box { animation: docs-ks-in 0.12s ease-out; } }',
    '@keyframes docs-ks-in { from { opacity: 0; transform: translateY(-4px); } }'
  ].join('\n');
})();
