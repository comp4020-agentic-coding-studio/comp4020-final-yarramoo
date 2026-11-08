# Architecture audit: lead report (brief AUDIT, 8 Nov)

Opus lead. Brief: [`docs/briefs/architecture-audit.md`](../briefs/architecture-audit.md). Branch `architecture-audit`
in `/tmp/wt-audit`, first from `multa` `4e5fee2`, rebased onto `multa` `b630cff` once the owned sandbox (D-225) and the
slow-connection notice (D-226) merged during the run. Only new files; no builds, tests, servers or browsers.

## What was made

- [`ARCHITECTURE.md`](../../ARCHITECTURE.md) at the repository root, about 5,600 prose words (about 20 minutes):
  1 what Simulta is; 2 system architecture (parts, a Mermaid tick sequence, how state is checked, what persists);
  3 the 11 invariants and the check that enforces each; 4 33 key decisions in six groups, with reversals and
  bugs marked; 5 harness and skill-level interventions (7 subsections); 6 known limits; 7 a documentation map and a
  "where to start" table.
- [`docs/architecture/components.png`](../architecture/components.png) (+ `.svg`): browser (main thread, worker,
  sim.wasm), server (HTTP, World, verify worker), SQLite tables, and what persists. Supersedes the storage box of
  `docs/lockstep-networking.png`, which says Postgres; the guide says so and still links the old one for its timeline.
- [`docs/architecture/delivery-loop.png`](../architecture/delivery-loop.png) (+ `.svg`): the agent pipeline (brief with
  a cap, worker, red-first test, gate re-run by the lead, cold review, open it and look, merge and record), with the
  artifact under each stage and the budget loop.
- [`docs/architecture/doc-index.md`](../architecture/doc-index.md): every research note and brief with date, kind,
  topic and the D-rows it cites (Haiku worker; the lead appended rows for files added after it ran).
- Hand-written SVG converted with `rsvg-convert`; each PNG was read back and fixed for overlapping labels (three
  rounds on the pipeline diagram).

## Harness interventions presented (section 5)

1. `CLAUDE.md` as a living harness: 11 rules, each with its commit, incident and effect.
2. Project skills: `run-tests`, `dev-server`, `dev-tools`, and why `.claude/skills/` is tracked.
3. The tiered gate (`scripts/gate-plan.ts`, D-220), fail-safe, its test shown red.
4. Delegation by model tier with dollar caps in every brief; a table of nine runs' caps, spend and what the cap cut.
5. Cold reviews and the code-only review (D-221 to D-224).
6. Red-first tests, open-it-and-look, measure before concluding, merge rehearsal in the real image.
7. Verifying agents' claims (D-214, D-219) and load discipline; agent playtesters.

## Cold check (Sonnet worker, AUDIT-2)

The worker read the guide against the code at `4e5fee2` and checked about 190 claims
([`architecture-coldcheck.md`](architecture-coldcheck.md)). Six findings; all six were confirmed in the code and fixed:

| # | Verdict | Finding | Change |
|---|---|---|---|
| 1 | imprecise | Brief count 63 (61 at `4e5fee2`); "53 briefs cap tool calls" not reproducible | Recounted at `b630cff`: 66 briefs, 55 ask for architectural decisions, 56 mention a tool-call cap |
| 2 | imprecise | `client/worker.ts:576` is a comment, not the Pos quantisation | Now `Avatar.quantised`, `client/avatar.ts:209-211`, sent at `client/worker.ts:586` |
| 3 | imprecise | The step order given was longer than `Sim::step`'s doc comment and D-102 | Says the code runs nine stages and the comment and D-102 list the first six |
| 4 | wrong | "Not sleeping (an earlier belief, D-173)": D-173 had concluded active region, not sleeping | Reworded: D-191 overturned D-173's active-region explanation |
| 5 | stale | Owned sandbox "not on `multa`": merged in `a4acdf4` during the run | Rebased; the persistence table, section 4 and the spend table now include D-225 and entry 47 |
| 6 | imprecise | The catch-up pause stated as unconditional | Now: the clock holds only when nobody is live and the joiner has a log to replay (D-122, D-131) |

Also changed after the rebase: commit counts (756; 446 Sonnet, 300 Opus, 2 Haiku), 47 entries, 223 D-rows (D-001 to
D-226; three ids in the 130s were never used), 39 cold reviews, `server/main.ts` and `client/room.ts` line numbers, and D-226 in
sections 4 and 5. The checker could not find a committed source for "on 5 Nov the agent rebuilt and left the old server
up"; it is in the message of `f3d4034`, which the guide now cites.

## Link check

`/tmp/audit-scripts/linkcheck.py` (outside the repo): every relative Markdown link resolves to a file, every
engineering-decisions anchor exists, every `D-nnn` exists in `docs/DECISIONS.md`, every "entry N" exists, every
backticked 7-hex commit exists, and every backticked code path exists. Final run over `ARCHITECTURE.md`,
`docs/architecture/doc-index.md` and this report:

```
checked {'links': 350, 'drows': 398, 'entries': 78, 'commits': 31, 'paths': 111} problems 0
```

## Spend

| Point | Week spend | Run total |
|---|---|---|
| B0 (start) | $341.79 | $0 |
| after W1, Haiku index (11 tool calls) | $343.78 | $1.99 (mostly the lead's reading; the worker about $0.05 by tokens) |
| after the guide's first draft and both diagrams | $350.34 | $8.55 |
| after W2, Sonnet cold check (29 tool calls, 107 k tokens) | $353.75 | $11.96 (worker about $1.5 by tokens) |
| at this report | $355.83 | $14.04 |
| final (before the commit) | $ | $-341.79 |

Two of four permitted workers, one at a time, neither dispatched further. The proxy reports the whole account's spend
(other leads ran on this machine during the run), so per-worker figures are estimates from token counts.

## Not done

- No images of the game itself were added; the guide links the committed screenshots instead.
- The guide is about 5,600 words, at the top of the brief's 15-20 minutes; section 5 is the longest by design.
