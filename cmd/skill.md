---
name: docs
description: Share files as short public links with the docs CLI. Use to publish a file or folder, or to revise a document already shared by link.
---

# Docs

1. **Publish** a new link with `docs upload ./report.html`. For a directory, run
   `docs upload --folder ./guides`; it is shared as one ZIP. Share the URL on
   stdout.
2. **Revise** a shared link in place; its URL and title stay the same:
   - `docs upload --overwrite ./report.html` when this machine published that
     same source path. Add `--folder` for a directory.
   - `docs update <id-or-url> ./report.html` when you know the link, or when
     `--overwrite` finds no recorded upload or several.
3. Done when the command exits 0 and, for a revision, stdout is the original
   URL. If a revision reports an unknown outcome, check that URL to see which
   version is live before retrying.
