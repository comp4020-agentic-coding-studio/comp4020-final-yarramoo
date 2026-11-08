# Brief R2c: re-measure capacity against real rooms

Written 24 Oct by the session model, after R2b landed, was independently reviewed, had two HIGH-severity bugs
fixed, and was pushed (`multa` at `2fb284f`). Third and final slice of milestone R2 ("Rooms on the server") of
`docs/plan-game-modes.md`. Per the milestone table: "the capacity measurement (Docker image, 24 sockets over 4
rooms, a forced verify; pass is under 200 MB)."

**Dispatch:** one Sonnet worker, medium effort, about 50 tool calls. This is a measurement job with a real but
small code change (adapting the existing bench to room ids), not structural — no independent reviewer needed,
the session model reviews directly.

---

## Context for the worker

Repo `/Users/mitch/code/courses/comp4020/comp4020-final-yarramoo`, branch `multa`. Read `CLAUDE.md` first (the
`rm` rule: every `rm` names an explicit literal absolute path, never a glob on a variable; the Docker container
this bench uses must be cleaned up by its literal name on every exit path, including a crash). The game is not
live: nothing here risks live state. Never use port 8080 — the existing bench already uses 8094 by convention
(`PORT` env var, default 8094), keep that.

## What exists already

- **`tests/soak/capacity.ts`** (`pnpm soak:capacity`): the existing bench from before R2. It builds/boots the
  real Docker image as container `cap-bench`, spins up headless bot clients (real `Lockstep`/`reactToTick` code,
  a full WASM sim each) in worker threads, and has them join **the two fixed worlds** (world 0 sandbox, world 1
  cave) by a bare world id, ramping through step counts (`STEPS` env, default `0,8,16,32,48,64`), holding each
  step (`HOLD_S`, default 60s), and recording cgroup memory/CPU, snapshot verify times, and outbound bytes to
  `docs/research/capacity-results.json`. Read the whole file — it's not long, and `startBot`/`addBot`/`main` is
  everything.
- **R2a/R2b** (landed) added `POST /api/rooms` (create, returns `{id, code, ...}`) and real room-joining over
  the socket: HELLO with a room's id (not 0 or 1) now lazily loads that room and lets bots join it exactly like
  the two fixed worlds, with the same protocol. `World.requestSnapshot()` is a public method that forces an
  immediate snapshot request/verify cycle (used internally on a timer; callable directly isn't wired to an API
  route today).
- **The plan's exact ask**: "24 sockets over 4 rooms, a forced verify; pass is under 200 MB." This is a much
  smaller, targeted scenario than the existing bench's ramp — not a repeat of the full `0..64` step sweep, which
  already exists and isn't this slice's job to redo. This is specifically: create 4 real rooms, put 6 bots in
  each (24 total), force a verify, and confirm cgroup memory stays under 200 MB.

## What to build

