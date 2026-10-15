#!/usr/bin/env python3
"""build.py -- turn a content HTML file into a self-contained vim-html document.

An agent writes plain semantic HTML (a full document or just a fragment) and runs
this script on it. The theme, the document CSS and the vim runtime are inlined
into that one file, so the result opens from file://, any static server or the
docs CLI with zero network requests at view time. stdlib only.

    build.py DOC.html [-o OUT] [--theme NAME|none] [--dark mocha|gruvbox]
                      [--fonts embed|system] [--key ID] [--title T]
    build.py --remove DOC.html [-o OUT]
    build.py --list-themes

Marker scheme (what makes rebuilding idempotent)
------------------------------------------------
Everything injected sits between two pairs of HTML comments:

    <!-- vim-html:head:begin --> styles + pre-paint script <!-- vim-html:head:end -->
        inserted immediately before </head>
    <!-- vim-html:body:begin --> config + runtime IIFE <!-- vim-html:body:end -->
        inserted immediately before the LAST </body>

plus one attribute, data-vh-scheme="light", placed first on <html> so the first
paint is light. A build strips any earlier blocks and the attribute, then inserts
fresh ones: re-running after each content edit replaces instead of stacking, and
two builds of the same input are byte-identical. --remove strips them and leaves
the author's bytes exactly as they were. Comments survive rebuilds because the
runtime anchors them to quoted text, not to anything build.py emits.

A fragment (no <html> tag) is wrapped into a full document on its first build:
doctype, charset, viewport, <title> (--title, else the first h1, else the file
name) and <main class="vh-doc">. From then on that wrapper is content; --remove
keeps it.

Inline order
------------
head block: theme tokens (themes.py, or NEUTRAL_* below for --theme none), font
@font-face rules, runtime/doc.css (skipped for none: that mode bolts the layer
onto an already-designed page), then every module's runtime/<name>.css in
MODULES order, then a tiny script that applies a remembered dark scheme before
the body paints.

body block: window.VIM_HTML (the baked config the runtime reads as VH.cfg; its
`source` is DOC's absolute path, which keys the page's comments and names the
file in exports however the page is opened or uploaded), then
ONE IIFE holding runtime/<name>.js for each name in MODULES, ending in VH.boot().
MODULES is an explicit list, not a glob, because order is the dependency order:
core defines the VH namespace, lines the gutter that motions moves a cursor over,
and so on. Each module is additionally wrapped in its own function scope and
try/catch, so a module's top-level `var`s are private (the only shared surface
is VH) and one broken module cannot stop the others from loading.

Inlined text is made inert for the HTML parser (no `</script`, `</style` or `<!--`
can end or confuse its element) and ASCII-only, so a document without a charset
declaration still decodes the runtime's own strings correctly.
"""

import argparse
import html
import json
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
SKILL = HERE.parent
RUNTIME = SKILL / "runtime"
THEMES_PY = HERE / "themes.py"

# Dependency order; see the module docstring. A missing file is skipped so wave-2
# modules can land independently.
MODULES = ("core", "lines", "motions", "search", "select", "comments", "panel", "chrome")

HEAD_BEGIN = "<!-- vim-html:head:begin -->"
HEAD_END = "<!-- vim-html:head:end -->"
BODY_BEGIN = "<!-- vim-html:body:begin -->"
BODY_END = "<!-- vim-html:body:end -->"
BLOCK_RES = tuple(
    re.compile(re.escape(begin) + r".*?" + re.escape(end) + r"\n?", re.S)
    for begin, end in ((HEAD_BEGIN, HEAD_END), (BODY_BEGIN, BODY_END))
)
SCHEME_ATTR_RE = re.compile(r'\s+data-vh-scheme="[^"]*"', re.I)

# Global (not per document) prefs bucket; must match VH.prefs in runtime/core.js.
PREFS_KEY = "vim-html:prefs"

