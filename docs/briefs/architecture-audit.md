# Brief AUDIT: a top-level architecture and engineering-decisions guide for markers (Opus lead)

Written 8 Nov by the session model from the user's request: "an audit of the project, and its engineering decisions.
This will be a top-level resource that a marker can use to see the architecture of the project, and references to
design documentation built up to this point. Feel free to create images as part of this. You have $50 to do this, so
please be thorough, but concise. Make a section dedicated to the harness/skill level interventions - that demonstrate
AI harness skill. There should be artifacts and decisions that reflect these decisions."

## Budget and stopping (hard)
- **$50 total** for you and every worker. Read spend at the start (B0), after every worker and every ~20 of your own
  tool calls:
  `curl -sf https://strproxy.comp.anu.edu.au/api/me -H "Authorization: Bearer $ANTHROPIC_AUTH_TOKEN" | python3 -c "import json,sys;print(json.load(sys.stdin)['current_week_spend'])"`.
  Stop dispatching at B0 + $40; finish by B0 + $50.
- **At most 4 workers, one at a time**, each with a narrow brief in `docs/briefs/audit-*.md` (its cap, the files it reads,
  the file it writes, "write findings to a file as you go") and **never dispatching**. Good uses: Haiku to index all
  `docs/research/*.md` and `docs/briefs/*.md` into a table (file, date, one-line topic, D-rows it cites); Sonnet to
  verify a section's claims against the code, or to draw a diagram. You write the guide's prose and judge it.

## Where and what you may touch
`git worktree add /tmp/wt-audit -b architecture-audit multa`. You write **only new files**: the guide, its images, an
index if you make one, your briefs and report. **Do not edit product code, tests, `CLAUDE.md`, `PROCESS.md`,
`README.md`, `docs/DECISIONS.md` or `docs/engineering-decisions.md`** (the session model merges; the user owns
`README.md` and `PROCESS.md`). Never touch the main checkout or the user's :8080. **No builds, test runs, servers or
browsers**: other work is gating on this machine. Reading code, docs and `git log`/`git show` is fine.

## The deliverable: `ARCHITECTURE.md` at the repository root (plus `docs/architecture/` for images and any index)
A marker reads it first, so: **thorough but concise**: aim for something a marker can read in 15-20 minutes, with
links out to the detail rather than repeating it. Every claim is **true of the code at `multa` HEAD** and points at a
file (`path:line` where useful), a decision row (`D-123`), an engineering-decisions entry (`entry 41`), a research note
or a commit. **Verify** against the code; the docs are history and some are superseded (later D-rows supersede earlier
ones; engineering entries carry visible corrections: follow them).

Suggested structure (yours to improve):
1. **What Simulta is**, in one paragraph, and the one idea that shapes everything (deterministic lockstep: every client
   runs the identical `sim.wasm`, the server only relays and verifies).
