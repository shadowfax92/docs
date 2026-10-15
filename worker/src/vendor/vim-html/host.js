/* Hosting adapter: the skill still owns every motion, mode and comment. At boot
 * it applies the docs defaults (numbers off, dC for :clear), and its small dock
 * exposes help and a true keyboard opt-out without changing document identity.
 * The public-origin opt-out is remembered separately from skill prefs; if
 * storage is unavailable it still works for the current page load. On docs'
 * generated viewer it also hands light/dark to the viewer (adoptViewerTheme).
 */
(function () {
  var VH = window.__VH;
  VH.init(function () {
    // Run synchronously in the boot task, before any gutter can paint. Use the
    // skill's toggle so its number state and CSS agree while signs, line IDs
    // and the reader's Space u l binding stay intact; never write global prefs.
    if (VH.gutter.numbers()) VH.gutter.toggleNumbers();
    // One alias for the skill's own :clear, so the deletion, its single undo
    // step (u / Ctrl-r), the count toast, storage and highlight/sidebar refresh
    // are not reimplemented here. dc clears the cursor line; dC widens it to
    // every comment of this document, detached ones included. Normal mode only:
    // page fields, the comment editor, the command line, the sidebar (which has
    // its own D) and Vim off never dispatch it. baked-hook.js maps the same key.
    VH.keys.map('normal', 'dC', function () { VH.commands.run('clear'); },
      { desc: 'delete all comments in this document (u undoes)', group: 'comments' });
    var help = VH.ui.h('button', { type: 'button', text: 'Vim help', title: 'Vim keys: Space ?', onclick: released(function () {
      setEnabled(true);
      VH.commands.run('help');
    }) });
    var toggle = VH.ui.h('button', { type: 'button', text: 'Vim off', 'aria-pressed': 'false', onclick: released(function () {
      setEnabled(!!VH.disabled);
    }) });
    // A focused button keeps Space/Enter for native activation (generate.py), so
    // after a mouse click on "Vim on" the next Space u b pressed "Vim off" again.
    // Pointer clicks (detail > 0) hand focus back to the page; keyboard users,
    // whose activation reports detail 0, keep their place. The viewer's theme
    // toggle (preview.ts) follows the same rule.
    function released(action) {
      return function (event) { action(); if (event.detail) event.currentTarget.blur(); };
    }
    function setEnabled(enabled) {
      // Close transient modes before suspending dispatch; Esc cannot close an
      // editor after key handling has been disabled. Stored comments stay intact.
      VH.emit('escape', {});
      // A real mode transition clears pending counts/prefixes/timers even when
      // already normal. Otherwise 5 -> off/on -> j would still mean 5j.
      VH.mode.set('insert');
      VH.mode.set('normal');
      VH.disabled = !enabled;
      document.documentElement.toggleAttribute('data-docs-vim-off', !enabled);
      toggle.textContent = enabled ? 'Vim off' : 'Vim on';
      toggle.setAttribute('aria-pressed', String(!enabled));
      try { localStorage.setItem('docs-vim', enabled ? 'on' : 'off'); } catch (e) { /* session-only opt-out */ }
    }
    VH.ui.layer.appendChild(VH.ui.h('div', { 'class': 'docs-vim-controls', role: 'group', 'aria-label': 'Vim controls' }, [help, toggle]));
    VH.on('mode', function (event) {
      if (event.to !== 'help') return;
      var body = document.querySelector('#vh-help .vh-help-body');
      if (!body) return;
      body.prepend(VH.ui.h('p', { text: 'These keys are added by docs. Press i to use the page normally.' }));
      body.appendChild(VH.ui.h('button', { type: 'button', text: 'Turn off vim keys on this site', onclick: function () { setEnabled(false); } }));
    });
    var enabled = true;
    try { enabled = localStorage.getItem('docs-vim') !== 'off'; } catch (e) { /* default remains enabled */ }
    if (!enabled) setEnabled(false);
    if (VH.cfg.docsViewer === true) adoptViewerTheme();
  });

  /* Generated previews have one light/dark choice, owned by the viewer page
   * (preview.ts): its toolbar toggle, stored as docs-theme and applied as
   * <html data-theme>. Without this, the skill's fixed #vh-theme covered that
   * toggle and, like Space u b and :theme, flipped only data-vh-scheme, which
   * under theme none recolors the runtime chrome and never the document.
   *
   *   toolbar toggle -- click --> data-theme + docs-theme   (viewer)
   *   Space u b / :theme --> VH.scheme.set --> toggle.click()
   *   data-theme --MutationObserver--> data-vh-scheme + 'scheme' event (chrome)
   *
   * Replacing VH.scheme is the skill's own seam: chrome.js resolves it on every
   * command. It never writes the global vim-html:prefs scheme, which stays the
   * authored/baked pages' choice. The skill's toggles hide via host.css. Runs in
   * the boot task, after the skill set data-vh-scheme from prefs and before the
   * chrome first paints, and keeps mirroring while Vim is off so turning it
   * back on shows matching chrome. Only enhanceHtml's generatedViewer flag
   * reaches here: authored pages reuse data-theme names for their own themes.
   */
  function adoptViewerTheme() {
    var html = document.documentElement;
    var toggle = document.querySelector('nav.viewer-bar [data-theme-toggle]');
    if (!toggle) return;
    function current() { return html.getAttribute('data-theme') === 'dark' ? 'dark' : 'light'; }
    function mirror() {
      var scheme = current();
      if (html.getAttribute('data-vh-scheme') === scheme) return;
      html.setAttribute('data-vh-scheme', scheme);
      VH.emit('scheme', { scheme: scheme });
    }
    VH.scheme = {
      get: current,
      set: function (scheme) {
        // The viewer's click handler owns storage, label and icon; press it only on change.
        if ((scheme === 'dark' ? 'dark' : 'light') !== current()) toggle.click();
        mirror();
        return current();
      },
      toggle: function () { return VH.scheme.set(current() === 'dark' ? 'light' : 'dark'); }
    };
    html.setAttribute('data-docs-viewer-theme', '');
    new MutationObserver(mirror).observe(html, { attributes: true, attributeFilter: ['data-theme'] });
    mirror();
  }
})();