# Runs in <head>, before the body paints: a reader who chose dark gets dark from
# the first frame instead of a light flash. core.js applies the same rule at boot.
PREPAINT_JS = (
    "(function(){try{var p=JSON.parse(localStorage.getItem(%s)||'{}');"
    "if(p&&p.scheme==='dark')document.documentElement.setAttribute('data-vh-scheme','dark');"
    "}catch(e){}})();" % json.dumps(PREFS_KEY)
)

# Every design token the runtime and doc.css may use (PLAN.md "Design tokens").
# themes.py must define all of them for light and dark; so does the neutral set.
# Kept here rather than imported so --theme none never needs themes.py;
# tests/test_build.py checks it matches themes.TOKENS.
TOKENS = tuple("--vh-" + t for t in (
    "bg", "surface", "sunk", "line", "edge",
    "ink", "muted", "faint",
    "accent", "on-accent", "accent-soft", "accent-ink",
    "ok", "warn", "bad", "ok-soft", "warn-soft", "bad-soft",
    "cursorline", "visual", "search", "search-cur",
    "comment", "comment-mark", "gutter-fg", "gutter-cur",
    "font-display", "font-body", "font-mono",
    "radius", "shadow",
    "display-weight", "display-tracking", "display-transform",
    "measure", "gutter-w",
    "on-search", "search-outline", "mark", "fold", "fold-bg",
))

_SANS = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif'
_MONO = 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace'

# --theme none: neutral values for pages that bring their own design. Only --vh-*
# custom properties, so the host page's look is untouched; they colour the
# runtime's UI (gutter, cursor, status line, highlights) and nothing else.
NEUTRAL_LIGHT = {
    "bg": "#ffffff", "surface": "#f7f7f8", "sunk": "#f1f1f3", "line": "#e4e4e7", "edge": "#d4d4d8",
    "ink": "#18181b", "muted": "#52525b", "faint": "#a1a1aa",
    "accent": "#2563eb", "on-accent": "#ffffff", "accent-soft": "#dbeafe", "accent-ink": "#1d4ed8",
    "ok": "#15803d", "warn": "#b45309", "bad": "#b91c1c",
    "ok-soft": "#dcfce7", "warn-soft": "#fef3c7", "bad-soft": "#fee2e2",
    "cursorline": "rgba(37, 99, 235, 0.07)", "visual": "rgba(37, 99, 235, 0.22)",
    # The owner's nvim Search in both schemes: every match bright red with white
    # text; the current match a darker red with a yellow ring.
    "search": "#ff3333", "on-search": "#ffffff", "search-cur": "#b00000", "search-outline": "#ffd400",
    "mark": "#b45309", "fold": "#52525b", "fold-bg": "#f1f1f3",
    "comment": "rgba(245, 158, 11, 0.22)", "comment-mark": "#f59e0b",
    "gutter-fg": "#a1a1aa", "gutter-cur": "#18181b",
    "font-display": _SANS, "font-body": _SANS, "font-mono": _MONO,
    "radius": "6px", "shadow": "0 6px 24px rgba(24, 24, 27, 0.14)",
    "display-weight": "650", "display-tracking": "-0.01em", "display-transform": "none",
    "measure": "72ch", "gutter-w": "3.5rem",
}
# Colour tokens only; fonts, shape and layout carry over from :root.
NEUTRAL_DARK = {
    "mocha": {  # Catppuccin Mocha
        "bg": "#1e1e2e", "surface": "#313244", "sunk": "#181825", "line": "#313244", "edge": "#45475a",
        "ink": "#cdd6f4", "muted": "#a6adc8", "faint": "#6c7086",
        "accent": "#89b4fa", "on-accent": "#1e1e2e", "accent-soft": "rgba(137, 180, 250, 0.16)",
        "accent-ink": "#89b4fa",
        "ok": "#a6e3a1", "warn": "#f9e2af", "bad": "#f38ba8",
        "ok-soft": "rgba(166, 227, 161, 0.14)", "warn-soft": "rgba(249, 226, 175, 0.14)",
        "bad-soft": "rgba(243, 139, 168, 0.14)",
        "cursorline": "rgba(205, 214, 244, 0.06)", "visual": "rgba(137, 180, 250, 0.28)",
        "search": "#ff3333", "on-search": "#ffffff", "search-cur": "#b00000", "search-outline": "#ffd400",
        "mark": "#f9e2af", "fold": "#a6adc8", "fold-bg": "#181825",
        "comment": "rgba(249, 226, 175, 0.18)", "comment-mark": "#f9e2af",
        "gutter-fg": "#6c7086", "gutter-cur": "#b4befe",
        "shadow": "0 6px 24px rgba(0, 0, 0, 0.4)",
    },
    "gruvbox": {  # Gruvbox Dark
        "bg": "#282828", "surface": "#32302f", "sunk": "#1d2021", "line": "#3c3836", "edge": "#504945",
        "ink": "#ebdbb2", "muted": "#bdae93", "faint": "#7c6f64",
        "accent": "#83a598", "on-accent": "#282828", "accent-soft": "rgba(131, 165, 152, 0.18)",
        "accent-ink": "#83a598",
        "ok": "#b8bb26", "warn": "#fabd2f", "bad": "#fb4934",
        "ok-soft": "rgba(184, 187, 38, 0.14)", "warn-soft": "rgba(250, 189, 47, 0.14)",
        "bad-soft": "rgba(251, 73, 52, 0.14)",
        "cursorline": "rgba(235, 219, 178, 0.05)", "visual": "rgba(131, 165, 152, 0.3)",
        "search": "#ff3333", "on-search": "#ffffff", "search-cur": "#b00000", "search-outline": "#ffd400",
        "mark": "#fabd2f", "fold": "#bdae93", "fold-bg": "#1d2021",
        "comment": "rgba(250, 189, 47, 0.16)", "comment-mark": "#fabd2f",
        "gutter-fg": "#7c6f64", "gutter-cur": "#fabd2f",
        "shadow": "0 6px 24px rgba(0, 0, 0, 0.45)",
    },
}
DARK_CHOICES = tuple(NEUTRAL_DARK)


