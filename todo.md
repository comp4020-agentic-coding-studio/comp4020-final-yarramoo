# todo

The working list for the falling-sand build. `docs/plan.md` is the design,
`docs/DECISIONS.md` records why things changed, and `FUTURE.md` holds ideas
nobody has committed to. Items here are things that will be done; tick them
with the commit that did it.

Dates: crit 10 "Fly by instruments" Wed 21 Oct (live by Tue 20 Oct); final
submission noon Mon 9 Nov.

## Overnight run, 18–19 Oct (the user approved this at 22:15 Sun)

**Stop line: $150 of $200** (the week resets Thu 22 Oct 9 am). Check
`/comp4020:balance` before each slice and stop starting new work past $145.
**No deploy and no merge to `main`.** All work stays on `multa`, pushed.

On anything that needs the user: take the more reversible option, record it in
`docs/DECISIONS.md`, add a line under "For the user to check" below, and keep
going. Gameplay-feel numbers get a sensible default the user can retune.

Queue, in order (each item: Sonnet workers in sequence, a review for anything on
the input path, snapshot format, protocol or ABI, the full gate per commit):

1. M5 slice 3: bags + snapshot format 3 (running at 22:15).
2. M5 slice 4: client (health bar, death toast, bag sprite, explosion and fire
   effects). Check it in two browser contexts.
3. M5 slice 5: cross-browser coverage that really produces deaths, bags, bombs.
4. M6 achievements: the server-counted ones from `player_stats` first, then
   kills and deaths by the plan 10 majority CLAIM (protocol bump, review).
   Toasts in game, a list on the admin dashboard.
5. Pause the world while a lone visitor catches up (`FUTURE.md`; protocol
   bump, review).
6. Social and spectate: a who's-online list with jump-camera-here, a minimap
   strip, distance-faded name tags. Client only.
7. World feel: biome tints and cave shapes by depth, the generator preview
   page. Changes the game world's generation, which is safe only while it is
   undeployed.
8. The 30-minute N1 soak (plan 13 M7, D12): three clients, jitter, one slowed
   CPU, zero mismatches, with M5's damage, bombs and bags in play. Reuse
   `tests/soak/` (G2's 10-minute harness). The plan requires it before
   submission; the last run predates M5.
9. Player page on the admin dashboard: sessions, play time, casts by spell,
   deepest point, deaths, kills, achievements, all from `player_stats`.
   Behind `ADMIN_TOKEN`.
10. Which chunk diverged: REQUEST_CHUNK_HASHES/CHUNK_HASHES (D-043), so a
    `desync` incident records the first diverging chunk. Protocol change,
    review.
11. Catch-up as a real progress bar, and render every Nth tick during
    fast-forward. Client only.
12. Art pass (the user asked, 23:30, if time and budget remain): improve the
    pixel animations and effects for players, spells and the environment.
    Sprites are hand-written 7x10 character grids in `client/fx.ts`, drawn
    one cell per world cell, so a generated image can't be dropped in. Use
    `/image-gen` for concept and reference art (palette, silhouettes, spell
    looks), save it under `docs/art/`, then hand-reduce it to grids. Image
    budget is separate ($6.90 of $30 spent). Client only and cosmetic, so no
    sim change. Check every change in the browser at 1x and 3x zoom.

### For the user to check (added overnight)

- **A live risk on `main`, fixed on `multa` only (D-112, `bbd5d73`).** On any
  deploy that changes the sim build, the live server resets the sandbox if
  checking its stored snapshot merely times out. A cold verify worker on the
  256 MB machine could do that. Not deployed overnight, per your rule. It ships
  with the merge, or as a small hotfix to `main` (like `2c70ceb`) if you want it
  sooner: your call.
- **M5 visuals not yet seen in a browser:** the bag sprite, the pickup flash, a
  bomb in flight, the Fire bolt trail, the screen shake and another player's
  health bar. The data behind them is proven: a Node run of the real wasm
  picked up Bomb and Fire bolt, threw both, died in lava, dropped a 13-charge
  bag, respawned and took it back (every event and entity record as the client
  reads them). The health bar, death overlay, toast, gunpowder explosion and
  phone layout were seen. Worth two minutes of your eyes in the game world.
- **A design limit in kill/death achievements (D-119):** with two players
  connected, one claim is a majority, so a single modified client could award
  itself `first_blood` or `five_kills`. This follows plan 10's own rule
  (`ceil(n/2)`). Options: accept it (co-op, light anti-cheat is the stated
  goal); require 2 votes whenever 2+ are connected, so a lone claim with two
  players present waits for the other; or only award claim achievements with 3+
  witnesses. Kept as planned until you choose.
- **`shoved_to_doom` was redefined (D-120):** the plan said "a kill whose last
  hit was Push or Blast", but a death records what killed you (lava, fire,
  gunpowder), not the last hit. Recording the last hit would change the sim
  and the save format. It now means "a credited kill where the environment
  finished them off", and the in-game description says exactly that.
