/* Hosting adapter: the skill still owns every motion, mode and comment. This
 * small dock exposes help and a true keyboard opt-out without changing document
 * identity or global preferences. Disabled state lasts only for this page load.
 */
(function () {
  var VH = window.__VH;
  VH.init(function () {
    var help = VH.ui.h('button', { type: 'button', text: 'Vim help', title: 'Vim keys: Space ?', onclick: function () {
      setEnabled(true);
      VH.commands.run('help');
    } });
    var toggle = VH.ui.h('button', { type: 'button', text: 'Vim off', 'aria-pressed': 'false', onclick: function () {
      setEnabled(!!VH.disabled);
    } });
    function setEnabled(enabled) {
      // Close transient modes before suspending dispatch; Esc cannot close an
      // editor after key handling has been disabled. Stored comments stay intact.
      VH.emit('escape', {});
      VH.mode.set('normal');
      VH.disabled = !enabled;
      document.documentElement.toggleAttribute('data-docs-vim-off', !enabled);
      toggle.textContent = enabled ? 'Vim off' : 'Vim on';
      toggle.setAttribute('aria-pressed', String(!enabled));
    }
    VH.ui.layer.appendChild(VH.ui.h('div', { 'class': 'docs-vim-controls', role: 'group', 'aria-label': 'Vim controls' }, [help, toggle]));
  });
})();