class BuildError(Exception):
    """A user-facing failure: printed as one line, exit status 1."""


# ---------------------------------------------------------------- themes


def load_themes():
    """Import scripts/themes.py, or return None when it is not installed.

    Only a missing file means "no themes"; an error inside themes.py propagates,
    so a broken theme module is never mistaken for an absent one.
    """
    if not THEMES_PY.exists():
        return None
    if str(HERE) not in sys.path:
        sys.path.insert(0, str(HERE))
    import themes  # noqa: E402 -- deliberately lazy: --theme none never needs it
    return themes


def neutral_css(dark="mocha"):
    def block(selector, values):
        body = "".join("  --vh-%s: %s;\n" % (k, v) for k, v in values.items())
        return "%s {\n%s}\n" % (selector, body)
    return (block(":root", NEUTRAL_LIGHT)
            + block(':root[data-vh-scheme="dark"]', NEUTRAL_DARK[dark]))


def resolve_theme(name, dark, fonts):
    """Return (theme_name, theme_css, fonts_css, include_doc_css)."""
    themes = None
    if name is None:
        themes = load_themes()
        if themes is None:
            print("build.py: themes.py missing; using --theme none", file=sys.stderr)
            name = "none"
        else:
            name = themes.DEFAULT
    if name == "none":
        if dark is not None and dark not in NEUTRAL_DARK:
            raise BuildError("unknown --dark %r (choose from: %s)" % (dark, ", ".join(DARK_CHOICES)))
        return "none", neutral_css(dark or "mocha"), "", False
    themes = themes or load_themes()
    if themes is None:
        raise BuildError("themes.py missing; use --theme none")
    try:
        theme_css = themes.css(name, dark)
        font_css = themes.fonts_css(name, fonts)
    except KeyError as e:
        raise BuildError(e.args[0] if e.args else "unknown theme %r" % name)
    return name, theme_css, font_css, True


