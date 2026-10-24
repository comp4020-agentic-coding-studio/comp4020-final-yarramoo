# R2b fix: two confirmed-leak bugs from review-r2b.md

Both HIGH findings in `docs/research/review-r2b.md` fixed with minimal, targeted changes to
`server/main.ts`'s HELLO handler. Two gated commits, on top of `4fdc3a4` (not pushed — left for
the session model to review and push).

- `b2540842328a8bd28fdd74c52ced15e815b200d5` — Fix R2b bug 1 (member cap leaks a freshly-loaded room)
- `8c1113172f8bcfea6c5b352b9790d1c2d93938d1` — Fix R2b bug 2 (`cancelUnload` fires before identity resolution)

## What changed

**Bug 1.** Added `discardIfFreshlyLoaded(w, wasWarm)`: captures `wasWarm = worlds.has(msg.worldId)`
immediately before calling `getOrLoadRoom`, then calls `discardIfFreshlyLoaded` at every subsequent
rejection point (`world_members` cap, `memberCapReason()`, and — after bug 2's commit — the
unknown-token reject too). It only acts when the room wasn't already warm and has zero members,
mirroring the unload timer's own shutdown path (`w.shutdown()` + `worlds.delete(w.id)` +
`log.event("room.unloaded", ...)`).

**Bug 2.** Moved `cancelUnload(w.id)` from immediately after the member-cap checks to immediately
before `w.join(...)`, i.e. only once `identity.resolve`'s unknown-token check has also passed. The
unknown-token reject path now also calls `discardIfFreshlyLoaded` for symmetry with the other
reject paths, since bug 1's commit ran before this reorder and that path didn't need it yet (no
`cancelUnload` had fired before it).

## Red-then-green evidence

**Bug 1** (`tests/net/room-join.test.ts`, "a room's first HELLO, rejected by the member soft cap, is
not left loaded"): with `maxMembersSoft: 0`, a brand-new room's only HELLO is rejected ("server
busy"). Run against the pre-fix code (stashed `server/main.ts`, keeping the new test):

```
AssertionError: expected true to be false
 ❯ tests/net/room-join.test.ts:232:38
   expect(s.worlds.has(created.id)).toBe(false);
```

After the fix: 15/15 tests in the file pass (13 existing + 2 new).

**Bug 2** (same file, "a bad-token HELLO to a room whose unload timer is armed does not cancel it"):
a real member joins and leaves a `CAVES_PVP`-based room (arming its 200ms test unload timer), then a
second HELLO with no token is rejected with "unknown token". Pre-fix:

```
Error: timed out waiting for room still unloads on schedule, not leaked
 ❯ waitFor tests/net/helpers.ts:204:40
```

(the room stayed loaded well past the 200ms deadline because the bad-token HELLO had already
canceled the armed timer). After the fix: passes, room unloads on schedule.

## Full gate results

Both commits were gated on `pnpm typecheck && pnpm test:determinism && pnpm test:net && git commit`
(exit-code gated, no `;` or grep piping):

- `pnpm typecheck`: clean, both times.
- `pnpm test:determinism`: 11 files / 41 tests passed, both times (~85–94s each).
- `pnpm test:net`: 37 files / 299 tests passed after the bug-1 commit; re-ran again after the bug-2
  commit — all 299 still pass, including the pre-existing admission-cap tests
  (`tests/net/room-join.test.ts`'s "rejects a join past the member hard cap", "rejects loading a new
  room past the loaded-room slot cap", "an L room counts as 2 of the loaded-room slots"), the unload
  tests, and the two-fixed-worlds tests — no regressions from the reordering.

## Docker / manual verification

Built the real image (`docker build -t r2b-fix-verify .`, all 3 stages, exit 0) and ran it on
**port 8093** (`-p 8093:8080 -e PORT=8080`), never 8080.

- `APP_URL=http://localhost:8093 pnpm check` against the live container: `pnpm typecheck` clean,
  `vitest run` (the `spec/` suite) 2 files / 9 tests passed, exit 0.
- Manual raw-protocol verification (small Node scripts using the repo's real `shared/protocol.ts`
  and `shared/room.ts` encoders, pointed at the container's own `sim.wasm` copied out via
  `docker cp` — the container's wasm build hash differs from the host's local build, so the host's
  wasm got "sim build mismatch" until I switched to the container's copy):
  - `/api/summary` initially lists only worlds `[0, 1]`.
  - Created a sandbox room via `POST /api/rooms`, joined it anonymously — WELCOME, and it now
    appears in `/api/summary` (`[0, 1, 3]`) with a real member, as expected (this is the "successful
    join still works" check; this image's default caps are the production defaults, not a tiny test
    cap, so I couldn't directly trigger bug 1's cap-rejection path through the live container without
    either changing server config or opening dozens of connections — that path is covered by the
    automated regression test above, which exercises the exact same code with `maxMembersSoft: 0`).
  - World 0 (fixed world) still joins successfully (WELCOME).
  - Created a `deathmatch`/`CAVES_PVP` room, registered a player, joined with a valid token (WELCOME),
    closed the connection, then sent a second HELLO with no token to the same room — got "unknown
    token" as expected, and the room was still present in `/api/summary` immediately after (expected,
    since the container runs the real 2-minute unload timer, not a shortened test one; the "does this
    rejection fail to re-arm/leak" assertion is exactly what the automated regression test with the
    200ms test timer checks).
- Container and image removed by literal name afterward: `docker rm -f r2b-fix-verify-container` and
  `docker rmi r2b-fix-verify` (no variables, no globs).

## What I was unsure about

- The brief asked to manually verify "a room rejected by a tiny member cap doesn't stay in
  `/api/summary`'s loaded worlds" against the live Docker container specifically. The running
  container uses production cap defaults (`MAX_MEMBERS_SOFT = 32`), which isn't practical to trigger
  with a handful of manual connections, and `startServer`'s cap overrides are constructor options,
  not env vars, so I couldn't configure a tiny cap on the containerized server without rebuilding or
  patching the image. I verified the underlying invariant through the automated regression test
  (which does use a tiny cap, `maxMembersSoft: 0`, against the real server code) instead, and used the
  live container only to confirm the ordinary join flows, the two fixed worlds, and the bug-2
  "unknown token" path still behave correctly end-to-end. Flagging this gap rather than treating it as
  silently covered — if a stronger container-level check matters, the server would need a
  cap-override env var or test-only startup flag, which felt out of scope for a narrow two-bug fix
  dispatch.
- `.gitignore` showed as locally modified (`M .gitignore`) from before I started; I left it untouched
  and unstaged per the brief's "do not touch" scope — it wasn't part of either commit.
