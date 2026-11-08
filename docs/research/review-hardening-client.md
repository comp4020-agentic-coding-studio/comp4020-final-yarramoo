# Hardening review: client (range 3110766..0099809, checkout /tmp/wt-review)

Read-only review of `client/` (room.ts, worker.ts, lockstep.ts, music.ts, avatar.ts, protocol.ts, index.html diff).
Nothing was built or run.

## F1 MUST-FIX: the round sting replays forever (music.ts stepMood vs room.ts updateMood)
- `client/room.ts:164-167` calls `setMood(moodState.mood)` on every `players` message (about 30 Hz, `worker.ts:692`).
  After a round ends, `stepMood` (`music.ts`, `if (s.sting) return s`) keeps `mood = "victory"` or `"defeat"` for good.
- `music.ts` `tick()` plans the one-bar sting, then a `setTimeout` sets `wanted = "menu"` and `switchMood("menu")`, so `engineMood = "menu"`.
- On the next `players` message `setMood("victory")` sees `mood !== engineMood` and calls `switchMood("victory")` again.
  Result: the sting restarts every bar (about 2.5 s victory, about 4.8 s defeat), cross-fading with menu, until the page is left.
  `roundOutcome` in room.ts is also never cleared, and `sting` is latched, so a second round in the same room never gets its own music.
- Why it matters: every survival round end leaves a looping jingle. Wrong display and audio, not a desync.
- Fix: make the sting one-shot in the pure layer: after the sting, `stepMood` returns `mood: "menu"` (or the depth mood) with `sting` cleared once a
  timestamp passes, and reset `roundOutcome` plus `moodState.sting` when a new round or lobby starts (`m.lobby` open or the round entity `a === 0`).
  Alternatively have the engine ignore `setMood` for a mood it has already played as a `once`.
- Test red first: unit test on stepMood: feed `round: "win"`, then several steps with `round: "win"` and later times; assert mood leaves "victory"
  after one bar. Plus an engine-level test with a fake clock: sting, timeout, then `setMood("victory")` must not call `switchMood`.
- Confidence: high on the logic by reading. Not run, not checked in a browser.

## F2 SHOULD-FIX: `activebox` debug hook and `__setSleep` are in the production build (room.ts:1242-1245)
- `window.__activeBox` and `?activebox=1` sit outside `import.meta.env.DEV`; the comment says "in every build". The brief requires dev hooks behind DEV.
- `__activeBox` only draws from entity positions, so there is no desync risk. `pushActiveBox` runs in the worker's gameFrame and
  `ACTIVE_W/ACTIVE_H/CHUNK` are hand-mirrored (`worker.ts:93-96`), so a tuning change gives a wrong overlay (a net test is claimed to pin them; not checked).
- `__setSleep` (pre-existing, also outside DEV) only affects `localSim`, which is null in production, so harmless.
- Fix: wrap both in `if (import.meta.env.DEV)`, or record the "every build" choice in DECISIONS. Test: a build-output grep for `__activeBox`.
- Confidence: high that it is outside DEV; low impact.

## F3 SHOULD-FIX: tab-hidden state is not reasserted after a worker or room restart, and `hidden` is send-on-change only (room.ts:497-501)
- The `visibilitychange` handler sends `hidden` only on a change. `tabHidden` in the worker defaults to false. If the worker is recreated
  while the tab is hidden (reconnect creating a new worker, room switch, not checked), the new worker thinks the tab is visible and sends Pos and casts
  from a background tab. Worst case is a stale avatar walking around, not a desync.
- Fix: send `hidden: document.hidden` once after the worker starts (when `start` is posted). Test: browser test that loads the page in a hidden context.
- Confidence: medium. I did not trace how many times the worker is created per page.