- **Minimap taps on phones (D-123, `7ee9071`):** the strip is 22 px tall but
  maps its height to the world's whole depth, so a tap below the very top lands
  the camera deep in rock, and for a phone spectator it also stops following.
  Seen in a 375 px screenshot. Easy fixes if you agree: map the tap to the
  nearest player dot (and follow them, for a spectator), or keep the camera's
  depth and only move it sideways. Left as built until you've looked.

## Now

- [x] Deploy slice: old app to `deprecated/`, placeholder README, `/readme/`
      from the game server, multi-stage Dockerfile, `spec/game.test.ts`
      (`f94594d`..`b9a03db`). Checked on the real image: SIGTERM stop, restart
      on the same volume, world back at the same tick from snapshot + log.
- [x] Merged to `main` (`22ec30b`); CI check and deploy green. Painted on
      the live URL from a desktop browser and saw it in a phone-sized one.
- [x] Check the live app survives an idle stop (14 Oct): stopped about 2 h,
      woke on one request in 4.2 s, log `loaded: snapshot 2180280, 37573 logged
      ticks, resuming at tick 2217853`. The marker's next-day path, for real.

## M3: big world (plan 6.5, 6.9)

- [x] Research notes: `docs/research/noita-caves.md`.
- [x] Look at how Noita builds its caves before writing the generator. Its
      world is stitched from herringbone Wang tiles with hand-made pixel
      scenes dropped in; screenshots and the GDC talk on its tech show the
      look (wide connected caverns, layered biomes, pockets of liquid). Pick
      what fits an integer-only, deterministic generator and record it in
      `docs/DECISIONS.md`.
- [x] 2048 × 1536 game world (`f1529db`..`7eb0455`, tuned in the last M3 commit): surface heightmap, shallow and deep bands,
      3–5 cave entrances, water and lava pools, gunpowder pockets, pickup
      spots.
- [x] Active-chunk rule and chunk sleeping (`3f68c14`); D7 (`a104231`, `ab07e1a`). The active rule is all-chunks until M4 has players (D-053).
- [x] D8 (`3cff05c`): generation identical across Node and the three browsers;
      regenerated pristine chunks equal stored ones.
- [x] Pristine-chunk snapshots: already in the snapshot format; restore regenerates then overwrites (checked by D8: a tick-0 snapshot is under 100 bytes).
- [x] Camera and scrolling; free-camera mode (`a0d3ed5`, `7f73c5d`); `?world=game` with `pnpm dev:client`.
- [x] Performance baseline: see the M3 report: native p95 3.9 ms at rest with sleeping, 14.0 ms without; Chromium p95 7.3 and 18.5 ms.

### Generator follow-ups (from looking at the M3 overview, `/tmp/m3-shots/gen-c9b.png`)

- [x] (4a5aed1) Spread entrances across the whole surface width (all landed centre-right;
      the left third is reachable from above only by a long side tunnel).
- [x] Fewer, less parallel branches per entrance worm: 5 branches make a dense
      vertical tangle around x 700-1600.
- [x] Horizontal link worms run nearly straight across the world; shorten them
      and let them meander, so they read as caves, not corridors.

## Plants

- [x] (46c32bd) Randomise how a flower grows: the stem leans or branches, leaves sprout,
      heights and bloom shapes vary. All through the counter-based RNG, so
      every client grows the same flower.

## M4: avatars and the first spells (plan 6.6, 6.7, 8)

- [x] Slice M4a: player and pickup entities, active set from players,
      identity, two worlds, off-thread verify, Pos validation, avatar
      controller and figures (`74ca003`, `796636e`, `43a1cab`, `cc746dc`;
      D-062 to D-067). Next: slice 4b, spells.
- [x] Character animation (`377cb18`, `9520446`): idle, walk, jump, levitate, cast and hit poses,
      facing left and right. Small pixel sprites, drawn by the renderer only;
      animation is cosmetic and never enters the sim.
- [x] Push and Blast with knockback; Water and Rose seed spells; cast
      previews; HUD (`1bc6b0e`, `031f58a`, `9520446`; D-073 to D-077).
- [x] Spell animation (`377cb18`, `9520446`): a cast flash, projectile trails, impact bursts. Also
      cosmetic, also renderer-only.
- [x] Touch: spectate the game world on phones (D-011; built in M4a, `cc746dc`).
- [x] Gate G2 run (results under "Gate G2: decision needed" below): N1 (three clients, ten minutes, jitter, a throttled CPU, zero
      mismatches) and P1 (worst-case step time p95 ≤ 8 ms).
      Measured 2026-10-14 (`docs/research/g2-results.md`): N1 PASS (36506 ticks, 0
      incidents, 0 resyncs, same final hash). P1 FAIL: worst case p95 9.0 ms
      native, 36 ms at 4x; the flood keeps ~70 chunks awake. Plan 12.3 remedies 1
      and 2 apply; user to decide.

