# todo

The working list for the falling-sand build. `docs/plan.md` is the design,
`docs/DECISIONS.md` records why things changed, and `FUTURE.md` holds ideas
nobody has committed to. Items here are things that will be done; tick them
with the commit that did it.

Dates: crit 10 "Fly by instruments" Wed 21 Oct (live by Tue 20 Oct); final
submission noon Mon 9 Nov.

Overnight run, 13–14 Oct: aim to finish M4, keep going if budget allows, and
stop by $185 of the $200 weekly budget so about $15 is left for Wednesday
morning (crit 9 reflection). The budget resets Thu 15 Oct 9 am.

## Now

- [x] Deploy slice: old app to `deprecated/`, placeholder README, `/readme/`
      from the game server, multi-stage Dockerfile, `spec/game.test.ts`
      (`f94594d`..`b9a03db`). Checked on the real image: SIGTERM stop, restart
      on the same volume, world back at the same tick from snapshot + log.
- [x] Merged to `main` (`22ec30b`); CI check and deploy green. Painted on
      the live URL from a desktop browser and saw it in a phone-sized one.
- [ ] Check the live app survives an idle stop: leave it, come back, the
      world is still there.

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
- [x] Camera and scrolling; free-camera mode (`02eff5a`, `5ba65b6`); `?world=game` with `pnpm dev:client`.
- [x] Performance baseline: see the M3 report: native p95 3.9 ms at rest with sleeping, 14.0 ms without; Chromium p95 7.3 and 18.5 ms.

## Plants

- [ ] Randomise how a flower grows: the stem leans or branches, leaves sprout,
      heights and bloom shapes vary. All through the counter-based RNG, so
      every client grows the same flower.

## M4: avatars and the first spells (plan 6.6, 6.7, 8)

- [ ] Player entities, `Pos` inputs with `life`, avatar controller (walk,
      jump, levitate with limited energy), collision against the grid.
- [ ] Character animation: idle, walk, jump, levitate, cast and hit poses,
      facing left and right. Small pixel sprites, drawn by the renderer only;
      animation is cosmetic and never enters the sim.
- [ ] Push and Blast with knockback; pickups; Water and Rose seed spells; cast
      previews; HUD.
- [ ] Spell animation: a cast flash, projectile trails, impact bursts. Also
      cosmetic, also renderer-only.
- [ ] Touch: spectate the game world on phones (D-011).
- [ ] Gate G2: N1 (three clients, ten minutes, jitter, a throttled CPU, zero
      mismatches) and P1 (worst-case step time p95 ≤ 8 ms).

## Crit 10: fly by instruments (by Tue 20 Oct)

- [ ] Structured server logs: joins, leaves, desyncs, snapshots, rejects.
- [ ] Basic live dashboard at `/dashboard`: players online, tick rate,
      per-client lag and RTT, hash checks passed and failed, snapshot sizes,
      RSS against the 256 MB machine.

## Later (M5–M7)

- [ ] Deep caves: Fire bolt, Bomb, lava and gunpowder damage, death, respawn,
      last-hit kills.
- [ ] Achievements and the full dashboard history.
- [ ] Polish, soak tests, the final README and PROCESS rewrites (the user's).

## Owed

- [ ] D4: run the determinism page once on an ARM device (a phone).
- [ ] README argument with sources, and the PROCESS.md rewrite: the user
      writes these.