## F4 SHOULD-FIX: catch-up trigger can fire on legitimate lag and drops the avatar (lockstep.ts driveFrame, worker.ts:1029-1050)
- Any live client with `buffered > 120` (2 s) re-enters "catching-up" with `catchUpTarget = received`. Targets are set to the tick received
  so far, so the replay keeps moving the target only once. This is the intended design. However `gameFrame` (avatar stepping, Pos) only runs when
  `net === "live"`, so after a long main-thread stall the avatar freezes during the fast-forward, and `sendLive()` is re-sent. That matches the stated intent.
- Risk: `reactToTick` uses `tick <= ls.catchUpTarget` to suppress hash/snapshot reaction. After `entered`, ticks up to the target do not report HASH,
  which is fine, but check that the server does not read a gap in HASH from a client as a desync (server not read by me). Not verified.
- Confidence: low. Listed so the server reviewer can cross-check.

## F5 NOTE: per-frame allocation and minor inefficiency
- `stepMood` allocates a new state object (spread) on every players message (30 Hz); `updateMood` also calls `performance.now()`. Negligible.
- `postTerrain` allocates a 6 kB mask and `createImageData` once a second, about 98k reads. Fine. The mask is sampled even in sandbox rooms where the minimap is hidden (`worldKind !== 1`): skip it there.
- `pushActiveBox` runs `centres.some` for up to 5 neighbours per visible chunk; debug only.

## F6 NOTE: heal event position inconsistency (worker.ts, EV_HEAL branch)
- The burst uses `e.c - 1` and the remote sfx uses `e.c + 0.5`: different anchors for one event. Cosmetic.

## Read and found sound
- Digit slots (`digitSlot`): `e.code`-based, Shift+1..9 map to slots 11..18 and are bounded by `slot < BAR.length`; Ctrl/Meta/Alt excluded; `-`/`=` untouched.
- Slot `pointerdown` stops propagation, and calls `pickSlot` only if `castsOnClick()`.
- Stage padding for the spell bar: `layout()` subtracts padding and the ResizeObserver observes the stage content box, so toggling `has-bar` and `has-mini` re-lays out.
- `visibilitychange` clears held keys and sends Keys, so no stuck movement on return.
- `driveFrame`: the catching-up path, the `acc` resets and the `sendLive()` on exit match the old behaviour; `received` is now public and read-only for the driver.
- Minimap silhouette uses `MATERIAL_CLASS` (shared table); the terrain message transfers its buffer; stale terrain refreshes each second after a resync.
- Music: separate gain from sfx; voices capped by `MAX_MUSIC_VOICES` and `planBar` enforces the overlap cap; no sim reads or writes (invariants 1 and 9 hold).
  The engine's `setInterval` is never cleared, but `startMusic` is idempotent. No leak per room as `running` guards it.
- Active-box constants equal `sim/src/tuning.rs` (576x320) and CHUNK 64 at this commit.
- `tabHidden` stops Pos and casts only (no Leave), outputs are not fed back into inputs (the terrain, rgb and heal data are display only).
- Dev hooks `__devPaint`, `__devMe` and the dev route are under `import.meta.env.DEV`.

## Not checked
- sfx.ts, fx.ts pushHeal, spells.ts, menu.ts, materials.ts, avatar liquid feel (floating-point is allowed in the client; I only skimmed the diff).
- Browser behaviour of any of the above, and the second-round flow in the real survival lobby.

## Architectural decisions for review
None.

## Session model's resolution (4 Nov)

- **F1 (the round sting loops): fixed.** `moodToSwitch` in `client/music.ts` refuses a sting that has already
  played its bar, and `setMood` keeps the calm fallback as `wanted` so music off/on doesn't replay it. A test in
  `tests/net/music.test.ts` was red on the old rule. The second-round case (a fresh room) gets a fresh page, so the
  module state starts clear.
- **F2 (`__activeBox` outside the DEV guard): kept on purpose.** The overlay was made available in every build
  (`1d14ec6`) to diagnose live rooms; it only draws from entity positions every client has.
- **F3 (a room opened in a background tab): fixed.** `room.ts` tells the worker `hidden: true` at start when
  `document.hidden`.
- **F4, F5: notes, no change.**