### Animation, to look at with fresh eyes

- [x] (bacce17) Zoom control added (1x/2x/3x; keys +/-/=, wheel, on-screen buttons); walk cycle checked zoomed and reads as walking. Character sprites are 5 x 10 cells, about 15 x 30 screen px at desktop
      size. The six poses and 4-frame walk cycle are in `client/fx.ts` and run
      (checked in code and by the idle head bob on screen), but they're too
      small to judge how they read. Worth a zoom control or larger sprites, and
      a human eye on whether the walk reads as walking.

### Gate G2: decision needed (see `docs/research/g2-results.md`)

- N1 PASSED: 3 browsers, 10 minutes, 20-150 ms jitter, one CPU slowed 4x,
  608 hash checks with zero mismatches, all live at the end (`5619477`).
- [x] P1 now PASSES native: profiling found rng draws on every resting water
      cell; skipping them (D-087, bit-identical) took worst-case p95 from 9.0
      to 4.8 ms native, 36 to 16 ms at 4x (`docs/research/g2-results.md`,
      "P1 after profiling"). Still open: 4x is 16 ms, so a slow phone is over
      budget; liquids every other tick would change gameplay and stays the
      user's call.

### Unresolved, for a fresh look (14 Oct)

- [x] (`5e417ed`, D-089) Not a restore bug: the test's cast period locked every
      snapshot onto a bolt-free phase. The join speed-up stays.
      The join speed-up (`4ad1435`, D-088: restores reuse the generated world,
      join path about 1170 ms -> 400 ms) is committed but NOT pushed. Its own
      checks pass: hit/miss/cold restores are bit-identical, compat DATA still
      restores the live sandbox exactly. But the M4b net test ("a third joins
      late with bolts in flight") fails 4/4 on it, against 2/3 on the commit
      before, so that test was already flaky. In my probe the cache keeps
      projectiles on a hit, a miss and a cold restore. Yet in the test, a late
      client's snapshot never had bolts in 20 rejoins over about 3 s, which is
      unexplained. Don't push `4ad1435` until it is.

## Crit 10: fly by instruments (by Tue 20 Oct)

Budgeted from next week's allowance (resets Thu 15 Oct 9 am); the user decided
on 14 Oct. Still open: whether it lands on `main` with the game world (merge
`multa`) or on its own on top of the live sandbox.

- [x] Structured server logs: joins, leaves, desyncs, snapshots, rejects
      (`9eecdab`..`33d3f1b`); names for every visitor, `player_stats`,
      `input.summary` (`b220c64`..`85e4459`, review `docs/research/review-crit10.md`).
- [ ] Before merging to `main`: build and boot the real Docker image (CI does
      not run on `multa`; review S1 was a boot failure only the image shows).
- [x] RTT, tick lag and client step time per connection; protocol v4
      (`fcb3b58`..`aeca628`).
- [x] Live `/dashboard`: public totals, admin detail and event feed behind
      `ADMIN_TOKEN` (`d088c4f`..`b24cfc6`).
- [x] Admin world reset, confirm-twice from the dashboard (`0ca9f5e`..`bec4938`,
      review `docs/research/review-crit10-reset.md`).
- [x] Admin token in `fly.toml` (D-098, `cf20f44`).
- [x] Live sandbox down 18 Oct (boot crash on a 130k+ tick log): hotfixed on
      `main` (`2c70ceb`) and `multa` (`10247e2`), D-099. World restored from the
      14 Oct snapshot; later paint lost. Snapshots verified again after deploy.
- [x] Stop the log outgrowing snapshots (D-100; `world.log_long` and `/dashboard` "log since snapshot" to watch; the first visitor must still stay through the catch-up, see FUTURE pause-on-join). Snapshots need a client connected for
      a full cycle (1800 ticks); short visits on a long log never get there, and
      each makes the next join slower. Options: request a snapshot as soon as a
      client finishes catching up, or when the log passes a size. Watch
      `/dashboard` "last snapshot" in the meantime.
- [ ] Merge `multa` to `main` (deploys; ask first). After: `fly logs` shows JSON
      lines, `/dashboard` shows no names, the sandbox world from before the
      merge is still there.
- [ ] Rewrite PROCESS.md for crit 10 (the user's).

## Later (M5–M7)

- [x] (M5, `e168df0`..`3a80398`, D-102..D-114) Deep caves: Fire bolt, Bomb, lava and gunpowder damage, death, respawn,
      last-hit kills.
- [ ] Achievements and the full dashboard history.
- [ ] Polish, soak tests, the final README and PROCESS rewrites (the user's).

## Owed

- [ ] D4: run the determinism page once on an ARM device (a phone).
- [ ] README argument with sources, and the PROCESS.md rewrite: the user
      writes these.
