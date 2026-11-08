# Brief F: small client fixes (catch-up after a hidden tab, lava, walking animation, remove Creative)

**Why:** 3 Nov playtest notes 12, 6, 13 and 9 (`docs/playtest-2026-11-03.md`). Read those notes and `CLAUDE.md`
(client rules, "Open it and look", the server logging rules).

**Worker:** one Sonnet worker. Use no subagents, and stay within about 100 tool calls. You work in the worktree
`/tmp/wt-client` on branch `fix-f-client`. Another worker may be changing `sim/` on `multa`, so **touch nothing
in `sim/`.** Rules:
- `CLAUDE.md`;
- red-first tests where a test can see it;
- gate on exit codes chained with `&&`;
- `rm` only on literal absolute paths;
- **no pushing**;
- stop any vite or server you start;
- use **port 5194** for vite and **8098** for a real server.

Build the wasm in the worktree first: `pnpm build:sim && pnpm build:sim:devpaint` (with
`PATH="$HOME/.cargo/bin:$PATH"`).

## 1. Catch-up after a hidden tab (note 12, the most important)

In the playtest, a tab left in the background for 25 minutes came back 91,384 ticks behind the server. The
world then showed frozen enemies and an uncollectable pickup for about 6 minutes, while the server log's
`input.summary` lag fell at about 240 ticks/s.

**Cause (read from the code by the session model; confirm it):**
- `client/worker.ts`'s frame loop only fast-forwards when `net === "catching-up"`, which is set only on
  connect, resync or reconnect (`worker.ts` ~342).
- A tab that was merely hidden stays `live`, so on return it runs `ls.plan(base)`: at most
  `MAX_FRAME_STEPS` (4) + `MAX_EXTRA` (4) steps per frame (`client/lockstep.ts`). That's about 240-480
  ticks/s, against a backlog of 90k.
- Meanwhile the avatar walks on local prediction, and its Pos inputs land at the server's current tick, so
  the local world is stale.

**Fix:**
- **(a)** When `ls.buffered` exceeds a threshold (say 120 ticks, 2 s), switch to the fast-forward path: set
  `net` to `"catching-up"` with a `catchUpTarget` of the current received tick, so the existing overlay
  ("catching up", `renderCatchup` in `room.ts`) shows and `fastForward(FF_BUDGET_MS)` runs. Pause the avatar
  (no Pos and no casts) while catching up, as on a fresh connect. Return to live as the existing code does.
  Check that claims (`worker.ts` ~289) and hashes still behave: they're gated on `tick > catchUpTarget`.
- **(b)** On `visibilitychange` to hidden, if the room has an avatar, stop sending Pos and casts. **Don't**
  send Leave (that resets lobby countdowns and would surprise a player who alt-tabs for a moment). Write in the
  report whether the server should mark a long-silent player inactive. That's a server change; flag it, don't
  build it.
- **(c)** If the backlog is huge (say over 20,000 ticks), consider asking for a fresh snapshot instead of
  replaying. Check whether the existing resync path (`RESYNC`, close 4001 budget) can be reused cheaply. If
  it isn't a few lines, skip it and say so.

**Test:** a net test (in `tests/net/`, following the existing headless-client patterns) where a client stops
stepping for N seconds of server ticks (simulate a hidden tab by not running the frame loop), then resumes.
It must report `catching-up` and reach live within a bounded time. Show it red first.

## 2. The player sinks into lava (note 6)

- **Today:** lava is class "liquid" (`shared/names.ts` `MATERIAL_CLASS`), so the controller
  (`client/avatar.ts` `liquidAt` and `step`) already treats it like water: slowed, and you can swim. The user
  says "the player doesn't sink into lava". **First find out why:**
  - lava is denser and moves only on even ticks, so maybe the avatar never registers as in it;
  - or swimming up (`k.up` gives `vy -= 0.2`) and the buoyancy make it float on top;
  - or the feet check misses a thin lava layer.
- Open `/game?world=game&avatar=1&cfg=survival` and paint lava with
  `__devPaint(x, y, 14, r)` under the avatar (`__devMe()` gives its position). Watch.
