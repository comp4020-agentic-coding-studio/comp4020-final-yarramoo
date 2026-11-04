# HM live: the menu with a live-room backdrop

## What was built
- `GET /api/rooms` now returns `players` per room (connected non-spectator members of the loaded world, 0 if unloaded), sorted by players then `last_active`. Net test `tests/net/menu-live-counts.test.ts`, shown red first.
- `GET /api/rooms/:code/preview` (new, `server/main.ts`): the latest verified snapshot of a public, loaded room as plain HTTP bytes (config in `x-room-config`). 404 if there is none.
- `client/menu-preview.ts`: a full-bleed canvas behind the menu using the game's own `Renderer` and its own private `sim.wasm` instance on the main thread. Muted (no sfx import), no input, canvas has `pointer-events: none`. Fades in after first paint (`setTimeout 0`, then wasm fetch). Paused on hidden tab; reduced motion draws one still frame after 20 s of warm-up steps; touch uses 30 steps/s and the 3x scale. Panels got `backdrop-filter` blur over translucent fills; the room list shows "N playing".
- Fallback scene (no occupied public room): a rock-built scene with sand, water, lava, oil and fire emitters pushed as Paint inputs, restarting every 45 s.

## The room view is NOT live (flag)
No pure spectator connection exists: `HELLO_SPECTATE` only works for game worlds, still joins as a member (counts in `playerCount`, capacity, receives the whole log, can hold the clock). Using it from the menu would make every visitor a member. I stopped there and took the cheapest honest option: render the room's latest stored snapshot, stepped locally (no inputs), re-fetched every 45 s. It is a plausible frozen-then-evolving copy of that room, not what its players see now. Cost: the view diverges between refreshes (no players, no enemies, stepped without their inputs).
Not a player: HTTP only, so not in Who, not in ready-up or `playerCount`, sends nothing, cannot keep a room loaded (the route reads `worlds` and never loads).

## Commits
See `git log menu-live` (server+test, preview+styles, report).

## Measurements (production build served by the real server on 8102; headless Chromium, swiftshader GL, noisy; the first run overlapped a test suite)
| | first paint of menu | preview on and moving |
|---|---|---|
| 1280x800 | ~4.8 s | ~4.9 s |
| 390x844, 4x CPU | ~1.6 s | ~4.5 s |
First paint is slow on the laptop run only because swiftshader and the machine were busy; treat as an upper bound.
Bytes the menu now loads: JS 74.3 kB (index chunk; the worker chunk is not loaded on the menu), wasm 215.8 kB (previously 0 on the menu). Catch-up: no log replay; the preview shows a frame as soon as the snapshot (5 kB for a fresh Caves S room, MBs for a long-lived one) is fetched and decompressed. Server cost per visitor: one small HTTP read per 45 s while the menu is open, plus the 5 s room-list poll; no socket, no world state.

## Architectural decisions for review
1. **Preview sim on the main thread, not the worker.** Alternative: reuse `worker.ts` local mode (needs a canvas transfer and a new message type). Chosen to avoid touching the worker. Cost: sim steps compete with menu UI at 4x throttle; move into the worker later if jank shows.
2. **Snapshot over HTTP instead of a spectator socket.** Alternative: a real read-only spectator in the protocol (new HELLO flag, excluded from `playerCount`, Who, log replay from the snapshot only). Cost of mine: not live. Cost of the alternative: protocol change, needs the sim hash check and a server cap.
3. **`/preview` serves public rooms only and only when loaded**, so it cannot be used to enumerate or load rooms.
4. **`z-index` layering**: canvas is `z-index 0`, `.menu` is `z-index 1` (a negative index hid it behind the body background).

## Not done / next
- Not measured: the room view at 4x with a large (L) snapshot; room-view screenshot is `menu-live-room.png`. Panel readability was checked by eye on caves, not over every material.
- Did not run `test:determinism` (nothing in `sim/`, `shared/` or the input path changed).
- FUTURE.md ideas: a true read-only spectator connection; the preview following the room's real tick via the log tail; click-through "watch this room" from the backdrop.
