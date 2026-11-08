# HB: a scripted boss win in a real room

## HB2 update (careful bot): still no Victory; the limit is ammunition, not only dodging
**Step 1, what kills them** (new damage-cause readout in `tests/soak/boss-win.ts`, fed by the read-only `__evLog` of Explode events and the boss HUD; two runs of the old script at 14 to 30 cells, Fire+Bomb):
| run | Ana | Bo |
|---|---|---|
| 1 | contact (boss within 16 cells) 23, bolt/lava/other 6 | bolt/lava/other 76, contact 3, own Bomb 2 |
| 2 | contact 22, own Bomb 21, other 13, another player's Bomb 1 | bolt/lava/other 73, contact 2, own Bomb 1 |
The lead (a player's own Bomb hurts them) is **partly true but minor**: 21 of about 200 hp in one run, 1 to 2 in the others. The bulk is the boss's Fire bolts (20 each, one a second) plus contact (the boss closes to 14 cells and shoves for 20). The supply tour itself costs 24 to 43 hp per player (bolts while grabbing pickups at the start). "bolt/lava/other" lumps Fire bolt and lava ring together; the sim does not give a damage event, only deaths.

**What the bot does now**: starts the fight at 40 to 45 cells (beyond contact; Bombs only from 30+ cells, aimed with the boss's own lob formula), the two players on opposite sides of the boss, and hops to a random new distance (at least 6 cells from the last) every 250 to 400 ms so the aimed bolt misses. Supply tour shortened to 8 visits. Bomb and Fire both used.
**Runs** (boss hp left / time of fight / damage taken): dist 40 hop 400 ms 295 (9.2 s); 60/300 ms 680; 75/300 ms 560 (11.3 s); 40/300 ms 145 (9.8 s, best); 45/250 ms: 337, 395, 299 (8.4 to 9.4 s). Players still die after 8 to 11 s; all three 45-cell runs had the boss at 300 to 400 of 800. Own Bomb damage is now 0 to 1; the remaining damage is bolts (about 54 to 96 per player), plus the boss's own Bomb lob in phase 2.
**Why it does not win**: the supply pile holds only 4 Fire and 2 Bomb pickups, shared by two players (each ends with 10 to 30 Fire charges, 0 to 15 Bomb). A Fire hit is 20, so all 40 Fire charges at 100% accuracy are exactly 800 hp; with misses the pile **cannot** kill the boss, and Blast does 8 per 90 ticks. The script reaches 400 to 650 damage before it dies or runs dry. Victory needs ammunition beyond the pile (bags from dead players, other spells, imps' heals) or a player surviving longer. Not reached in ~45 tool calls; screenshots not taken for a win.
**Balance reading (report only)**: for two careful players, 800 hp looks **too much for the supply as stocked**: the stocked damage is about the boss's hp even with perfect aim. Either raise the pile (e.g. 6 Fire, 3 Bomb) or lower hp toward 600, or let players bring ammunition from the level. The user decides after playing.
**Architectural decisions for review (HB2)**: `window.__evLog` (client/room.ts, fed by the worker's `evlog` field on the `players` message) holds Explode, Death and my Knock events, capped at 400, for the soak script. It is read-only (nothing reads it back, invariant 9) and cheap in production (one small array per 33 ms post), but it does exist in production builds; if that is unwanted, gate it on the dev-teleport flag later.

---

**Outcome: the plumbing works; the script does not yet win.** In every run (about 12) the two players died after
taking 220 to 330 hp off the boss (800 hp), so the "Victory" checks never ran true. Findings below are measured, not
guessed. `pnpm soak:boss-win` exits 1 and prints which checks failed.

## What changed
- `server/devteleport.ts`: `SIMULTA_DEV_TELEPORT=1` (or `startServer({ devTeleport: true })`) lets `World.acceptPos`
  accept a Pos of any distance and re-baseline it (`PosBaselines.force`). `NODE_ENV=production` or any `FLY_APP_NAME`
  refuses it and logs `dev.teleport_refused` (warn). `dev.teleport` is logged through `log.limited`, once per member per minute.
- `GET /api/rooms/:code` adds `devTeleport: true` only when the flag is on. The client reads it in `resolveRoomTarget`
  and then defines `__devGoto(spell)` and `__devGotoEnemy(kind, dist)` in the real-room path; the worker teleports its
  controller and the normal Pos path reports it. `__boss` (read-only HUD data) is exposed for the script's aim.
- `tests/net/dev-teleport.test.ts` (5 tests, shown red against the old `world.ts`): off by default, on with the flag,
  refused under production env and under `FLY_APP_NAME`.
- `tests/soak/boss-win.ts`, `pnpm soak:boss-win` (env `KIT`, `TELE_DIST`, `TELE_EVERY_S`, `OUT`, `SHOTS`, `HEADED`).

## Runs (S Survival room, two Chromium pages, Fire+Bomb from the supply pile, real pointer casts)
| run | fight length | boss hp left | min hp Ana / Bo | hash_fail |
|---|---|---|---|---|
| 1 | 4.9 s | 531 | 0 / 0 | 0 |
| 2 | 6.3 s | 748 | 0 / 0 | 0 |
| 3 (earlier tuning) | 7.4 s | 520 | 0 / 0 | 0 |
Other tunings (distance 20 to 90 cells, Fire only, Bomb only) ended the same way: both dead in 3 to 8 s, boss at 520 to 800.
Teleports and Pos jumps raised no `pos.rejected` and no desync; the hash counters stayed 0 throughout.

## Balance reading (propose only; nothing changed)
Under this script the boss is **not beatable**, but the script is crude: it teleports to a spot in the boss's aggro
range (the arena has lava and the boss fires every second) and holds a button. It tells us the boss is lethal to
players who stand still at 14 to 30 cells: two full-health players last about 5 s. A real party dodges and uses heals
(none dropped before the boss dies; the boss drops one only on death). I would not touch 800 hp on this evidence.
Better evidence needs the script to dodge (move off the boss's line) and to bring all 12 supply spells. Proposal: first
fix the script, then judge; if a competent human-like script still cannot kill it, try 600 hp.

## Unfinished
- No run reached Victory; the win banner, toast, list removal and `round.end` result win are unchecked in a real room
  (`docs/art/shots/boss-win-attempt-party-fell.png` is the loss banner from the same path; `round.end` loss was logged).
- A smarter fight bot (dodging, healing) is the remaining work.

## Architectural decisions for review
- **Gate**: a server option read once at boot from env, refused when `NODE_ENV=production` or `FLY_APP_NAME` is set.
  Alternatives: per-room flag chosen at creation (more precise, but the creation API is public); a build-time define
  (cannot be flipped for a soak without a rebuild). Cost: the flag is process-wide, so every room on a flagged server is open to teleports.
- **Where the client learns it**: the HTTP room route, not WELCOME (a protocol bump). Cost: the client trusts the
  field only to expose a hook; the server still decides every Pos, so a forged flag gains nothing.
- **Why it can't reach production**: Fly sets `FLY_APP_NAME`, the Dockerfile sets `NODE_ENV`; either refuses the flag
  and the route never emits the field.
- Worker's `devgoto` now accepts `remote` from any page, but without the server flag the Pos is rejected and
  logged as `pos.rejected`, same as any cheat.

## FUTURE.md ideas
A dodging fight bot reusable for balance runs; a `/api/dev` snapshot of boss hp for scripts instead of reading the HUD.
