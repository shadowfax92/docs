# Vendored vim-html

This is an offline snapshot of the installed `vim-html` skill taken 2026-10-14.
`provenance.json` records the absolute source and SHA-256 of each verbatim file
under `upstream/`. Only its runtime modules and theme-none assembler are copied;
no fonts, themes or `doc.css` are shipped. Do not modify the installed skill.

Regenerate the checked-in TypeScript strings with:

    python3 worker/src/vendor/vim-html/generate.py

The normal Worker bundler imports `generated.ts`; no manifest/build-script changes
or network access are needed. `generate.py` applies three small hosting changes:

- Keyboard dispatch honors `defaultPrevented`, native clickable controls (including
  Space/Enter on the hosting buttons), authored modals, ARIA text widgets, and an
  adapter-owned `VH.disabled` flag. All motions/search/selection/comments/export,
  modes, storage, folding and help are the authentic skill implementation.
- The gutter margin and status `body::after` rules are omitted to retain authored
  layout and pseudo-content. Gutters may clip on pages without left whitespace.
- `host.js`/`host.css` add small help/off buttons inside the existing UI layer.
  The hosting init synchronously turns numbers off through `VH.gutter` before
  first paint, retaining line identity, comment/mark signs and `Space u l`.
  This is a page-load default, with no change to global skill preferences.
  Off clears pending key sequences and remembers `docs-vim=off` on this public
  origin (session-only if storage fails), leaving stored comments intact. A global guard
  prevents this bundle from booting over an already-live `window.__VH`.

Upstream's `make_script_safe` and `make_style_safe` protect HTML end tags and make
injected content ASCII. The hosting module separately escapes config JSON.
The generator also records the verbatim upstream script's SHA-256 (normalized
HTML line endings/outer whitespace) and embeds adapter-owned `baked-quiet.js`.
The fingerprint recognizes common skill-built uploads without shipping another
copy of the original runtime or relying on a guessed interface version.

`enhanceHtml(Response, DocumentIdentity)` owns bounded inspection and injection:
UTF-8 HTML up to 4 MiB gets a suffix after the untouched original bytes, including
fragments and omitted head/body tags. A standard baked body block with exactly
one synchronous inline config/runtime and the recognized script fingerprint gets
only one `data-docs-vim-quiet` startup script. Its original bytes remain an exact
prefix: no runtime/config/theme/dock is replaced or added, and source/storage/
comment identity stays authored. This hook intentionally overrides initial
numbers-on, then leaves later authored/ready handlers and manual toggles alone.
Its marker makes repeated enhancement byte-idempotent. Config-only, unknown,
modified, asynchronous/module or incompatible runtimes remain unchanged; the
hook also guards the actual live instance and startup timing before using it.
Restrictive/non-ASCII header CSP, any meta CSP, no-transform, non-UTF-8, compressed, partial, attachment, malformed
unclosed raw-text/inert contexts, and larger pages are served unchanged. No CSP
is relaxed. Generated previews' existing inline-permissive header CSP is retained
and recognized, including directive fallbacks, nonce/hash restrictions and the
intersection of multiple policies. Large bodies replay the inspected prefix then continue under demand;
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

For an automated headless proof of quiet defaults and the real generated preview
path, run from the Worker directory:

    node src/vendor/vim-html/quiet-browser-proof.mjs <output-dir>

It owns its loopback server and isolated Chromium, closes both, and writes JSON
and screenshots. It checks initial render samples, both number toggle states,
navigation/search/selection/comments/export/help, gutter signs, native styles/forms
and unchanged baked source/config/theme/comment identity. Baked, twice-enhanced
and CRLF fixtures prove one hook, before-paint initialization, comment reload/
export and manual toggling. Later authored changes still work; unsupported/CSP/
inert source stays byte-identical. Stored source and raw/download bytes are never
changed. Already cached immutable copies need a fresh URL/cache refresh to receive
the hook; restrictive CSP is left intact rather than weakened.
