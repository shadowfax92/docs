/* Hosting startup defaults for the recognized, synchronous baked runtime: line
 * numbers start off, and normal-mode dC runs that runtime's own :clear (see
 * host.js, which applies the same defaults to the runtime docs injects).
 * Do not load a second core or touch authored config/theme/comment storage.
 * The callback runs after line initialization in the same boot task; later
 * ready handlers, authored code and Space u l remain free to change the state.
 */
(function () {
  var VH = window.__VH;
  if (document.readyState !== 'loading' || !VH || VH.version !== 1 ||
      VH.booted !== false || typeof VH.init !== 'function') return;
  var gutter = VH.gutter;
  if (!gutter || typeof gutter.numbers !== 'function' ||
      typeof gutter.toggleNumbers !== 'function' || !VH.keys ||
      typeof VH.keys.map !== 'function' || !VH.commands ||
      typeof VH.commands.run !== 'function') return;
  VH.init(function () {
    // A page may replace its runtime during parsing. Only initialize the exact
    // instance inspected above, and apply the defaults once without preference writes.
    if (window.__VH !== VH || VH.gutter !== gutter) return;
    if (gutter.numbers()) gutter.toggleNumbers();
    // The clear itself, its undo step and the comments' authored storage key
    // all stay with the baked runtime; this only adds the key.
    VH.keys.map('normal', 'dC', function () { VH.commands.run('clear'); },
      { desc: 'delete all comments in this document (u undoes)', group: 'comments' });
  });
})();
