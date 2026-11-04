# Brief HR: hardening review before the deploy (three cold reviewers)

**Why:** everything since `3110766` (the 3 Nov playtest build) is about to go to `main` and Fly. That range is
2759 lines over 57 files: liquids resting, falling-rock anchors, Pebbles, chunk waking, heal drops, music,
the hotbar, the UI review, catch-up after a hidden tab. Each slice had its own review, but nobody has read
the range as a whole. Past cold reviews found bugs every test passed over (M3's buffer overrun, W's restore
desync).

**Worker:** three Sonnet reviewers, one per area, running at the same time. **Read only:** no edits, no
builds, no test runs, no git commands that write. Stay within about 60 tool calls. Use no subagents.

**Where:** the frozen checkout `/tmp/wt-review` (detached at `0099809`). Read the code there, not in the main
repo, which other workers are changing. `git -C /tmp/wt-review diff 3110766..0099809 -- <paths>` gives your
range.

| Reviewer | Area | Output file |
|---|---|---|
| sim | `sim/` (the Rust simulation) | `docs/research/review-hardening-sim.md` |
| client | `client/` | `docs/research/review-hardening-client.md` |
| server | `server/`, `shared/`, `tests/`, `scripts/` | `docs/research/review-hardening-server.md` |

Write the output file in the **main repo** at
`/Users/mitch/code/courses/comp4020/comp4020-final-yarramoo/docs/research/`. Write it as you go: add each
finding the moment you've confirmed it, so a run that stops early still leaves something behind.

## Read first

- `/tmp/wt-review/CLAUDE.md`, especially the 11 simulation invariants and "Server logging and identity";
- `docs/DECISIONS.md` rows D-172 to D-182, which say what each change was meant to do;
- the earlier reviews of this range, so you don't repeat what was already found and resolved:
  `docs/research/review-fix-{a,b,w,e}.md` (each ends with the resolution).

## What to look for, in order

1. **Determinism and desync (sim reviewer especially):** anything that makes two clients disagree.
   - State read from scratch or derived data that a restored client initialises differently (W's bug class).
   - Iteration order, `usize` in a hash, floats, a hashed field missing from the snapshot or the reverse.
   - Sleeping or waking that changes results (invariant 8).
2. **Unbounded work from one input or one event:** every client runs it, so it freezes the room.
3. **Snapshot and restore:** asymmetry between write and read, unchecked lengths, hostile bytes accepted.
4. **Client:** state that goes stale after a resync, a reconnect, a hidden tab or a room switch; listeners or
   timers that leak; anything that reads outputs back into inputs (invariant 9); per-frame allocations in
   hot paths; the dev hooks leaking into the production build (they must sit behind `import.meta.env.DEV`).
5. **Server:** a client-triggered log line not going through `log.limited`; a raw IP or token logged;
   `name#id` shown to players; an import from `client/` in `server/` or `shared/`; claim handling that a single
   client can abuse beyond the accepted D-120/D-171 gap.
6. **Tests:** a test that cannot fail (asserts on its own setup, or passes on the buggy code), a real-clock
   wait that will be flaky under load, or a weakened assertion.

## Each finding

```
## F<n> MUST-FIX | SHOULD-FIX | NOTE: <one line>
- file:line, what the code does, and the concrete scenario (inputs and state) that goes wrong
- why it matters (desync, freeze, crash, wrong display, leak)
- the fix you'd suggest, and a test that would show it red first
- confidence: high / medium / low, and what you didn't check
```

MUST-FIX means a desync, a crash, a security hole or a room-wide freeze that a real player could hit.
Prefer five verified findings to twenty guesses. Say "not checked" rather than guess. End the file with a
short "Read and found sound" list of what you checked and found correct.

## Architectural decisions for review

None expected, since this is a review. If you think a design choice in the range is wrong (not just its code),
put it under this heading at the end of your file, with the alternatives.
