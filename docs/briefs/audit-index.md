# Brief AUDIT-1 (Haiku): index the research notes and briefs

**Cap:** Haiku, at most 60 tool calls. You never dispatch other agents. No builds, tests, servers or browsers.
Work only in the worktree `/tmp/wt-audit` (branch `architecture-audit`). Do not commit; the lead commits.

**Read:** every `docs/research/*.md` and every `docs/briefs/*.md` in `/tmp/wt-audit` (only the first ~40 lines of
each is needed, plus a grep for D-rows). Use shell tools (`head`, `grep -o 'D-[0-9]\{3\}'`, `git log --diff-filter=A
--format=%ad --date=short -- <file> | tail -1` for the date the file was added).

**Write (only this file):** `/tmp/wt-audit/docs/architecture/doc-index.md`. Write it as you go: create the file with
the header and table heads first, then append rows in batches of about 20 files, so a run that stops still leaves
something behind.

Format:

```
# Index of research notes and briefs

Generated 8 Nov 2026 from `docs/research/` and `docs/briefs/` (first lines of each file and the D-rows it cites).
Dates are when the file was first committed.

## Research notes (`docs/research/`)

| File | Added | Kind | Topic (one line) | D-rows cited |
|---|---|---|---|---|
| [review-m3.md](../research/review-m3.md) | 2026-10-16 | cold review | ... | D-040, D-041 |

## Briefs (`docs/briefs/`)

| File | Added | Topic (one line) | Cap stated | D-rows cited |
|---|---|---|---|---|
```

Rules:
- Links are relative to `docs/architecture/`, so `../research/<file>` and `../briefs/<file>`.
- **Kind** for research is one of: `cold review` (files named `review-*`), `code review` (`code-review-*`, `sec-review*`),
  `worker report` (`*-report.md`, `*-worker-report.md`), `measurement` (capacity, perf, soak, timing, n1-*), `design`
  (design notes, plans, ideas), `playtest`, `other`.
- **Topic**: one plain line, under 15 words, taken from the file's title or first paragraph. Do not invent.
- **D-rows cited**: the distinct `D-nnn` ids that appear in the file, sorted, at most 8 (end with `...` if more);
  `-` if none.
- **Cap stated** (briefs only): the dollar cap and/or tool-call cap the brief states, e.g. `$40, 6 workers` or
  `120 tool calls`; grep for `\$[0-9]` and `tool call`. `-` if none.
- Only `.md` files. Skip `.json`, `.patch` and directories. Include `architecture-audit.md` and `audit-*.md` briefs.
- When done, reply with: the number of rows in each table and any files you couldn't read.
