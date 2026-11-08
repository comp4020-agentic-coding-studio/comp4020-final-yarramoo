# Sound worker report (branch `sound`)

W0 spend: 386.49.

## Red-first evidence (commit 1)
Stub `sound-cues.ts` (all helpers wrong) gave 13 failing tests, e.g.:
- `hurtCause > explosions`: `AssertionError: expected null to be 42`
- `damageSound`: `expected 'hurt' to be 'sizzle'`
- `rate limit`: `expected true to be false`
- `SPELL_SFX`: `expected +0 to be 15`
- `waterMotion > still water reads 0` (stub returned level 1), plus the other four water tests. Note: with the stub, "falling mass > 0" passes trivially (stub returns 1), only "more water higher", "farther lower", "camera moving 0" and "drip 0" and "still 0" were red.
Log: /tmp/sound-unit.log (green after implementation, 17/17).

## Architectural decisions for review
- `hitboxMaterials` replaces the loop in hazard.ts; `hitboxTouchesLava` kept as a wrapper.
- `waterMotion` samples a world-aligned grid, returns `next` samples to feed back; `WATER_FLOOR=8`, `WATER_SCALE=80` weighted samples (tunable, untested in a browser until stage C).

## What was built
- `client/sound-cues.ts` (hurtCause, damageSound, hurtClass/shouldPlayHurt, SPELL_SFX x15, waterMotion); `hitboxMaterials` in hazard.ts (`hitboxTouchesLava` kept).
- `sfx.ts`: 14 hurt recipes + 5 cast recipes, `play()` request counter, `setWater` (one looping bandpass voice with a slow LFO, eased gain, stopped after 4 s of silence, not in MAX_VOICES), `sfxCounts`.
- `worker.ts`: hurt-by-cause replaces the lava-only sizzle (dev log k:900 kept for lava, `sfxBudget` trick kept); death plays `damageSound(e.b)` beside `death`; `ambientWater` every 200 ms; `cfg=creative`. `room.ts`: `ambient` case, `__sfxCounts`, creative flag. `protocol.ts`: `ambient` message.
- Falling rock: no sim damage to players, so no hurt cue (as briefed).
- Commits: 0f133f8, 826fc3f, 2415f40 (commits 3 and 4 of the checklist are one commit; worker.ts edits interleaved), plus this report.

## Verification
Unit: 17/17 (`/tmp/sound-unit.log`), typecheck clean (`/tmp/sound-tsc.log`). Red-first above. Full gate not run.
Browser (own vite :5181, session `sound`, counts via `__sfxCounts()`):
- Damage on (`/game?world=game&avatar=1`): fire on self -> `burn` (health 100->96); acid -> `corrode` x3 (->87); lava -> `sizzle` x1 (->79); gunpowder + spark -> explosion killed me: `explode` 29 (map ticks), `death`, `respawn`, and the death cause was fire so `burn` rose 2->3 (cause on EV_DEATH was fire; no `powderhit` seen: the lethal event is the death-cause path, not a non-lethal hurt). Not shown: `powderhit`, `blasthit`, `bolthit` non-lethal.
- Enemies are off in that world; with `&cfg=survival&seed=3`: slime contact -> `slimehit` 9 (health 100->28); imp: death -> `death` + `imphit` (killed; bolt `crackle` 1). Acid slime and worm not reached (I was dead after the imp: one-life survival). Not exercised in browser: acidhit, wormbite, magehit, wisphit, frosthit, colossushit, blasthit, bolthit, powderhit (unit-tested only).
- `cfg=creative`: all 15 slots cast, names in order: push, blast, dig, water, rose, fire, bomb, acidflask, flask, wall, lavaflask, hole, freeze, quake, mudslide (counts above show each exactly once; slot 1 `push` also fires on page start). Note the creative bar's slot order is not spell id order (Dig is slot 3).
- Water: painted radius 14 water 20 cells above me: `water` 0.62 at t+1 s, peaked 0.973, decayed to 0 by t+6 s and stayed 0 for 6 more s. The peak at page start was 0.07 (the world settling at spawn); the still lake read 0 afterwards. Hearing the sounds was not possible (no ears); only requests/levels counted.
- Closed session `sound`, killed vite on :5181.

## Cut / not done
- Browser coverage of the remaining hurt names (above). A Bomb at feet and a bolt hit are worth a human ear/eye pass.
- Spectator ambient: spectators do hear it (camera centre); flagged below.

## Spend
W0 386.49; end about 387.94 (about $1.5).

## FUTURE
- Tune `WATER_FLOOR`/`WATER_SCALE`/filter by ear. Sound-level volume slider.

## Architectural decisions for review (additions)
- Lethal hits: the death cause sound plays on `EV_DEATH` only; the final non-lethal-style hurt branch skips dead players (`!dead`), so a killing blow plays `death` + cause sound, not also a hurt sound. Alternative: cue also on the killing frame; costs a double sound.
- Combat signal (music) now fires for every hurt cause except lava (previously every non-lava hurt): same rule, but also for `null` causes.
- Ambient runs inside `gameFrame` (so only avatar rooms, not the sandbox); spectators hear it from the camera centre. Reversible: pass `quiet` for spectate.
- Water voice is main-thread only, one chain; `ambient` message sent only on >0.02 change, so worst case 5 msgs/s.
- `sfxCounts` instrumentation is always on (a handful of integer increments); `__sfxCounts` is installed in every build, not just dev.
