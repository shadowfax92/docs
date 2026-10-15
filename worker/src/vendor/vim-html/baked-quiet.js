/* A hosting-only startup default for the recognized, synchronous baked runtime.
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
      typeof gutter.toggleNumbers !== 'function') return;
  VH.init(function () {
    // A page may replace its runtime during parsing. Only initialize the exact
    // instance inspected above, and apply the default once without preference writes.
    if (window.__VH === VH && VH.gutter === gutter && gutter.numbers()) gutter.toggleNumbers();
  });
})();
