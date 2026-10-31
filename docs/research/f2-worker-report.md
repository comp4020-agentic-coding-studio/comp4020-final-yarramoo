# F2 worker report: materials and reactions

All six materials landed (Oil, Acid, Gas, Ice, Glass, Coal). Nothing skipped, except the items under "Could not verify".

## Commits (each gated on cargo test, clippy, typecheck, test:determinism; exit codes, not greps)
1. 483213a Oil (15). `Liquid` gained an `ok` displaceable-set; `water_ok` lets Water sink through Oil. Oil ignites 1 in 2 per fire neighbour. Tests `oil_floats_on_water`, `oil_burns_fast_and_spreads_fire`, each shown red (water_ok without OIL; OIL not flammable).
2. e563adb Acid (16). `update_acid`: at most one dilute or dissolve per cell per tick; aux = strength (12). Tests: eats rock and stops at bedrock, dilutes water; each shown red.
3. c96dd36 Gas (17). `update_marsh_gas`, never expires; Fire ignites it at 1 in 1 to a 6-tick flash fire. Tests: lingers under ceiling, flash-burns pocket; red shown. No dense-gas explosion (optional; skipped to keep it bounded).
4. ddd91ad Ice (18) and Glass (19). Fire melts ice (1 in 3), Lava (1 in 2); Lava turns adjacent Sand to Glass (1 in 10). Tests for fire melt, lava melt, capped slow freeze, sand to glass plus dig; each mutation shown red.
5. eb21940 Coal (20). Static solid; lit coal burns 240 ticks and sheds Fire/Smoke. Also: palette grew to 32 entries (`uPal[32]`, `PALETTE_SIZE`) and a gas shimmer shader branch landed in this commit by accident of timing (edited while the gate ran).
6. 5724512 Sleep coverage: `d7_new_materials_sleep_is_invisible`, `..._hash_every_tick`, `d7_ice_by_water_keeps_its_chunk_awake` (shown red with Ice's `vol_seen` removed). The broad scene did NOT catch that removal, so the targeted channel scene was added.
7. (next) Gen: oil pools (half layered on water), acid pools (deep band, 40 cells off the path), gas pockets, ice-lined chambers, coal seams. Tests `acid_stays_off_the_path_and_gen_materials_are_paintable` (red with the path check removed), `new_materials_keep_a_tick_within_bounds`.

Sandbox palette: new materials are in `MATERIALS` (client/materials.ts), names in shared/names.ts.

## Gen time (best of runs, native release) before and after
| size | before | after |
|---|---|---|
| S | 25 ms | 35 ms |
| M | 72-89 ms | 87 ms |
| L | 248-290 ms | 265 ms |
Open fraction unchanged (31-48% per seed; gas/oil/acid fill open cells so it is the same measure before materials).

## Counts per seed at L (size 2, seeds 1-8 in /tmp/f2-gen.txt)
Oil 773-3103, Acid 549-1602, Gas 1368-2052, Ice 111-244, Coal 3783-5861. At S (size 0) acid is 0 on 5 of 8 seeds, oil 0 on one: scale_count floors are low there. Acid on every L seed.

## Bounded work
`new_materials_keep_a_tick_within_bounds` (tests/sleep.rs): 300x470 sandbox packed with Acid, and with Gas plus Fire: acid 5.7 ms, gas+fire 5.4 ms per tick against 3.2 ms for water. Every rule reads at most four neighbours and moves at most once. Not shown red (a timing bound cannot be made to fail without a real regression).

## Could not verify
- No browser run: no gen-preview or /sandbox screenshots (`docs/art/shots/f2-*`), out of tool budget. Gas shimmer shader and colours are unseen.
- `pnpm test:net` not run.
- Colours chosen from the brief, not looked at; Ice vs Water contrast unchecked.
- Determinism suite (Node, Chromium, Firefox, WebKit) passed for commits 1-6 via `pnpm test:determinism`; for the gen commit see the gate result in the final reply.

## Architectural decisions for review
- **Material ids:** appended 15 Oil, 16 Acid, 17 Gas, 18 Ice, 19 Glass, 20 Coal. Existing ids unmoved. Cost: ids 15+ exceed the 4-bit assumption in comments about Paint (`mat` uses bit 7 for fill-empty; ids < 128 still fit, comments say "0-14" and are stale).
- **Aux use:** Acid = strength (0 fresh, then 12, down to 1 then vanish). Ice = freeze budget + 1 (0 fresh, 4 fresh-initialised, 1 spent; ice made by freezing is spent, so no chain). Coal = 0 unlit else ticks left (240). Gas, Oil, Glass: unused. Cost: any aux-reading code (render) must know these.
- **Liquid density:** Oil < Acid < Water, via per-liquid `ok` fn (Water displaces Oil and Acid; Acid displaces Oil). Alternative: numeric density table. Chosen: smallest change. Lava is not in the order (powders sink through it as before).
- **Freeze cap:** each fresh Ice cell freezes at most 3 water neighbours (1 in 20 per tick), the new ice is spent. A lake cannot freeze in a frame. Ice with budget beside Water sets `vol_seen` (volatile) so a chunk with it stays awake: this costs sleep savings for such chunks, and is needed for D7.
- **Coal:** a static solid, not a powder (flagged). Alternative powder: falls, burns as a pile. Static means veins stay put in rock; cost: no loose coal heaps in play.
- **Gas:** no density explosion; flash fire is 6-tick Fire spread at 1 in 1, via Fire cells (volatile).
- **Palette:** 32 entries (uPal[32], PALETTE_SIZE). Room for 11 more ids. Shader reads the material as an integer index; no other 16 assumption (grepped).
- **Dig:** Ice, Glass, Coal diggable in `Grid::dig` and (by default) `carve`.

## FUTURE.md ideas (suggested only)
- Dense-gas explosion via MAX_EXPLOSIONS_PER_TICK; acid hiss and ice crack sfx; oil-fuelled lamps; frozen-water bridges that melt.