# ---------------------------------------------------------------- runtime assembly


def make_script_safe(js):
    """Keep inlined JS from ending its <script> early or entering the parser's
    escaped states, and make it ASCII so a charset-less page still decodes it.
    \\x3C and \\uXXXX are valid in strings, regexes and templates; in comments
    they are inert."""
    js = re.sub(r"<(?=/script|!--)", r"\\x3C", js, flags=re.I)
    return re.sub(r"[^\x00-\x7f]", _js_escape, js)


def _js_escape(m):
    data = m.group(0).encode("utf-16-be")
    return "".join("\\u%02x%02x" % (data[i], data[i + 1]) for i in range(0, len(data), 2))


def make_style_safe(css):
    css = re.sub(r"<(?=/style)", r"\\3C ", css, flags=re.I)
    # Six-digit CSS escapes never absorb a following hex digit.
    return re.sub(r"[^\x00-\x7f]", lambda m: "\\%06x" % ord(m.group(0)), css)


def read_runtime(ext):
    """[(module, source)] for each runtime/<module>.<ext> that exists, in MODULES order."""
    out = []
    for name in MODULES:
        path = RUNTIME / ("%s.%s" % (name, ext))
        if path.exists():
            out.append((name, path.read_text(encoding="utf-8")))
    return out


def runtime_js():
    modules = read_runtime("js")
    if not modules or modules[0][0] != "core":
        raise BuildError("runtime/core.js missing (looked in %s)" % RUNTIME)
    parts = [
        "(function () { 'use strict';",
        "var VH = window.__VH = {};  // exposed for tests and debugging",
    ]
    for name, src in modules:
        parts.append(
            "/* ---- runtime/%s.js ---- */\n"
            "try { (function () {\n%s\n})(); } catch (e) {\n"
            "  console.error('[vim-html] runtime/%s.js failed to load', e);\n}"
            % (name, src.rstrip(), name)
        )
    parts.append("if (VH.boot) VH.boot();\n})();")
    return make_script_safe("\n".join(parts))


def runtime_css():
    return "\n".join("/* ---- runtime/%s.css ---- */\n%s" % (n, s.rstrip()) for n, s in read_runtime("css"))


# ---------------------------------------------------------------- document surgery


def find_tag(text, pattern, last=False):
    """First (or last) match of `pattern` that is not inside an HTML comment."""
    found = None
    for m in re.finditer(r"<!--.*?-->|(" + pattern + ")", text, re.S | re.I):
        if m.group(1) is None:
            continue
        if not last:
            return m
        found = m
    return found


def strip_blocks(text):
    """Remove injected blocks and the scheme attribute; return (text, had_any)."""
    had = False
    for rx in BLOCK_RES:
        text, n = rx.subn("", text)
        had = had or bool(n)
    m = find_tag(text, r"<html\b[^>]*>")
    if m:
        tag = m.group(1)
        clean = SCHEME_ATTR_RE.sub("", tag)
        if clean != tag:
            had = True
            text = text[:m.start(1)] + clean + text[m.end(1):]
    return text, had


# A .tag badge inside a heading (doc.css's status pill) is not part of its name;
# lines.js skips it the same way for crumbs and the outline.
TAG_BADGE_RE = re.compile(
    r"<(\w+)\b[^>]*\bclass\s*=\s*[\"']?[^\"'>]*(?<![\w-])tag(?![\w-])[^>]*>.*?</\1\s*>", re.I | re.S)