- **Wanted:** in lava the avatar sinks slowly. It's heavier than in water: lower top speed, weaker swim-up,
  stronger downward pull. Make lava per-material in the controller (for example a small table: water, oil and
  acid as today, lava heavier). Lava already hurts every 2 ticks, so a slow sink is a real threat.
- Pos is validated by the server against `MAX_AVATAR_SPEED`. Keep every speed under it (`SPEED_LIMIT_OK`).
- Test: `tests/net/avatar.test.ts` patterns. An avatar placed in a lava pool ends lower after N steps than it
  started; in water it doesn't sink as fast.

## 3. A smoother walking animation (note 13)

- `updatePose` (`client/fx.ts` ~265) advances `walkPhase` by `|vx| * ticks * 0.45`, so a frame changes about
  every 3 ticks at walking speed. That plays the 4-frame cycle about 5 times a second, which reads as jitter.
- Slow it to about 8-10 frames/s at `WALK` (a factor of about 0.15-0.2), or step one frame per N cells walked.
- For **remote** players, `vx` comes from interpolated positions and spikes. Smooth it (an exponential
  average) and add hysteresis to the walk/idle switch, so a brief stall doesn't flicker to idle.
- Look at it at 1x and 2x. If you can, open a second browser session as another player in a real room on
  port 8098 to see a remote avatar walk (the session model's handover recipe is in `HANDOVER.md`, "A real
  room"). If that's too costly, say so.

## 4. Remove Creative mode (note 9; the user: "just the sandbox is fine")

- Remove the Creative card from the menu (`client/menu.ts` ~35), the filter option (~124), and the create
  flow's Creative choice.
- **Server:**
  - `POST /api/rooms` with `mode: "creative"` is refused (400) with a clear reason;
  - `ROOM_MODES` in `server/rooms.ts` drops it from what can be created;
  - keep the DB check constraint (old rows exist), and make loading an old Creative room fail with the
    normal "room unavailable" path, or keep it loadable if that's simpler. Say which;
  - the public `/sandbox` stays.
- Update the tests that create Creative rooms (`tests/net/room-join.test.ts` ~298, ~310, and any others:
  `grep -rn creative tests/`). Re-point them to another mode where they test something general. Delete them
  only where they test Creative itself, and say which in the report.
- Remove `client/public/icons/creative.png` if nothing references it.
- Leave `sim/src/config.rs` alone (no `sim/` changes).
- The dual-tools code in `room.ts` may become dead. Remove it only if it's clearly unreachable and small.
  Otherwise leave it and note it.

## Gate (every commit)

```sh
pnpm typecheck && pnpm test:net && git commit ...
```

`pnpm test:net` takes about 8 minutes. Run single files while iterating
(`npx vitest run --config vitest.net.config.ts tests/net/<file>`), and the full suite once per commit, in the
background.

## Commit checklist (commit each separately)

- [ ] 1. Catch-up after a hidden tab: test red, then the fix.
- [ ] 2. Lava sinking: the cause found, the fix, a test.
- [ ] 3. Walking animation.
- [ ] 4. Remove Creative: menu, server and tests.
- [ ] 5. Screenshots (`docs/art/shots/fix-f-*.png`, looked at before citing) and your report.

End each commit message with a blank line, then `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.

## Files you may touch

- `client/{worker,lockstep,room,avatar,fx,menu,protocol}.ts`, `client/index.html`, `client/public/icons/`;
- `shared/names.ts` (only if the controller table needs it), `shared/avatar.ts`;
- `server/{main,rooms}.ts` (Creative refusal only; any new log name goes in `shared/events.ts`);
- `tests/net/*.test.ts`;
- your report and screenshots.

## Report

Write `docs/research/fix-f-client-report.md` as you go. It should cover:

- per commit: the hash, what changed, and the red-first evidence;
- the cause of the lava float;
- the catch-up numbers (before and after: ticks/s, time to live for a given backlog);
- what you couldn't verify;
- "Architectural decisions for review": the catch-up threshold and pause, hidden-tab behaviour, the per-liquid
  controller table, and what happens to old Creative rooms. For each: what you chose, the alternatives, why,
  and what it costs later.
- FUTURE.md ideas, suggested only.
