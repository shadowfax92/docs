#!/usr/bin/env python3
"""Assemble the checked-in skill snapshot offline; never read the installed skill.

Generated strings use upstream's theme-none assembler and HTML end-tag escaping.
The narrow hosting adaptations below are intentionally kept out of upstream/ so
its provenance hashes continue to identify the authentic sources verbatim.
"""
import importlib.util
import json
import sys
sys.dont_write_bytecode = True
from pathlib import Path

ROOT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("vim_html_build", ROOT / "upstream/scripts/build.py")
build = importlib.util.module_from_spec(spec)
spec.loader.exec_module(build)

js = build.runtime_js()
needle = "function onKeydown(e) {"
assert js.count(needle) == 1
js = js.replace(needle, needle + """
  // Hosted pages own native controls and may explicitly suspend the vim layer.
  // Honor an earlier capture listener that already claimed a keyboard event.
  if (VH.disabled || e.defaultPrevented) return;
  var control = targetOf(e);
  if (!isOurs(control) && control && control.closest &&
      control.closest('button, a[href], input, select, summary, audio, video') &&
      !isEditable(control)) return;
""")
# A defensive guard also covers authors dynamically loading a runtime before us.
js = "if (!window.__VH) {\n" + js + "\n" + build.make_script_safe((ROOT / "host.js").read_text()) + "\n}"

css = build.neutral_css() + build.runtime_css()
# Theme-none's upstream gutter/status accommodations change body layout and can
# overwrite an authored body::after. Hosted docs retain those authored rules;
# the gutter occupies available whitespace and the status line stays an overlay.
for rule in (
    "html.vh-gutter-room body { margin-left: calc(var(--vh-gutter-w, 3.5rem) + 8px); }",
    'html.vh-status-room body::after { content: ""; display: block; height: 36px; }',
):
    assert css.count(rule) == 1
    css = css.replace(rule, "")
css = build.make_style_safe(css + (ROOT / "host.css").read_text())

(ROOT / "generated.ts").write_text(
    "// Generated offline by vendor/vim-html/generate.py; see README.md for provenance.\n"
    + "export const runtimeScript = " + json.dumps(js, ensure_ascii=True) + ";\n"
    + "export const runtimeStyle = " + json.dumps(css, ensure_ascii=True) + ";\n"
)
print(f"vim-html theme none: {len(js)} script bytes, {len(css)} style bytes")