def first_h1(text):
    m = find_tag(text, r"<h1\b[^>]*>.*?</h1\s*>")
    if not m:
        return ""
    inner = re.sub(r"^<h1\b[^>]*>|</h1\s*>$", "", m.group(1), flags=re.I)
    name = " ".join(html.unescape(re.sub(r"<[^>]+>", "", TAG_BADGE_RE.sub("", inner))).split())
    return name or " ".join(html.unescape(re.sub(r"<[^>]+>", "", inner)).split())


def wrap_fragment(text, title):
    body = text.strip("\n")
    if find_tag(body, r"<main\b") is None:
        body = '<main class="vh-doc">\n%s\n</main>' % body
    return (
        "<!doctype html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n"
        "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n"
        "<title>%s</title>\n</head>\n<body>\n%s\n</body>\n</html>\n" % (html.escape(title), body)
    )


def set_scheme_attr(text):
    m = find_tag(text, r"<html\b[^>]*>")
    assert m, "set_scheme_attr needs a full document"
    tag = SCHEME_ATTR_RE.sub("", m.group(1))
    tag = tag[:5] + ' data-vh-scheme="light"' + tag[5:]
    return text[:m.start(1)] + tag + text[m.end(1):]


def insert_blocks(text, head, body):
    """Insert `head` before </head> and `body` before the last </body>.

    Each block goes in as block + "\\n", exactly what BLOCK_RES strips, which is
    what keeps --remove byte-exact. Documents that omit the optional tags still
    get both blocks: head before <body> (or after <html>), body before </html>
    (or at the end).
    """
    m = find_tag(text, r"</head\s*>")
    if m:
        at = m.start(1)
    else:
        m = find_tag(text, r"<body\b[^>]*>")
        at = m.start(1) if m else find_tag(text, r"<html\b[^>]*>").end(1)
    text = text[:at] + head + "\n" + text[at:]

    m = find_tag(text, r"</body\s*>", last=True) or find_tag(text, r"</html\s*>", last=True)
    at = m.start(1) if m else len(text)
    return text[:at] + body + "\n" + text[at:]


def head_block(title_tag, theme_css, fonts_css, doc_css, modules_css):
    parts = [HEAD_BEGIN]
    if title_tag:
        parts.append(title_tag)
    parts.append('<style data-vh="theme">\n%s\n</style>' % make_style_safe(theme_css.strip()))
    if fonts_css.strip():
        parts.append('<style data-vh="fonts">\n%s\n</style>' % make_style_safe(fonts_css.strip()))
    if doc_css.strip():
        parts.append('<style data-vh="doc">\n%s\n</style>' % make_style_safe(doc_css.strip()))
    if modules_css.strip():
        parts.append('<style data-vh="runtime">\n%s\n</style>' % make_style_safe(modules_css))
    parts.append('<script data-vh="prepaint">%s</script>' % PREPAINT_JS)
    parts.append(HEAD_END)
    return "\n".join(parts)


def body_block(config):
    # Values a page sets on window.VIM_HTML before this script win over the baked ones.
    cfg = json.dumps(config, ensure_ascii=True, sort_keys=True).replace("<", "\\u003c")
    return "\n".join([
        BODY_BEGIN,
        '<script data-vh="config">window.VIM_HTML = Object.assign(%s, window.VIM_HTML || {});</script>' % cfg,
        '<script data-vh="runtime">\n%s\n</script>' % runtime_js(),
        BODY_END,
    ])