1. **A room-aware variant of the bench**, either as a new script (`tests/soak/capacity-rooms.ts`, a new
   `pnpm soak:capacity-rooms`) or a mode flag on the existing one (`MODE=rooms` or similar) — your call on
   whichever is the smaller, clearer change given the existing file's shape. It must:
   - Boot the real Docker image the same way the existing bench does (same `--memory=256m`, `--tmpfs /data`,
     literal container name, cleaned up on every exit path).
   - Create 4 rooms via `POST /api/rooms` (pick a reasonable mix — e.g. 2 Deathmatch-preset Caves rooms at size
     M, 2 Creative-preset Solid-box rooms at size S, or whatever mix you think best exercises the real caps;
     explain your choice in the report). Use the real HTTP API, not a direct DB write.
   - Connect 6 bots to each room (24 total) using the existing bot machinery (`startBot`, adapted to take a room
     id instead of a fixed world id — the WebSocket/HELLO path is identical, this should be a small change).
   - Hold for a reasonable settle period (model it on the existing bench's `HOLD_S`), then force a verify on
     each room (`World.requestSnapshot()` isn't reachable from outside the process today — either add a thin
     test-only trigger, e.g. a debug endpoint gated so it can't ship live, or drive it the way the existing bench
     already waits for a natural snapshot cycle to occur, whichever is less invasive; flag your choice under
     "Architectural decisions for review").
   - Record cgroup memory (`docker exec <name> cat /sys/fs/cgroup/memory.current`, same pattern the existing
     bench uses) at the 24-socket, post-verify point, and report pass/fail against the 200 MB bar explicitly.
2. **Update `docs/research/capacity-rooms.md`** with a new dated section ("R2c: real rooms, measured") giving
   the actual numbers (cgroup MB at 24 sockets/4 rooms, verify time per room, whether the 200 MB bar was met),
   compared against the pre-R2 two-fixed-world baseline already in that file. If the number is close to or over
   200 MB, say so plainly and don't round it away — this is exactly the kind of finding the capacity note exists
   to surface honestly (see its own existing corrections, e.g. the D-100/D-101 pattern in `docs/DECISIONS.md` of
   writing down a wrong first reading and then correcting it, rather than silently redoing the measurement).
3. **If the loaded-room-slot or member caps (D-142) interfere** with getting 24 sockets into 4 rooms during the
   bench (e.g. the bench's own bots count against `MAX_MEMBERS_SOFT = 32`), that's fine and expected — 24 is
   comfortably under 32. If an L-size room's 2-slot weighting means 4 L rooms would exceed `MAX_LOADED_ROOMS`
   with room to spare for the fixed worlds, choose room sizes that fit comfortably within the cap rather than
   fighting it; this bench is about measuring memory/CPU cost, not stress-testing the cap logic itself (R2b's
   tests already cover that).

## What NOT to build

- Don't re-run or change the existing `0..64`-step two-world bench (`tests/soak/capacity.ts`'s current behaviour)
  — it stays as-is, still useful for future reference.
- Don't touch `sim/`, `shared/room.ts`, `shared/protocol.ts`'s wire format, `server/main.ts`'s route logic, or
  `server/world.ts`'s lifecycle code — this is a measurement script only. If you find a bug while building it,
  stop and report it rather than fixing it yourself (file a note in your report; the session model will triage).
- No new DECISIONS.md/engineering-decisions.md rows — write the raw findings into `capacity-rooms.md` and your
  report; the session model writes the decision-log entry from your numbers.

## Verify

- The bench script itself doesn't need a red-green TDD cycle (it's a measurement tool, not a correctness claim
  about product code) — but it must actually run successfully end to end at least twice before you report
  numbers, to rule out a one-off fluke, and both runs' numbers should be in the report.
- `pnpm typecheck` must stay clean (the new/changed script is still TypeScript the project's tsconfig covers).
- Don't run `pnpm test:net`/`pnpm test:determinism` as a gate for this slice (nothing in product code changes),
  but do confirm the existing test suites still pass once if you touched any shared file, to catch an accidental
  import-path break.
- The Docker container must be removed by its literal name (`docker rm -f cap-bench` or whatever literal name
  you use) on every exit path, including if the script errors partway — wrap the measurement in a try/finally or
  equivalent so a crash never leaves a stray container running.

## Commits

This is a smaller slice than R0a/R1/R2a/R2b — a single commit is fine once the bench runs cleanly and produces
real numbers, gated on `pnpm typecheck && git commit ...`. If you end up making more than one logical change
(e.g. the bench script, then a fix to something it revealed needed a tweak), separate commits are fine but not
required.

End each message with the attribution line from the session's instructions. **Don't push**: the session model
reviews and pushes.

## Report

Write to `docs/research/r2c-worker-report.md`. Include: what you built and why (the room mix chosen, how you
triggered a forced verify), the actual numbers from at least two runs, a clear pass/fail statement against the
200 MB bar, anything surprising, and any FUTURE.md ideas written directly into `FUTURE.md`.
