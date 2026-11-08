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
