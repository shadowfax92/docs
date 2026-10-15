# Keymap search (`Space s k`)

A docs-owned hosting module, after the owner's LazyVim `<leader>sk` keymap
picker. In normal mode, `Space s k` opens a compact picker listing the page's
live keymaps from `VH.keys.list()`, read on every open. That includes the skill's
maps, docs' `dC`, and anything registered later. Each row shows the key as
`Space ?` and which-key print it (leader = `Space`, `Ctrl-d`, `Enter`), the
description, and its modes (`n i v V c`, or `sidebar` / `help` for the runtime's
own contexts) and group.

It only lists keys. Nothing selected here runs: `Enter` shows a toast naming
the key to press after `Esc`.

## Keys

| Key | Action |
| --- | --- |
| typing | filters; `j` `k` `q` `:` `Space` `dC` are query text |
| `↓` `Ctrl-n` `Ctrl-j` `Tab` | next row |
| `↑` `Ctrl-p` `Ctrl-k` `Shift-Tab` | previous row |
| `PageDown` / `PageUp` | a page of rows |
| `Ctrl-u` | clear the query up to the caret |
| `Enter` | toast: listing only, and which key to press |
| `Esc`, `Ctrl-c`, `×`, backdrop | close and return focus |

## Search

The search is inert: it compares strings with `indexOf` and never compiles
the query as a pattern. It reads at most 64 characters and 8 words, and is
case-insensitive.

- The whole query is tried as a key: `dC`, `<leader>s`, `Space s`, `ctrl-d`, or
  `sk` without the leader. An exact-case key ranks first (`dC` before `dc`),
  and the other case still shows.
- Otherwise every word must match a key, a description (word starts rank
  first), a group or a mode name (`visual`, `sidebar`).
- A word of three or more letters may match a description fuzzily, but only
  when nothing matches literally: `cmnts` finds comments, while `delete` keeps
  to the literal deletes.
- Ties keep registration order, like fzf-lua's keymaps (`tiebreak=index`).
  Matched description letters are underlined. The count reads `shown/total`, and
  an empty result says so and suggests what to try.

## Hosting

`generate.py` appends `keymap-search.js` to both served layers:

- **Enhanced and generated pages:** the module sits inside the runtime bundle's
  `if (!window.__VH)` guard, after `host.js`.
- **Recognized baked pages:** the module follows `baked-hook.js`. It repeats
  that hook's gate: a v1 instance, still parsing and not yet booted, with the
  interface it uses. At boot it checks that the live `window.__VH` is that same
  instance.

It adds one keymap and one `mode` listener. Its DOM and its one style element
live inside `VH.ui.layer`. It brings no second core, config, store, dispatcher
or page listener. An authored `Space s k` keeps the key.

While open, the picker holds the runtime's `command` mode, as search.js's own
pickers do:

- Core types printable keys into the focused query.
- Mapped special keys pass through search.js's empty owner to this picker.
- Core's Esc fallback returns to normal, and the picker closes.

Leaving `command` any other way also closes it: Vim off, or a click into a page
field. In that case focus stays where the reader put it. Typing stops at the
picker, so authored bubble-phase key handlers never see the query. Descriptions,
groups and the query render only as text.

Styles sit under `#vh-ui` and use runtime tokens only. They follow light and dark
schemes and a baked page's own theme. A reset line keeps authored element rules
(`span`, `input`, `mark`, `div`) out of the picker. At 560 px and narrower, each
row stacks: key and modes on one line, description below.

## Limits

- Listing only: no execution, by design for this slice.
- Pages that keep the original bytes keep the original behavior: CSP, unknown or
  async runtimes, copies cached before deployment, and saved copies that already
  carry the hook. On the enhanced runtime, Vim off disables the key; baked pages
  have no off control.
- In an enhanced page, a focused native control or an authored modal keeps
  `Space s k`, as it keeps every vim key.

## Proof

From `worker`:

    node src/vendor/vim-html/keymap-search-browser-proof.mjs <output-dir>

The proof drives authored, generated, baked and twice-enhanced fixtures through
Preview, `enhanceHtml` and the runtime with trusted keyboard events. It writes
JSON and screenshots. `keymap-search.test.ts` covers registration, guards,
ranking, inertness and the open/close lifecycle through a small `VH.ui` stand-in.
