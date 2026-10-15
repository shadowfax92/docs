# Vendored vim-html

This is an offline snapshot of the installed `vim-html` skill taken 2026-10-14.
`provenance.json` records the absolute source and SHA-256 of each verbatim file
under `upstream/`. Only its runtime modules and theme-none assembler are copied;
no fonts, themes or `doc.css` are shipped. Do not modify the installed skill.

Regenerate the checked-in TypeScript strings with:

    python3 worker/src/vendor/vim-html/generate.py

The normal Worker bundler imports `generated.ts`; no manifest/build-script changes
or network access are needed. `generate.py` applies three small hosting changes:

- Keyboard dispatch honors `defaultPrevented`, native clickable controls, and an
  adapter-owned `VH.disabled` flag. All motions/search/selection/comments/export,
  modes, storage, folding and help are the authentic skill implementation.
- The gutter margin and status `body::after` rules are omitted to retain authored
  layout and pseudo-content. Gutters may clip on pages without left whitespace.
- `host.js`/`host.css` add small help/off buttons inside the existing UI layer.
  Off lasts for the page load and leaves stored comments intact. A global guard
  prevents this bundle from booting over an already-live `window.__VH`.

Upstream's `make_script_safe` and `make_style_safe` protect HTML end tags and make
injected content ASCII. The hosting module separately escapes config JSON.

`enhanceHtml(Response, DocumentIdentity)` owns bounded inspection and injection:
UTF-8 HTML up to 4 MiB gets a suffix after the untouched original bytes, including
fragments and omitted head/body tags. Baked markers/config/runtime anywhere in the
source are conservatively left untouched, retaining comment/source identity.
Header/meta CSP, no-transform, non-UTF-8, compressed, partial, attachment, malformed
unclosed raw-text/inert contexts, and larger pages are served unchanged. No CSP
is relaxed. Large bodies replay the inspected prefix then continue under demand;
cancellation reaches the input stream. Transport read errors remain errors.

The conservative scanner may decline content that merely mentions vim globals,
markers or CSP. Pages that replace the document after load or capture keys first
can prevent bindings; insert mode (`i`, `Esc`/`jk`/`jj`) and the off button let
normal authored scripts own keys. Immutable copies cached before deployment
cannot be retrofitted; deployment/cache policy belongs to the preview owner.

Browser proof uses only disposable local fixtures. From the Worker directory:

    node src/vendor/vim-html/browser-fixtures.mjs

Open the printed loopback URLs in BrowserOS Neo. `plain` is authored HTML,
`repeat` crosses enhanceHtml twice, `baked` is built with the verbatim upstream
assembler before enhancement, and `fragment` omits head/body/html. `raw` bypasses
enhancement. The harness imports the same production module through esbuild;
it serves no owner data, opens no browser and modifies no installed tools.
