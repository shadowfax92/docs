# Share and revise documents with Docs

1. Create a link with `docs upload ./report.html`. For a directory, run
   `docs upload --folder ./guides` to publish a ZIP. Share the URL printed on
   stdout after the command succeeds.
2. Revise a link with `docs upload --overwrite ./report.html` when local history
   maps that absolute source path to one URL on the configured Worker. For a
   directory, include `--folder`. If history has no match or several URLs, or if
   the source moved, use the intended link explicitly:
   `docs update <id-or-url> ./report.html`. Run `docs update <id-or-url>` to reuse
   the source recorded for that link. Revisions preserve the title by default.
3. Confirm the update succeeded, compare stdout to the original URL, then reload
   the link and check that it serves the revised content. If the update fails,
   resolve the error before reporting the revision as published.

Run `docs upload --help` or `docs update --help` for options.
