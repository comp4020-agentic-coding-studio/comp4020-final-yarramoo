# HM local: the menu with a local sim behind it

## Built
- `client/menu-preview.ts`: a full-bleed canvas (`#previewBg`, fixed, behind the menu) driven by the game's own worker in `local` mode (sandbox, kind 0, no socket) and its own `Renderer`/palette, at a whole-number scale (smallest k that covers the viewport, 2+ on phones). The visible window is the bottom of the 512 world.
- A scripted director (50 ms timer) draws the scene as pointer messages (terrain strokes first, then emitters: sand onto a ledge, water falls, a lava pocket topped up, fire on wood, drains at the ends). The worker turns them into Paint inputs (invariant 1).
- Loop: after 80 visible seconds the canvas fades out, the worker is terminated and a fresh one starts (reset rather than snapshot restore).
- Panels (header, hero text, cards, room list, code box) are translucent with `backdrop-filter` blur. The preview starts after first paint (rAF then setTimeout) and fades in when the first `stats` message arrives. The canvas has `pointer-events: none`, so nothing reaches a room.
- Hidden tab pauses (worker `pace` message, paused draw and step, director idle). `prefers-reduced-motion`: scene forms for about 12 s then freezes on one frame. Phone (`isTouch`): 30 steps/s, scale >= 2, one emitter fewer.
- Worker additions (small, additive): `pace` message (`paused`, `stepMs`); `STEP_MS` is now `let`.

## Measurements (production build served by the real server, Playwright Chromium with SwiftShader GL, machine under load avg ~300 so absolute numbers are noisy)
| Run | first contentful paint | preview moving | bytes fetched |
|---|---|---|---|
| 1280x800, unthrottled (after a warm-up) | 3.4 s | 7.4 s | 283 KB |
| 390x844, 4x CPU | 5.4 s | 8.6 s | 302 KB |
FCP was the same machine-load dominated whether or not the preview exists (the preview starts after paint). Bundle: main JS 63.75 -> 67.18 kB (+3.4 kB), worker JS 66.15 -> 66.20 kB, sim.wasm 215,824 B (new: the menu now fetches it, about 216 KB raw; it was previously fetched only on entering a room, and is then cached).

## Screenshots
`docs/art/shots/menu-local-1280-a.png`, `menu-local-1280-b.png`, `menu-local-390.png`, `menu-local-namesheet.png`.

## Checked
Name sheet opens over the preview; panels stay readable over sand, water and lava at 1280 and 390. I did not click through create-room or room join (code untouched; only styles around them changed).

## Architectural decisions for review
- Preview uses a dedicated worker per menu visit, running the sandbox local mode. Alternative: share a worker with the room page (not possible, different pages), or a main-thread sim (costs the UI thread). Cost: a second wasm instance (about 20 MB memory for a 512 world) while on the menu.
- Reset by terminating the worker, not snapshot restore: simplest and robust, costs a 1 s cross-fade gap and a re-fetch of the (cached) wasm.
- `pace` message added to the worker protocol: additive; room pages never send it.
- Not a player: no network at all, so no Who entry, capacity or load on the server.

## Not done / next
- Not run: `pnpm test:determinism` (no `sim/`, `shared/` or input-path change; worker only gained a pause).
- Scene tuned with a few passes only; the water streams look like thin dotted columns at 1280 (scale 3 against drops of radius 2-3) and could be fatter or merged.
- FUTURE idea: pause the preview while a sheet is open, to save CPU.
