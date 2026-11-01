# Brief: code-review fixes 1-3 (stability, before any deploy)

**Why:** the code review of 1 Nov (`docs/research/code-review-2026-11-01.md`, rows 1-3) found three ways one
event takes down a whole server or room. Read that file's rows 1-3, `docs/research/code-review-server.md`
findings 1-2, and `docs/research/code-review-sim.md` finding 1. Each has the exact lines.

**Worker:** one Sonnet worker. Use no subagents, and stay within about 60 tool calls. Read `CLAUDE.md`
first. The binding rules:
- every commit gated on exit codes chained with `&&`;
- every new test shown red first;
- `rm` only on literal absolute paths;
- no pushing;
- never weaken a test expectation;
- no `console.*` in `server/`: log through `log.event` with a name in `shared/events.ts`.

Prefix cargo with `PATH="$HOME/.cargo/bin:$PATH"`.

## 1. A failed room load must not crash the server (`server/main.ts`)

- **The problem:** the HELLO handler runs `void getOrLoadRoom(...).then(...)` with no `.catch`.
  `World.load()` throws on purpose on `verify_unavailable`, and the production `unhandledRejection` handler
  rethrows.
- **The fix:** catch failures from both the room load and the continuation (`identity.resolve`, `w.join`, the
  stats bump). On a failure:
  - log `room.load_failed` (or `hello.failed`) through `log.limited`, keyed per room;
  - reject the client with the existing rejection message and a reason it can show;
  - reset `handshaking`.
- **Keep boot-time behaviour:** a fixed world (0 or 1) that can't verify at boot should still refuse to start.
  Only lazily loaded rooms change.
- A room that failed to load must not stay half-registered. Check `loadingRooms` and `worlds`.
- **Test (red first):** a net test that makes a room's load throw (inject a failing verifier, or a stored
  snapshot from a different build with the verifier unavailable), opens it, and asserts:
  - the client gets a rejection;
  - the server is still up;
  - another room still serves.

## 2. DB errors in hash handling must not crash the server (`server/world.ts`, `server/main.ts`)

- **The problem:** `db.recordIncident` and `db.updateIncident` (about `world.ts:907, 924, 1046`) aren't
  guarded, unlike `flush()`.
- **The fix:**
  - Wrap them in a small helper that catches, logs `db.write_failed` through `log.limited`, and carries on.
    The incident row is diagnostics, not state.
  - Give the timer loop that calls `w.tick()` for every world a **per-world** try/catch. A throw logs
    `world.tick_failed` (limited) and closes that one world. Use the existing close and unload path if there
    is one, so its clients get a clean close. Other worlds keep ticking.
- **Test (red first):** make `recordIncident` throw (an injected DB or a stub), force a divergence, and
  assert the server and the other worlds keep ticking.

## 3. One Paint input must have bounded cost (`sim/src/sim.rs`)

- **The problem:** endpoints and radius are clamped, but stroke length isn't. A corner-to-corner stroke at
  radius 32 costs about 6.6 M cell writes on every client.
- **Bound the cost per input deterministically:**
  - Clamp the stroke length to a `MAX_PAINT_STROKE` in `tuning.rs`. First read `client/worker.ts` (around
    lines 177-215: one segment per `SEND_EVERY_MS`) and pick a limit **above** the longest segment a real
    fast drag produces, so normal painting doesn't change. Put that reasoning in the doc comment.
  - Choose how a too-long stroke is handled: truncate from `(x0, y0)`, or drop the input. Say which, and why.
  - Optionally, step the disc centres by `max(1, r / 2)` instead of 1 cell, which cuts the cost of
    thick strokes about r/2 times. If you do, make sure the stroke has no gaps.
- **Test (red first):** count the cells written (or the disc stamps) for the worst-case input, and assert it
  is under a stated bound. Halve the bound and show the test fails.
- This touches `sim/`, so run the **determinism suite** before committing. Expectations may change only
  where a test really paints a long stroke; tie each one to its case.
- **CLAUDE.md:** update the "An input must not be able to cost unbounded work" bullet to name the length
  clamp too.

## Files you may touch

- `server/{main,world,db,log}.ts`
- `shared/events.ts`
- `sim/src/{sim,tuning}.rs`
- `sim/tests/*.rs`
- `tests/net/*.test.ts`
- `tests/determinism/*`: expectations only, never weaken a check
- `CLAUDE.md`: only the paint bullet
- your report

## Gate (every commit)

```sh
cd sim && PATH="$HOME/.cargo/bin:$PATH" cargo test --release && PATH="$HOME/.cargo/bin:$PATH" cargo clippy --target wasm32-unknown-unknown --release -- -D warnings && cd .. \
  && pnpm typecheck && pnpm test:determinism && pnpm test:net && git commit ...
```

## Commit checklist (commit each separately)

- [ ] 1. Room-load failure caught, test.
- [ ] 2. Incident DB writes guarded, per-world tick isolation, test.
- [ ] 3. Paint stroke bound, test, CLAUDE.md line.

End each commit message with a blank line, then `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.

## Report

Write `docs/research/fix-review-1to3-report.md` as you go. It should cover:

- per commit: the hash, what changed, and the red-first evidence;
- the paint limit, and the drag measurement behind it;
- **"Architectural decisions for review":**
  - what closes a world after a tick failure;
  - truncating versus dropping a long stroke;
  - whether the boot-time refusal is kept.

At the end, kill anything you started (`pgrep -fl "vite.js|server/main"` must be empty).
