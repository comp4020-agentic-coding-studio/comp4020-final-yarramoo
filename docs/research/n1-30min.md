# N1 30-minute soak (2026-10-19): PASS, but it did not exercise M5 combat

Harness: `tests/soak/n1.ts` at `8a5918d` (`pnpm build:client && DURATION_S=1800 OUT=docs/research/n1-30min.json pnpm soak:n1`). Raw JSON: `n1-30min.json`.

## Setup

Seed 20261014, 1800 s (1806 s actual), 108449 server ticks. Three Chromium clients, each loading the real server's page and WebSocket through its own delay proxy (20-150 ms wandering base latency, +/-10 ms jitter, ordered per direction). Client 2 is CPU-throttled 4x (CDP on the main thread, plus the worker's wasm `step` wrapped to take 4x as long, as in G2). The server is the real `startServer` on an ephemeral port (not 8080); the production `sim.wasm` (no Paint) in the game world.

## What the bots did

Bots use only the real client controls: A/D/space key events, digit keys to select a spell, pointer down/move/up on the canvas to cast with aim. New in this version: they read `window.__players`, `__spells` and `__view` (read-only), sweep the surface for a shaft, wander downwards once underground, cast any spell that has charges and no cooldown, and aim at the nearest live player about 60% of the time when one is within 150 cells. Counts come from the sim's own `events()` output, tapped in each page's worker (live ticks only, no client changes).

| | client 0 | client 1 | client 2 (throttled) |
|---|---|---|---|
| casts by spell (Push, Blast, Water, Rose, Fire, Bomb) | 436, 335, 76, 0, 0, 0 | 461, 355, 0, 0, 0, 0 | 453, 329, 48, 0, 0, 0 |
| deepest y reached | 609 | 239 | 609 |
| samples at y >= 800 | 0 | 0 | 0 |

Sim events seen live by every client (identical across all three): 19 EV_PICKUP, 3249 EV_CAST, **0 EV_DEATH, 0 EV_EXPLODE, 0 EV_BAG_PICKUP, 0 EV_RESPAWN**. Nobody died and nothing exploded.

## Sync results

- Hash checks: 1807 checkpoints, each reported by all three clients (read off the wire), 1807 agree, 0 mismatches. Server `hashPasses` 1807, `hashFails` 0.
- Resyncs 0 (all clients), reconnects 0, desync incidents 0, snapshots accepted 60, rejected 0, bad inputs 0.
- Final shared checkpoint tick 108420: all three hash `3bb4297de4c64516`.
- All three live at the end (48, 39 and 38 ticks behind the last closed tick). Lag over the run: max 41, 43 and 43 ticks, mean about 23 for all three. The throttled client no longer lags more than the others (G2: max 323 ticks); the 14 Oct run predates the catch-up and checkpoint changes, and I did not investigate why.
- Step p95: 0.6 ms (clients 0, 1), 2.5 ms (throttled). Host RSS 217 MB.
- All five harness criteria true.

## What this does and does not prove

Exercised: walking and levitating, shaft descent to the shallow band (y about 609), Push, Blast and Water casts, 19 Water pickups, hash and snapshot paths, joins, three-client playout with jitter and a slow client, for 108k ticks.

**Not exercised**: the deep band (no bot got below y 609, so no Fire bolt or Bomb pickups), damage, death, respawn, bags, explosions, EV_DEATH claims (M6, D-118 to D-121; the server logged none), and the catch-up hold (D-122; no client joined late). Rose seed was never cast. So this soak shows sync for the pre-M5 mechanics plus the M5/M6 code paths on idle (health, entity bytes, claims machinery quiet), not M5 combat itself. M5 determinism rests on the D-series suite and `tools/inputgen-m5.ts` scripts, not on this run. Closing the gap needs a bot that reaches y >= 800 (a long descent, or a dev-only teleport, which production forbids) or a fixed-seed script.

## Against G2's 10-minute run (`g2-results.md`)

| | G2 (10 min) | this (30 min) |
|---|---|---|
| ticks | 36506 | 108449 |
| hash checks, all agree | 608/608 | 1807/1807 |
| resyncs / incidents | 0 / 0 | 0 / 0 |
| snapshots | 20 | 60 |
| casts per client | about 270 | about 820-850 (all spells) |
| throttled max lag | 323 ticks | 43 ticks |
| deaths, explosions, bag pickups | not counted (none possible) | 0 (counted, none reached) |
