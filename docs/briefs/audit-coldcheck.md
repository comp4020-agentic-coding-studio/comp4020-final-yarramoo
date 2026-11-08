# Brief AUDIT-2 (Sonnet): cold-check ARCHITECTURE.md against the code

**Cap:** Sonnet, at most 90 tool calls (about $8). You never dispatch other agents. **Read-only**: no builds, test
runs, servers or browsers (a test gate is running on this machine). Do not edit any file except the one you write.
Never run `rm`. Do not commit; the lead commits.

**Where:** the worktree `/tmp/wt-audit` (branch `architecture-audit`, from `multa` `4e5fee2`). All paths below are
relative to it.

**The task.** `ARCHITECTURE.md` is a guide a marker reads first. Every factual claim in it must be true of the code
at this commit. Check its claims against the **code** (and `git log`/`git show` for commits and counts). Where a claim
cites a D-row or engineering entry, check that the row or entry says it, and where possible that the code still does
(later D-rows supersede earlier ones). Priority order: sections 2 and 3 (architecture, invariants: check every
`path:line` and every named function or constant), then section 5 (harness: check each commit hash says what the guide
says it introduced, each number such as commit counts, brief counts, review counts, `FUTURE.md` entries, and each
spend figure against the cited report), then sections 4 and 6.

Useful reads: `sim/src/lib.rs`, `sim/src/sim.rs`, `sim/clippy.toml`, `sim/src/rng.rs`, `sim/src/snapshot.rs`,
`server/world.ts`, `server/main.ts`, `server/clock.ts`, `server/verify*.ts`, `server/rooms.ts`, `client/lockstep.ts`,
`client/worker.ts`, `shared/*.ts`, `tests/determinism/*.test.ts`, `scripts/gate-plan.ts`, `scripts/check-evidence.ts`,
`.claude/skills/*/SKILL.md`, `CLAUDE.md`, `docs/DECISIONS.md` (grep the row), `docs/engineering-decisions.md`.

**Write (only this file), as you go:** `docs/research/architecture-coldcheck.md`. Create it first with a header, then
append each finding the moment you have it, so a run that stops still leaves something. Format:

```
# Cold check of ARCHITECTURE.md (AUDIT-2)

## Findings
| # | Section | Claim (quote, short) | Verdict | What the code/doc actually says (path:line) |
|---|---|---|---|---|
```

Verdict is one of: **wrong** (the code says otherwise), **unverifiable** (nothing in the repo shows it), **imprecise**
(true in spirit, but a number, line or name is off), **stale** (true earlier, superseded). Only list problems; do not
list claims that checked out. At the end add `## Coverage`: which sections you checked fully, partly or not at all, and
roughly how many claims you checked.

Be concrete and quote the code. Do not suggest rewrites of style or structure; only factual problems.

**Architectural decisions for review:** none expected; if you think the guide misdescribes a design choice (not just a
fact), say so in a short final section.

When done, reply with the number of findings by verdict and the path of your file.
