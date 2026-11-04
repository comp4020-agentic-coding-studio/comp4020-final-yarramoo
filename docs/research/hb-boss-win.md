# HB: a scripted boss win in a real room

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
