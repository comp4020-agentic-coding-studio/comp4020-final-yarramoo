# Brief REVIEWFIX: implement the fixes from the independent code review (Opus lead)

Written 8 Nov by the session model. The user: "please implement the fixes from the review". The review is
`docs/research/code-review-2026-11-08.md` (read from the code only; line numbers are at `7d5b004`, and `multa` has
moved since: Track B's surface ruins merged at `e4fb061`, format 19). You are the **Opus lead**: verify each finding,
fix it, prove the fix, and hand back a gated branch. Final submission is **Mon 9 Nov 12:00**: a correct, reviewed
fix beats a broad one; anything too big or risky for tonight becomes a ready brief, not a half-done change.

## Budget and stopping (hard)
- **$35 total** for you and every worker. Read spend at the start (B0), after every worker and every ~20 of your own
  tool calls:
  `curl -sf https://strproxy.comp.anu.edu.au/api/me -H "Authorization: Bearer $ANTHROPIC_AUTH_TOKEN" | python3 -c "import json,sys;print(json.load(sys.stdin)['current_week_spend'])"`.
  Stop dispatching at B0 + $28; finish by B0 + $35. **If the week reads $366 or more, stop at once**, commit what you
  have to your branch and report.
- **At most 3 workers, one at a time** (Sonnet for implementation, Haiku for mechanical work). Workers never dispatch.
  Each gets a brief in `docs/briefs/reviewfix-*.md` with its cap, files, commit checklist, verification and
  "Architectural decisions for review", and writes its report to a file as it goes.
- Write `docs/research/review-fixes-report.md` **as you go**.

## Where
`git worktree add /tmp/wt-reviewfix -b review-fixes multa`. Never touch the main checkout or the user's :8080 server
(PID in `HANDOVER.md`); never push or merge. Ports 8077 (servers) / 5177 (vite), data `/tmp/reviewfix-*`.
**Track C is running now in `/tmp/wt-phoneperf`, measuring frame times in throttled browsers**: a gate on the same
machine would corrupt its numbers. Read, design and write code freely, but **before any gate or heavy build** check
`pgrep -fl "wt-phoneperf|cargo test|vitest|test:determinism|tests/soak"` and wait until it shows nothing of another
job's.

## The work, in priority order (verify each finding in the code first; skip one that doesn't hold, and say why)
1. **S1, `update_ice` writes `aux` without `touch`** (`sim/src/grid.rs`, `update_ice`): add `self.touch(i)` where the
   ice cell's own `aux` changes. **Also add the reviewer's invariant test**: after stepping a busy world (ice, water,
   fire, sand, across chunk edges), the cached state hash equals the hash recomputed with every chunk marked dirty.
   Show it red on the unfixed code first, then hunt with it: any other direct `mat`/`aux` write without `touch` that it
   exposes is the same bug (grep `self.aux[` and `self.mat[` writes in `grid.rs` and friends).
2. **H1, hash votes count sockets** (`server/world.ts` `onHash`/`tryResolve`, `requestSnapshot`): count hash votes
   once per registered player (as claims already do: see the claim paths), so spectators and anonymous members are
   compared against the truth but never define it; request the snapshot only from a player. Decide what the sandbox
   (where painters may be unregistered: check) does: e.g. one vote per IP tag, and say so. Tests, red first: a
   spectator majority with a wrong hash does not resync the players; a spectator is never the snapshot source.
   **This is the trust path**: cold review required.
3. **M1, old-tick HASH frames grow server state** (`onHash`): only accept a hash within a recent window of
   `lastClosed`, bound `checkpoints`, and rate-limit non-input frames per connection (the input path already has a
   rate). Test red first: a spray of old-tick hashes leaves the server's maps bounded.
4. **H2, Paint has no aggregate work budget**: a **deterministic** per-tick paint budget in the sim (inputs over the
   budget are dropped or truncated identically on every client: it's applied in input order inside `step`, never from
   anything client-local), plus a per-IP-tag paint rate on the server. This changes sim behaviour for a flood only;
   normal painting must be unaffected (a test that a typical stroke stream is untouched, and one that a flood is cut).
   Full gate; determinism suite; cold review. If it doesn't fit tonight, leave a ready brief and say so.
5. **M3, `max_players` never enforced**: enforce it at join (server), with a clear reject reason; test red first.
6. **M2 (suspected), catch-up vs the 8 MiB send cap**: verify first (measure a long log's catch-up size); fix only if
   it holds and is small (e.g. exempt the catch-up burst from the live cap, or send it paced); otherwise a brief.
7. **Cheap lows** from the report if budget remains. **Not tonight**: M4 (layouts copied by hand: a refactor; add a
   test pinning the mirrors if cheap), M5 (the admin token: it's a `fly secrets set` at deploy, the user's step), and
   the big refactors in the improvements list.

## Rules
- CLAUDE.md binds you fully: sim invariants (determinism, sleep invisibility, bounded work, unique salts), server
  logging through `log.event`/`log.limited` with names in `shared/events.ts`, plain names to players, no `console.*`.
- **Every fix gets a test shown red first** on the unfixed code (and the red output quoted in the report).
- **Gates**: anything touching `sim/`, `shared/` or the input path runs the full `run-tests` gate in your worktree;
  server-only changes run `pnpm typecheck && pnpm test:net` and `APP_URL=http://localhost:8077 pnpm check` against your
  own server. A sim change may move golden pins: re-record as `sim/tests/golden.rs` documents, never loosen a guard;
  bump `FORMAT_VERSION` (sim and `server/db.ts`) only if a record changes.
- **Cold review**: one read-only Sonnet reviewer on the final diff of `server/` and `sim/`, writing to
  `docs/research/review-review-fixes.md`; check its claims in the code before acting.
- Kill everything you start; remove temp dirs by literal path.

## Hand back
`docs/research/review-fixes-report.md`: each finding (fixed / not reproduced / deferred, with why), the red-first
evidence, gate results with log paths, the cold review and what you did about it, **Architectural decisions for
review**, D-row drafts, an engineering-decisions entry draft, and briefs for anything deferred. Branch `review-fixes`
committed, not pushed. Commits end with the writing model's `Co-Authored-By` line (Opus
`Claude Opus 5.5 <noreply@anthropic.com>`, Sonnet `Claude Sonnet 5.5 <noreply@anthropic.com>`, Haiku
`Claude Haiku 5.5 <noreply@anthropic.com>`).