def build(text, *, name_hint="Untitled", theme=None, dark=None, fonts="embed", key=None, title=None,
          source=None):
    """Return `text` with the vim-html layer (re)injected; pure apart from themes.py.

    `source` is the absolute path of the file the agent edits. Every upload of a
    page shares the docs origin and gets a fresh URL, so the runtime keys
    comments by this path (unless `key` is given) and exports it as the `@`
    location whenever the page is viewed from anywhere but that file.
    """
    text, _ = strip_blocks(text)
    if find_tag(text, r"<html\b[^>]*>") is None:
        text = wrap_fragment(text, title or first_h1(text) or name_hint)
    text = set_scheme_attr(text)

    theme_name, theme_css, fonts_css, with_doc = resolve_theme(theme, dark, fonts)
    doc_path = RUNTIME / "doc.css"
    doc_css = ""
    if with_doc:
        if doc_path.exists():
            doc_css = doc_path.read_text(encoding="utf-8")
        else:
            print("build.py: runtime/doc.css missing; document styles skipped", file=sys.stderr)

    title_tag = ""
    if find_tag(text, r"<title\b") is None and (title or first_h1(text)):
        title_tag = "<title>%s</title>" % html.escape(title or first_h1(text))

    config = {
        "source": source,
        "storageKey": key,
        "docTitle": title,
        "scheme": "light",
        "theme": theme_name,
        "debug": False,
    }
    head = head_block(title_tag, theme_css, fonts_css, doc_css, runtime_css())
    return insert_blocks(text, head, body_block(config)), theme_name


# ---------------------------------------------------------------- CLI


def read_doc(path):
    # Bytes in, bytes out: keeps CRLF and any BOM exactly as the author wrote them.
    try:
        return Path(path).read_bytes().decode("utf-8")
    except OSError as e:
        raise BuildError("cannot read %s (%s)" % (path, e.strerror or e))
    except UnicodeDecodeError:
        raise BuildError("%s is not UTF-8" % path)


def write_doc(path, text):
    Path(path).write_bytes(text.encode("utf-8"))


def list_themes():
    themes = load_themes()
    if themes is None:
        print("  none       neutral tokens, no doc.css   (themes.py missing)")
        return
    for d in themes.describe():
        mark = "*" if d["name"] == themes.DEFAULT else " "
        print("%s %-10s %s -- %s  [dark: %s]" % (mark, d["name"], d["label"], d["tagline"], d["dark"]))
    print("  %-10s neutral tokens, no doc.css (for already-designed pages)" % "none")


def main(argv=None):
    ap = argparse.ArgumentParser(
        prog="build.py",
        description="Inline the vim-html theme and runtime into an HTML file (in place by default).")
    ap.add_argument("doc", nargs="?", help="HTML document or fragment")
    ap.add_argument("-o", "--output", help="write here instead of rewriting DOC")
    ap.add_argument("--theme", help="theme name or 'none' (default: themes.DEFAULT)")
    ap.add_argument("--dark", help="dark palette: mocha | gruvbox (default: the theme's pick)")
    ap.add_argument("--fonts", choices=("embed", "system"), default="embed",
                    help="embed fonts as data URIs (default) or use system stacks")
    ap.add_argument("--key", help="storage key for comments (default: DOC's absolute path, so every "
                                  "copy and upload of one source shares its comments)")
    ap.add_argument("--title", help="document title (default: <title>, else the first h1)")
    ap.add_argument("--remove", action="store_true", help="strip the vim-html layer instead")
    ap.add_argument("--list-themes", action="store_true", help="list themes and exit")
    args = ap.parse_args(argv)

    try:
        if args.list_themes:
            list_themes()
            return 0
        if not args.doc:
            ap.error("DOC is required")
        text = read_doc(args.doc)
        out = args.output or args.doc
        if args.remove:
            text, had = strip_blocks(text)
            write_doc(out, text)
            print("%s %s" % ("removed" if had else "nothing to remove in", out))
            return 0
        result, theme_name = build(
            text, name_hint=Path(args.doc).stem, theme=args.theme, dark=args.dark,
            fonts=args.fonts, key=args.key, title=args.title,
            # The canonical path: one storage key however the agent spelled it
            # (a relative path, a symlinked directory).
            source=str(Path(args.doc).resolve()))
        write_doc(out, result)
        print("built %s (theme: %s)" % (out, theme_name))
        return 0
    except BuildError as e:
        print("build.py: %s" % e, file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