2. **System architecture**: the parts (`sim/` Rust/WASM, `client/` browser + Web Worker + WebGL2, `server/` Node relay +
   SQLite, `shared/`), how a tick flows from an input to every screen, how state is checked (hash votes, snapshots,
   claims), what persists and what doesn't (owned sandbox vs ephemeral game rooms). **Diagrams**: at least a component
   diagram and a tick/data-flow sequence (Mermaid in the Markdown renders on GitHub; for richer images write SVG by hand
   and convert with `rsvg-convert -o x.png x.svg`, which is installed; Python PIL is available too. **The image-gen API
   is disabled for this course (403)**. `docs/lockstep-networking.png` exists: reuse or supersede it.
3. **The invariants** (`CLAUDE.md`'s 11 sim invariants) and **how each is enforced** (clippy denies, the no-imports CI
   check, the determinism suite's engines, sleep-invisibility tests, the hash-cache invariant test, red-first tests).
4. **Key engineering decisions**: a curated table (~15-25 rows) of the decisions that shaped the architecture or cost
   real time, each with a one-line why and links (D-row, entry, research note). Group them (simulation, networking and
   trust, persistence, generation and content, client and performance, capacity). Include the reversals and the bugs
   that taught something (the water-wall scan order, the floating mine, the sky line from live cells, the hash votes
   counting sockets, the supply alcove 2 rows too short): honesty about what went wrong is part of the record.
5. **Harness and skill-level interventions (a dedicated, substantial section)**: how the project was built with AI
   agents, and the controls that made that work. Each intervention: **what** it is, **the incident or need that caused
   it** (with evidence), **the artifact** that embodies it (file path, commit, D-row), and **its effect**. Candidates to
   verify and present (find more in `git log`, `CLAUDE.md`, `.claude/skills/`, `docs/briefs/`, `docs/research/review-*`,
   `docs/engineering-decisions.md` entries 40-47):
   - `CLAUDE.md` as a living harness: rules added after incidents (commit as you go after a lost 2400-line arc; "&& is
     the gate" after `d24bf69` committed on red; dispatch caps after a $-burning fan-out; explicit `rm` paths; "open it
     and look"; `PROCESS.md` word count enforced by `scripts/check-evidence.ts`).
   - **Project skills** in `.claude/skills/`: `run-tests` (the gate, its rules), `dev-server` (the stale-wasm restart),
     `dev-tools` (dev routes and hooks). Why each exists.
   - **The tiered gate** (`scripts/gate-plan.ts`, D-220): fail-safe classification of what a change can affect.
   - **Delegation by model tier** (Opus leads plan and review; Sonnet implements; Haiku does mechanical work) with
     **dollar caps written into every brief** (`docs/briefs/`), spend read from the proxy's `/api/me` during runs, and
     the outcomes (leads stopping at caps, cut lists).
   - **Independent cold reviews** (read-only Sonnet reviewers of `sim/`, the protocol and the trust path) and what they
     caught that tests didn't (`docs/research/review-*.md`); **the code-only review** (an Opus reviewer that never read
     the project's docs: `docs/research/code-review-2026-11-08.md`) and the fixes it led to (D-221 to D-224).
   - **Red-first tests and "a green test is not a working feature"**: examples where a test passed on buggy code, or a
     screenshot caught what hundreds of tests didn't (the sky, the ruins' background).
   - **Verifying agents' claims** against their own logs (a walk-in figure that didn't match its file: D-214), and
     **load discipline** (one heavy job at a time; a soak bisect that measured CPU starvation; agents told to wait).
   - Budget and process artifacts a marker can check: per-run spend recorded in reports, briefs with caps,
     `FUTURE.md` as the parking lot for ideas.
   Present this so a marker can verify each claim from the repo alone. **Do not cite `HANDOVER.md` or
   `ADMIN.local.md`** (gitignored, local only: a marker can't open them); cite committed files and commits.
6. **Known limits and open issues** (honest, short): capacity at the Fly quota (D-213; the warm-verify fix not merged),
   the intermittent survival test under load (D-219), duplicated salts (D-217), what wasn't measured on real devices.
7. **A map of the documentation**: what each kind of document is for (`docs/plan.md`, `docs/DECISIONS.md` (the full
   log), `docs/engineering-decisions.md` (the curated big ones), `docs/research/` (reports, reviews, measurements),
   `docs/briefs/` (what agents were asked), `FUTURE.md`, `spec/`), and where to start for each question a marker might
   have. Optionally a generated index of research notes and briefs in `docs/architecture/`.

## Quality bar
- Concise prose, plain words, short sections, tables where they help; no filler. Read it back as a marker would.
- Every link resolves in the repository (check with a small script: every relative link in your Markdown points at a
  file that exists; every `D-nnn` you cite exists in `docs/DECISIONS.md`; every entry number exists).
- Images: readable, labelled, consistent; Read each PNG you produce before using it.
- A cold check: one Sonnet worker reads `ARCHITECTURE.md` against the code and lists claims it can't verify; fix them.

## Hand back
The branch `architecture-audit` committed, not pushed, with `ARCHITECTURE.md`, `docs/architecture/*`, your report
`docs/research/architecture-audit-report.md` (spend per worker and total, what the cold check found and what you
changed, link-check output), commits ending with the writing model's `Co-Authored-By` line (Opus
`Claude Opus 5.5 <noreply@anthropic.com>`, Sonnet `Claude Sonnet 5.5 <noreply@anthropic.com>`, Haiku
`Claude Haiku 5.5 <noreply@anthropic.com>`).
